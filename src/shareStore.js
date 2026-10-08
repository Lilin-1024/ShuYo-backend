import crypto from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dateKey } from './engagementStore.js';

const CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LIFETIME_MS = 14 * 86400000;
const MAX_DAILY_CREATIONS = 4;
const MAX_SNAPSHOT_BYTES = 128 * 1024;

function cleanText(value, max, required = false) {
  if (typeof value !== 'string') throw new Error('课表字段格式无效。');
  const result = value.normalize('NFC').trim();
  if (result.length > max || (required && !result)) throw new Error('课表字段长度无效。');
  return result;
}

function numberList(value, min, max, required = false) {
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error('课表周次或节次无效。');
  const numbers = [...new Set(value)];
  if (numbers.some((n) => !Number.isInteger(n) || n < min || n > max)) {
    throw new Error('课表周次或节次无效。');
  }
  return numbers.sort((a, b) => a - b);
}

function canonicalSnapshot(input, includeNote) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('课表格式无效。');
  const term = input.term;
  if (!term || typeof term !== 'object' || Array.isArray(term)) throw new Error('学期信息无效。');
  const sessions = input.sessions;
  const untimedCourses = input.untimedCourses;
  if (!Array.isArray(sessions) || sessions.length > 300 ||
      !Array.isArray(untimedCourses) || untimedCourses.length > 100) {
    throw new Error('课程数量超出限制。');
  }
  const result = {
    version: 1,
    term: {
      yearCode: cleanText(term.yearCode, 24, true),
      termCode: cleanText(term.termCode, 24, true),
      academicYearName: cleanText(term.academicYearName ?? '', 48),
      termName: cleanText(term.termName ?? '', 32)
    },
    sessions: sessions.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('课程格式无效。');
      return {
        courseName: cleanText(item.courseName, 120, true),
        teacherName: cleanText(item.teacherName ?? '', 120),
        campus: cleanText(item.campus ?? '', 120),
        location: cleanText(item.location ?? '', 120),
        credit: cleanText(item.credit ?? '', 32),
        weekday: Number(item.weekday),
        sections: numberList(item.sections, 1, 16, true),
        weeks: numberList(item.weeks, 1, 32),
        ...(includeNote ? { note: cleanText(item.note ?? '', 500) } : {})
      };
    }),
    untimedCourses: untimedCourses.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('课程格式无效。');
      return {
        courseName: cleanText(item.courseName, 120, true),
        teacherName: cleanText(item.teacherName ?? '', 120),
        campus: cleanText(item.campus ?? '', 120),
        credit: cleanText(item.credit ?? '', 32),
        weeks: numberList(item.weeks, 1, 32),
        summary: cleanText(item.summary ?? '', 500)
      };
    })
  };
  if (result.sessions.some((item) => item.weekday < 1 || item.weekday > 7 ||
      !Number.isInteger(item.weekday))) throw new Error('课程星期无效。');
  result.sessions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  result.untimedCourses.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('课表大小超出限制。');
  return { json, digest: crypto.createHash('sha256').update(json).digest('hex'), snapshot: result };
}

