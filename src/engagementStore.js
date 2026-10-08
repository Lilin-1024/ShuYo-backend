import crypto from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

class EngagementStore {
  constructor({ filename, hmacSecret }) {
    if (typeof hmacSecret !== 'string' || !hmacSecret.trim() || hmacSecret.startsWith('change-')) {
      throw new Error('PRESENCE_HMAC_SECRET must be configured');
    }
    this.hmacSecret = hmacSecret;
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON');
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > 1) throw new Error(`Unsupported engagement database version: ${version}`);
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE feedback (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL,
        content TEXT NOT NULL, contact TEXT NOT NULL, app_version TEXT NOT NULL,
        platform TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','replied','closed')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX feedback_account_idx ON feedback(account_id, created_at DESC);
      CREATE TABLE feedback_replies (
        id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
        author TEXT NOT NULL, author_id TEXT NOT NULL, message TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX feedback_replies_feedback_idx ON feedback_replies(feedback_id, created_at);
      CREATE TABLE feedback_blocks (
        account_id TEXT PRIMARY KEY, blocked_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE presence_accounts (
        account_key TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE presence_days (
        day TEXT NOT NULL, account_key TEXT NOT NULL REFERENCES presence_accounts(account_key) ON DELETE CASCADE,
        PRIMARY KEY(day, account_key)
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

  accountKey(accountId) {
    return crypto.createHmac('sha256', this.hmacSecret).update(accountId).digest('hex');
  }

  recordPresence(accountId, now = new Date()) {
    const key = this.accountKey(accountId);
    const at = now.toISOString();
    const day = dateKey(now);
    this.transaction(() => {
      this.db.prepare(`INSERT INTO presence_accounts(account_key, first_seen_at, last_seen_at)
        VALUES (?, ?, ?) ON CONFLICT(account_key) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
        .run(key, at, at);
      this.db.prepare('INSERT OR IGNORE INTO presence_days(day, account_key) VALUES (?, ?)').run(day, key);
    });
  }

  presenceStats(now = new Date()) {
    const today = dateKey(now);
    const start = (days) => dateKey(new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000));
    const count = (days) => this.db.prepare('SELECT COUNT(DISTINCT account_key) AS n FROM presence_days WHERE day BETWEEN ? AND ?')
      .get(start(days), today).n;
    return {
      active1d: count(1), active3d: count(3), active7d: count(7),
      total: this.db.prepare('SELECT COUNT(*) AS n FROM presence_accounts').get().n
    };
  }

  isBlocked(accountId) {
    return Boolean(this.db.prepare('SELECT 1 FROM feedback_blocks WHERE account_id = ?').get(accountId));
  }

  setBlocked(accountId, blocked, now = new Date()) {
    if (blocked) this.db.prepare('INSERT OR IGNORE INTO feedback_blocks(account_id, blocked_at) VALUES (?, ?)')
      .run(accountId, now.toISOString());
    else this.db.prepare('DELETE FROM feedback_blocks WHERE account_id = ?').run(accountId);
  }

  listBlocks() {
    return this.db.prepare('SELECT account_id AS accountId, blocked_at AS blockedAt FROM feedback_blocks ORDER BY blocked_at DESC').all();
  }

  createFeedback(accountId, { title, content, contact, appVersion, platform }, now = new Date()) {
    return this.transaction(() => {
      if (this.isBlocked(accountId)) return { error: 'blocked' };
      const recent = this.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE account_id = ? AND created_at >= ?')
        .get(accountId, new Date(now.getTime() - 10 * 60 * 1000).toISOString()).n;
      if (recent >= 5) return { error: 'rate_limited' };
      const id = `sf_${crypto.randomUUID()}`;
      const at = now.toISOString();
      this.db.prepare(`INSERT INTO feedback
        (id, account_id, title, content, contact, app_version, platform, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
        .run(id, accountId, title || '未命名反馈', content, contact, appVersion, platform, at, at);
      return { id, status: 'open', createdAt: at };
    });
  }

  rowToFeedback(row) {
    if (!row) return null;
    return {
      source: 'student', id: row.id, accountId: row.account_id,
      title: row.title, content: row.content, contact: row.contact,
      appVersion: row.app_version, platform: row.platform, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
      blocked: this.isBlocked(row.account_id),
      replies: this.db.prepare(`SELECT id, author, message, created_at AS createdAt
        FROM feedback_replies WHERE feedback_id = ? ORDER BY created_at, rowid`).all(row.id)
    };
  }

  getFeedback(id, accountId = null) {
    const row = accountId === null
      ? this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id)
      : this.db.prepare('SELECT * FROM feedback WHERE id = ? AND account_id = ?').get(id, accountId);
    return this.rowToFeedback(row);
  }

  listFeedback(accountId = null) {
    const rows = accountId === null
      ? this.db.prepare('SELECT * FROM feedback ORDER BY created_at DESC').all()
      : this.db.prepare('SELECT * FROM feedback WHERE account_id = ? ORDER BY created_at DESC').all(accountId);
    return rows.map((row) => this.rowToFeedback(row));
  }

  closeFeedback(id, accountId, now = new Date()) {
    return this.db.prepare(`UPDATE feedback SET status = 'closed', updated_at = ?
      WHERE id = ? AND account_id = ? AND status != 'closed'`)
      .run(now.toISOString(), id, accountId).changes;
  }

  reply(id, { author, authorId, message, status }, now = new Date()) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT id FROM feedback WHERE id = ?').get(id);
      if (!row) return false;
      const at = now.toISOString();
      this.db.prepare(`INSERT INTO feedback_replies(id, feedback_id, author, author_id, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), id, author, authorId, message, at);
      this.db.prepare('UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, at, id);
      return true;
    });
  }

  deleteAccount(accountId) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM feedback WHERE account_id = ?').run(accountId);
      this.db.prepare('DELETE FROM feedback_blocks WHERE account_id = ?').run(accountId);
      this.db.prepare('DELETE FROM presence_accounts WHERE account_key = ?').run(this.accountKey(accountId));
    });
  }

  close() { this.db.close(); }
}

export { EngagementStore, dateKey };
