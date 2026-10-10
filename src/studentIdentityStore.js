import crypto from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { maskedStudentId } from './identityProbe.js';

const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 10;
const DELETION_GRANT_LIFETIME_MS = 5 * 60 * 1000;

function decodeSecret(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${name} must be a 32-byte hexadecimal secret`);
  }
  return Buffer.from(value, 'hex');
}

function normalizedStudentId(value) {
  const id = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,24}$/.test(id)) throw new Error('Invalid verified student ID');
  return id;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class StudentIdentityStore {
  constructor({ filename, hmacSecret, encryptionKey }) {
    this.hmacSecret = decodeSecret(hmacSecret, 'STUDENT_ID_HMAC_SECRET');
    this.encryptionKey = decodeSecret(encryptionKey, 'STUDENT_ID_ENCRYPTION_KEY');
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > 2) throw new Error(`Unsupported student database version: ${version}`);
    if (version === 0) this.initializeSchema();
    if (version === 1) this.migrateDeletionGrants();
  }

  initializeSchema() {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE student_accounts (
        id TEXT PRIMARY KEY,
        student_key TEXT NOT NULL UNIQUE,
        student_id_iv BLOB NOT NULL,
        student_id_ciphertext BLOB NOT NULL,
        student_id_tag BLOB NOT NULL,
        student_id_masked TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE student_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES student_accounts(id),
        token_hash TEXT NOT NULL UNIQUE,
        device_label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX student_sessions_account_idx ON student_sessions(account_id, revoked_at);
      CREATE TABLE student_audit (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES student_accounts(id),
        action TEXT NOT NULL,
        session_id TEXT,
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE student_deletion_grants (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }

  migrateDeletionGrants() {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE student_deletion_grants (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 2;
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

  studentKey(studentId) {
    return crypto.createHmac('sha256', this.hmacSecret)
      .update(normalizedStudentId(studentId)).digest('hex');
  }

  encryptStudentId(studentId) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(studentId, 'utf8'), cipher.final()]);
    return { iv, encrypted, tag: cipher.getAuthTag() };
  }

  getStudentId(accountId) {
    const row = this.db.prepare(`
      SELECT student_id_iv, student_id_ciphertext, student_id_tag
      FROM student_accounts WHERE id = ?
    `).get(accountId);
    if (!row) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, row.student_id_iv);
    decipher.setAuthTag(row.student_id_tag);
    return Buffer.concat([
      decipher.update(row.student_id_ciphertext),
      decipher.final()
    ]).toString('utf8');
  }

  listAccounts(limit = 100) {
    return this.db.prepare(`
      SELECT id, student_id_masked, status, created_at, last_verified_at
      FROM student_accounts ORDER BY last_verified_at DESC LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
  }

  getAccount(accountId) {
    return this.db.prepare(`
      SELECT id, student_id_masked, status, created_at, last_verified_at
      FROM student_accounts WHERE id = ?
    `).get(accountId) ?? null;
  }

  createSession({ studentId, deviceLabel = '', previousToken = null, now = new Date() }) {
    const normalized = normalizedStudentId(studentId);
    const key = this.studentKey(normalized);
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    const label = String(deviceLabel ?? '').trim().slice(0, 80);
    return this.transaction(() => {
      let account = this.db.prepare('SELECT id FROM student_accounts WHERE student_key = ?').get(key);
      if (!account) {
        const id = crypto.randomUUID();
        const sealed = this.encryptStudentId(normalized);
        this.db.prepare(`
          INSERT INTO student_accounts
          (id, student_key, student_id_iv, student_id_ciphertext,
           student_id_tag, student_id_masked, created_at, last_verified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, key, sealed.iv, sealed.encrypted, sealed.tag,
          maskedStudentId(normalized), issuedAt, issuedAt);
        account = { id };
      } else {
        this.db.prepare('UPDATE student_accounts SET last_verified_at = ? WHERE id = ?')
          .run(issuedAt, account.id);
      }
      if (previousToken) {
        this.db.prepare('UPDATE student_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
          .run(issuedAt, tokenHash(previousToken));
      }
      const sessionId = crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO student_sessions
        (id, account_id, token_hash, device_label, created_at, last_used_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, account.id, tokenHash(token), label, issuedAt, issuedAt, expiresAt);
      this.audit(account.id, 'session_created', sessionId, issuedAt);
      const overflow = this.db.prepare(`
        SELECT id FROM student_sessions
        WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY rowid DESC LIMIT -1 OFFSET ?
      `).all(account.id, issuedAt, MAX_ACTIVE_SESSIONS);
      for (const row of overflow) {
        this.db.prepare('UPDATE student_sessions SET revoked_at = ? WHERE id = ?')
          .run(issuedAt, row.id);
        this.audit(account.id, 'session_limit_revoked', row.id, issuedAt);
      }
      return {
        accountId: account.id,
        sessionId,
        token,
        maskedStudentId: maskedStudentId(normalized),
        expiresAt
      };
    });
  }

  audit(accountId, action, sessionId, at) {
    this.db.prepare(`
      INSERT INTO student_audit (id, account_id, action, session_id, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), accountId, action, sessionId, at);
  }

  getSession(token, now = new Date()) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const at = now.toISOString();
    const session = this.db.prepare(`
      SELECT s.id, s.account_id, s.device_label, s.created_at, s.last_used_at,
             s.expires_at, a.student_id_masked
      FROM student_sessions s JOIN student_accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
        AND s.expires_at > ? AND a.status = 'active'
    `).get(tokenHash(token), at);
    if (!session) return null;
    if (Date.parse(at) - Date.parse(session.last_used_at) > 24 * 60 * 60 * 1000) {
      this.db.prepare('UPDATE student_sessions SET last_used_at = ? WHERE id = ?')
        .run(at, session.id);
    }
    return session;
  }

  listSessions(accountId, now = new Date()) {
    return this.db.prepare(`
      SELECT id, device_label, created_at, last_used_at, expires_at
      FROM student_sessions
      WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC
    `).all(accountId, now.toISOString());
  }

  revokeSession(token, now = new Date()) {
    const session = this.getSession(token, now);
    if (!session) return false;
    const at = now.toISOString();
    return this.transaction(() => {
      this.db.prepare('UPDATE student_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(at, session.id);
      this.audit(session.account_id, 'session_revoked', session.id, at);
      return true;
    });
  }

  revokeAllSessions(accountId, now = new Date()) {
    const at = now.toISOString();
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE student_sessions SET revoked_at = ?
        WHERE account_id = ? AND revoked_at IS NULL
      `).run(at, accountId);
      this.audit(accountId, 'all_sessions_revoked', null, at);
      return Number(result.changes);
    });
  }

  createDeletionGrant(studentId, now = new Date()) {
    const account = this.db.prepare('SELECT id, student_id_masked FROM student_accounts WHERE student_key = ?')
      .get(this.studentKey(studentId));
    if (!account) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + DELETION_GRANT_LIFETIME_MS).toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM student_deletion_grants WHERE account_id = ? OR expires_at <= ?')
        .run(account.id, now.toISOString());
      this.db.prepare('INSERT INTO student_deletion_grants (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
        .run(tokenHash(token), account.id, expiresAt);
    });
    return { token, maskedStudentId: account.student_id_masked, expiresAt };
  }

  accountForDeletionGrant(token, now = new Date()) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare(`
      SELECT account_id FROM student_deletion_grants
      WHERE token_hash = ? AND expires_at > ?
    `).get(tokenHash(token), now.toISOString());
    return row?.account_id ?? null;
  }

  deleteAccount(accountId) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM student_deletion_grants WHERE account_id = ?').run(accountId);
      this.db.prepare('DELETE FROM student_audit WHERE account_id = ?').run(accountId);
      this.db.prepare('DELETE FROM student_sessions WHERE account_id = ?').run(accountId);
      return Number(this.db.prepare('DELETE FROM student_accounts WHERE id = ?').run(accountId).changes) === 1;
    });
  }

  close() {
    this.db.close();
  }
}

export { MAX_ACTIVE_SESSIONS, SESSION_LIFETIME_MS, StudentIdentityStore };
