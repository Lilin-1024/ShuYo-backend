import crypto from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROLES = new Set(['superadmin', 'content']);
const sessionHours = Number.parseInt(process.env.SESSION_TTL_HOURS ?? '168', 10);
const SESSION_LIFETIME_MS = (Number.isFinite(sessionHours) && sessionHours > 0 ? sessionHours : 168) * 3600000;

function normalizeUsername(value) {
  const username = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) {
    throw new Error('登录名须为 3–32 位小写字母、数字、下划线或连字符，且以字母开头。');
  }
  return username;
}

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('密码须为 12–256 个字符。');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return ['scrypt', 16384, 8, 1, salt.toString('hex'), hash.toString('hex')].join('$');
}

function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (n !== 16384 || r !== 8 || p !== 1 || salt.length !== 16 || expected.length !== 64) return false;
  const actual = crypto.scryptSync(String(password ?? ''), salt, 64, { N: n, r, p });
  return crypto.timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class AdminStore {
  constructor({ filename }) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > 1) throw new Error('Unsupported admin database version: ' + version);
    if (version === 0) this.initializeSchema();
  }

  initializeSchema() {
    this.db.exec("BEGIN IMMEDIATE;"
      + "CREATE TABLE admins (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,"
      + " password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('superadmin','content')),"
      + " active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),"
      + " created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;"
      + "CREATE TABLE admin_sessions (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id),"
      + " token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL,"
      + " created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT) STRICT;"
      + "CREATE INDEX admin_sessions_admin_idx ON admin_sessions(admin_id, revoked_at);"
      + "CREATE TABLE admin_audit (id TEXT PRIMARY KEY, actor_id TEXT REFERENCES admins(id),"
      + " action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT,"
      + " detail TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL) STRICT;"
      + "CREATE INDEX admin_audit_time_idx ON admin_audit(occurred_at DESC);"
      + "CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;"
      + "CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;"
      + "PRAGMA user_version = 1; COMMIT;");
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

  audit(actorId, action, targetType, targetId = null, detail = '') {
    this.db.prepare('INSERT INTO admin_audit (id, actor_id, action, target_type, target_id, detail, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), actorId, action, targetType, targetId, detail, new Date().toISOString());
  }

  bootstrap(username, password) {
    const name = normalizeUsername(username);
    const passwordHash = hashPassword(password);
    return this.transaction(() => {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n !== 0) throw new Error('管理员已初始化。');
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO admins (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'superadmin', ?, ?)")
        .run(id, name, passwordHash, now, now);
      this.audit(id, 'admin.bootstrap', 'admin', id);
      return id;
    });
  }

  authenticate(username, password) {
    const name = String(username ?? '').trim().toLowerCase();
    const admin = this.db.prepare('SELECT * FROM admins WHERE username = ? AND active = 1').get(name);
    if (!admin || !verifyPassword(password, admin.password_hash)) return null;
    return { id: admin.id, username: admin.username, role: admin.role };
  }

  createSession(adminId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    this.db.prepare('INSERT INTO admin_sessions (id, admin_id, token_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), adminId, tokenHash(token), csrfToken, now.toISOString(),
        new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString());
    this.audit(adminId, 'admin.login', 'admin', adminId);
    return { token, csrfToken, maxAge: SESSION_LIFETIME_MS };
  }

  getSession(token, now = new Date()) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.db.prepare(
      "SELECT s.id AS session_id, s.csrf_token, a.id, a.username, a.role"
      + " FROM admin_sessions s JOIN admins a ON a.id = s.admin_id"
      + " WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.active = 1"
    ).get(tokenHash(token), now.toISOString()) ?? null;
  }

  revokeSession(token, actorId = null) {
    if (typeof token !== 'string') return;
    this.db.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), tokenHash(token));
    if (actorId) this.audit(actorId, 'admin.logout', 'admin', actorId);
  }

  revokeAllSessions(adminId) {
    this.db.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), adminId);
  }

  listAdmins() {
    return this.db.prepare('SELECT id, username, role, active, created_at, updated_at FROM admins ORDER BY created_at').all();
  }

  getAdmin(id) {
    return this.db.prepare('SELECT id, username, role, active, created_at, updated_at FROM admins WHERE id = ?').get(id) ?? null;
  }

  createAdmin(actorId, username, password, role) {
    const name = normalizeUsername(username);
    if (!ROLES.has(role)) throw new Error('管理员角色无效。');
    const passwordHash = hashPassword(password);
    return this.transaction(() => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO admins (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, passwordHash, role, now, now);
      this.audit(actorId, 'admin.create', 'admin', id, role);
      return id;
    });
  }

  updateAdmin(actorId, id, { role, active }) {
    if (!ROLES.has(role) || typeof active !== 'boolean') throw new Error('管理员状态无效。');
    return this.transaction(() => {
      const target = this.getAdmin(id);
      if (!target) throw new Error('管理员不存在。');
      if (actorId === id && (role !== target.role || !active)) throw new Error('不能修改自己的角色或停用自己的账号。');
      if (target.role === 'superadmin' && (role !== 'superadmin' || !active)) {
        const count = this.db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'superadmin' AND active = 1").get().n;
        if (count <= 1) throw new Error('必须保留至少一名有效的总管理员。');
      }
      const changed = target.role !== role || Boolean(target.active) !== active;
      if (changed) {
        this.db.prepare('UPDATE admins SET role = ?, active = ?, updated_at = ? WHERE id = ?')
          .run(role, Number(active), new Date().toISOString(), id);
        this.revokeAllSessions(id);
        this.audit(actorId, 'admin.update', 'admin', id, role + ':' + (active ? 'active' : 'disabled'));
      }
      return changed;
    });
  }

  resetPassword(actorId, id, password) {
    const passwordHash = hashPassword(password);
    return this.transaction(() => {
      if (!this.getAdmin(id)) throw new Error('管理员不存在。');
      this.db.prepare('UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, new Date().toISOString(), id);
      this.revokeAllSessions(id);
      this.audit(actorId, 'admin.password_reset', 'admin', id);
    });
  }

  changeOwnPassword(id, currentPassword, newPassword) {
    const passwordHash = hashPassword(newPassword);
    return this.transaction(() => {
      const admin = this.db.prepare('SELECT password_hash FROM admins WHERE id = ? AND active = 1').get(id);
      if (!admin || !verifyPassword(currentPassword, admin.password_hash)) {
        throw new Error('当前密码错误。');
      }
      this.db.prepare('UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, new Date().toISOString(), id);
      this.revokeAllSessions(id);
      this.audit(id, 'admin.password_change', 'admin', id);
    });
  }

  listAudit(limit = 100) {
    return this.db.prepare(
      'SELECT audit.*, admins.username AS actor_name FROM admin_audit audit'
      + ' LEFT JOIN admins ON admins.id = audit.actor_id'
      + ' ORDER BY audit.occurred_at DESC, audit.rowid DESC LIMIT ?'
    ).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
  }

  close() { this.db.close(); }
}

export { AdminStore, SESSION_LIFETIME_MS };