class ShareStore {
  constructor({ filename, encryptionKey }) {
    if (typeof encryptionKey !== 'string' || !/^[0-9a-f]{64}$/i.test(encryptionKey)) {
      throw new Error('SHARE_DATA_KEY must be a 32-byte hexadecimal secret');
    }
    this.key = Buffer.from(encryptionKey, 'hex');
    this.lookupKey = crypto.createHmac('sha256', this.key)
      .update('share-code-lookup-v1').digest();
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON');
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > 1) throw new Error(`Unsupported share database version: ${version}`);
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE shares (
        owner_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL UNIQUE,
        code_cipher BLOB NOT NULL, snapshot_cipher BLOB NOT NULL,
        digest TEXT NOT NULL, term_label TEXT NOT NULL, include_note INTEGER NOT NULL,
        byte_size INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE share_daily (
        owner_id TEXT NOT NULL, day TEXT NOT NULL, creations INTEGER NOT NULL,
        PRIMARY KEY(owner_id, day)
      ) STRICT;
      CREATE TABLE share_requests (
        owner_id TEXT NOT NULL, request_id TEXT NOT NULL, share_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(owner_id, request_id)
      ) STRICT;
      CREATE TABLE retired_codes (
        code_hash TEXT PRIMARY KEY, retired_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  seal(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  }

  open(blob) {
    const data = Buffer.from(blob);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8');
  }

  hashCode(code) {
    return crypto.createHmac('sha256', this.lookupKey).update(code).digest('hex');
  }

  publicOwnerShare(row) {
    if (!row) return null;
    return {
      id: row.id, code: this.open(row.code_cipher), digest: row.digest,
      termLabel: row.term_label, includeNote: Boolean(row.include_note),
      createdAt: row.created_at, expiresAt: row.expires_at
    };
  }

  current(ownerId, now = new Date()) {
    return this.publicOwnerShare(this.db.prepare('SELECT * FROM shares WHERE owner_id = ? AND expires_at > ?')
      .get(ownerId, now.toISOString()));
  }

  create(ownerId, requestId, input, includeNote = false, now = new Date()) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) {
      throw new Error('请求标识无效。');
    }
    const { json, digest, snapshot } = canonicalSnapshot(input, includeNote);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT share_id FROM share_requests WHERE owner_id = ? AND request_id = ?')
        .get(ownerId, requestId);
      if (previous) {
        const current = this.current(ownerId, now);
        return current?.id === previous.share_id ? { ...current, reusedRequest: true } : { error: 'superseded' };
      }
      const day = dateKey(now);
      const used = this.db.prepare('SELECT creations FROM share_daily WHERE owner_id = ? AND day = ?')
        .get(ownerId, day)?.creations ?? 0;
      if (used >= MAX_DAILY_CREATIONS) return { error: 'daily_limit' };
      let code;
      let codeHash;
      do {
        code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
        codeHash = this.hashCode(code);
      } while (this.db.prepare('SELECT 1 FROM shares WHERE code_hash = ?').get(codeHash) ||
        this.db.prepare('SELECT 1 FROM retired_codes WHERE code_hash = ?').get(codeHash));
      const id = crypto.randomUUID();
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + LIFETIME_MS).toISOString();
      this.retire(ownerId, now);
      this.db.prepare(`INSERT INTO shares
        (owner_id, id, code_hash, code_cipher, snapshot_cipher, digest, term_label,
         include_note, byte_size, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ownerId, id, codeHash, this.seal(code), this.seal(json), digest,
          `${snapshot.term.academicYearName || snapshot.term.yearCode} ${snapshot.term.termName || snapshot.term.termCode}`.trim(),
          Number(includeNote), Buffer.byteLength(json, 'utf8'), createdAt, expiresAt);
      this.db.prepare(`INSERT INTO share_daily(owner_id, day, creations) VALUES (?, ?, 1)
        ON CONFLICT(owner_id, day) DO UPDATE SET creations = creations + 1`).run(ownerId, day);
      this.db.prepare('INSERT INTO share_requests(owner_id, request_id, share_id, created_at) VALUES (?, ?, ?, ?)')
        .run(ownerId, requestId, id, createdAt);
      return { ...this.current(ownerId, now), reusedRequest: false };
    });
  }

  resolve(code, now = new Date()) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{6}$/.test(code)) return null;
    const hash = this.hashCode(code);
    const row = this.db.prepare('SELECT snapshot_cipher, digest, expires_at FROM shares WHERE code_hash = ? AND expires_at > ?')
      .get(hash, now.toISOString());
    if (!row) return null;
    return { snapshot: JSON.parse(this.open(row.snapshot_cipher)), digest: row.digest, expiresAt: row.expires_at };
  }

  retire(ownerId, now = new Date()) {
    const old = this.db.prepare('SELECT code_hash FROM shares WHERE owner_id = ?').get(ownerId);
    if (!old) return false;
    this.db.prepare('INSERT OR IGNORE INTO retired_codes(code_hash, retired_at) VALUES (?, ?)')
      .run(old.code_hash, now.toISOString());
    this.db.prepare('DELETE FROM shares WHERE owner_id = ?').run(ownerId);
    return true;
  }

  destroy(ownerId) {
    return this.transaction(() => this.retire(ownerId));
  }

  deleteAccount(ownerId) {
    this.transaction(() => {
      this.retire(ownerId);
      this.db.prepare('DELETE FROM share_daily WHERE owner_id = ?').run(ownerId);
      this.db.prepare('DELETE FROM share_requests WHERE owner_id = ?').run(ownerId);
    });
  }

  cleanup(now = new Date()) {
    const before = new Date(now.getTime() - 7 * 86400000).toISOString();
    const oldDay = dateKey(new Date(now.getTime() - 7 * 86400000));
    this.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO retired_codes(code_hash, retired_at)
        SELECT code_hash, ? FROM shares WHERE expires_at <= ?`)
        .run(now.toISOString(), now.toISOString());
      this.db.prepare('DELETE FROM shares WHERE expires_at <= ?').run(now.toISOString());
      this.db.prepare('DELETE FROM share_requests WHERE created_at < ?').run(before);
      this.db.prepare('DELETE FROM share_daily WHERE day < ?').run(oldDay);
      this.db.prepare('DELETE FROM retired_codes WHERE retired_at < ?')
        .run(new Date(now.getTime() - 30 * 86400000).toISOString());
    });
  }

  close() { this.db.close(); }
}

export { ShareStore, canonicalSnapshot, LIFETIME_MS, MAX_DAILY_CREATIONS };
