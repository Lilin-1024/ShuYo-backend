import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SESSION_LIFETIME_MS, StudentIdentityStore } from '../src/studentIdentityStore.js';

function createStore() {
  return new StudentIdentityStore({
    filename: ':memory:',
    hmacSecret: '11'.repeat(32),
    encryptionKey: '22'.repeat(32)
  });
}

test('multiple devices map to one verified student account', () => {
  const store = createStore();
  try {
    const now = new Date('2026-10-07T08:00:00Z');
    const first = store.createSession({ studentId: '23123456', deviceLabel: 'iPhone', now });
    const second = store.createSession({ studentId: '23123456', deviceLabel: 'Android', now });
    assert.equal(first.accountId, second.accountId);
    assert.notEqual(first.token, second.token);
    assert.equal(store.getStudentId(first.accountId), '23123456');
    assert.equal(store.getSession(first.token, now).account_id, first.accountId);
    assert.equal(store.listSessions(first.accountId, now).length, 2);
    const account = store.db.prepare('SELECT * FROM student_accounts WHERE id = ?').get(first.accountId);
    assert.equal(JSON.stringify(account).includes('23123456'), false);
    const persistedToken = store.db.prepare('SELECT token_hash FROM student_sessions WHERE id = ?')
      .get(first.sessionId).token_hash;
    assert.notEqual(persistedToken, first.token);
  } finally {
    store.close();
  }
});

test('sessions expire after 90 days and can be revoked earlier', () => {
  const store = createStore();
  try {
    const now = new Date('2026-10-07T08:00:00Z');
    const session = store.createSession({ studentId: '23123456', now });
    assert.equal(store.getSession(session.token, new Date(now.getTime() + SESSION_LIFETIME_MS - 1))?.id,
      session.sessionId);
    assert.equal(store.getSession(session.token, new Date(now.getTime() + SESSION_LIFETIME_MS)), null);
    assert.equal(store.revokeSession(session.token, new Date(now.getTime() + 1000)), true);
    assert.equal(store.getSession(session.token, new Date(now.getTime() + 2000)), null);
  } finally {
    store.close();
  }
});

test('reverification rotates one device while keeping the account', () => {
  const store = createStore();
  try {
    const now = new Date('2026-10-07T08:00:00Z');
    const first = store.createSession({ studentId: '23123456', now });
    const second = store.createSession({
      studentId: '23123456',
      previousToken: first.token,
      now: new Date(now.getTime() + 1000)
    });
    assert.equal(first.accountId, second.accountId);
    assert.equal(store.getSession(first.token, new Date(now.getTime() + 2000)), null);
    assert.notEqual(store.getSession(second.token, new Date(now.getTime() + 2000)), null);
    assert.equal(store.revokeAllSessions(second.accountId, new Date(now.getTime() + 3000)), 1);
    assert.equal(store.getSession(second.token, new Date(now.getTime() + 4000)), null);
  } finally {
    store.close();
  }
});

test('encrypted student identity survives a server restart without plaintext on disk', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-identity-'));
  const filename = path.join(directory, 'accounts.sqlite');
  try {
    const options = {
      filename,
      hmacSecret: '11'.repeat(32),
      encryptionKey: '22'.repeat(32)
    };
    const first = new StudentIdentityStore(options);
    const issued = first.createSession({ studentId: '23123456' });
    first.close();
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    assert.equal(readFileSync(filename).includes(Buffer.from('23123456')), false);
    const restarted = new StudentIdentityStore(options);
    assert.equal(restarted.getStudentId(issued.accountId), '23123456');
    assert.equal(restarted.getSession(issued.token)?.account_id, issued.accountId);
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
