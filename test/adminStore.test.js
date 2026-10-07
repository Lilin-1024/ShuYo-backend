import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AdminStore, SESSION_LIFETIME_MS } from '../src/adminStore.js';

test('bootstrap, persistent sessions and account roles', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-admin-'));
  const filename = path.join(directory, 'admins.sqlite');
  try {
    const first = new AdminStore({ filename });
    const ownerId = first.bootstrap('lilin', 'a long private password');
    assert.throws(() => first.bootstrap('second', 'another long password'));
    assert.equal(first.authenticate('lilin', 'wrong'), null);
    assert.equal(first.authenticate('lilin', 'a long private password').id, ownerId);
    const session = first.createSession(ownerId);
    assert.equal(first.getSession(session.token).role, 'superadmin');
    assert.equal(first.getSession(session.token,
      new Date(Date.now() + SESSION_LIFETIME_MS + 1000)), null);
    assert.equal(readFileSync(filename).includes(Buffer.from('a long private password')), false);
    assert.equal(readFileSync(filename).includes(Buffer.from(session.token)), false);
    first.close();
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    const restarted = new AdminStore({ filename });
    assert.equal(restarted.getSession(session.token).id, ownerId);
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('role changes, password resets and disabling revoke sessions', () => {
  const store = new AdminStore({ filename: ':memory:' });
  try {
    const owner = store.bootstrap('lilin', 'a long private password');
    const second = store.createAdmin(owner, 'editor', 'another long password', 'content');
    const session = store.createSession(second);
    assert.equal(store.getSession(session.token).role, 'content');
    assert.throws(() => store.updateAdmin(owner, owner, { role: 'content', active: true }));
    assert.throws(() => store.updateAdmin(owner, owner, { role: 'superadmin', active: false }));
    store.updateAdmin(owner, second, { role: 'superadmin', active: true });
    assert.equal(store.getSession(session.token), null);
    const promoted = store.createSession(second);
    assert.equal(store.getSession(promoted.token).role, 'superadmin');
    store.resetPassword(owner, second, 'replacement password');
    assert.equal(store.getSession(promoted.token), null);
    assert.equal(store.authenticate('editor', 'another long password'), null);
    assert.equal(store.authenticate('editor', 'replacement password').id, second);
    const replacement = store.createSession(second);
    store.updateAdmin(owner, second, { role: 'content', active: false });
    assert.equal(store.getSession(replacement.token), null);
    assert.equal(store.authenticate('editor', 'replacement password'), null);
    assert.ok(store.listAudit().some((item) => item.action === 'admin.update' && item.actor_id === owner));
    assert.throws(() => store.db.exec('DELETE FROM admin_audit'));
  } finally {
    store.close();
  }
});

test('own password change checks old password and ends all sessions', () => {
  const store = new AdminStore({ filename: ':memory:' });
  try {
    const owner = store.bootstrap('lilin', 'a long private password');
    const session = store.createSession(owner);
    assert.throws(() => store.changeOwnPassword(owner, 'wrong', 'replacement password'));
    assert.ok(store.getSession(session.token));
    store.changeOwnPassword(owner, 'a long private password', 'replacement password');
    assert.equal(store.getSession(session.token), null);
    assert.equal(store.authenticate('lilin', 'replacement password').id, owner);
  } finally {
    store.close();
  }
});
