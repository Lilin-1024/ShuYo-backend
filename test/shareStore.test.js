import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ShareStore, canonicalSnapshot } from '../src/shareStore.js';

const snapshot = {
  term: {
    yearCode: '2026', termCode: '3', academicYearName: '2026-2027',
    termName: '秋', studentName: '必须丢弃', studentId: '12345678', className: '必须丢弃'
  },
  sessions: [{
    id: 'manual:random', courseName: '线性代数', teacherName: '张老师',
    campus: '宝山', location: '一教', credit: '3', weekday: 1,
    sections: [2, 1], weeks: [2, 1], note: '个人备注'
  }],
  untimedCourses: [{
    id: 'untimed-random', courseName: '实践课', teacherName: '李老师',
    campus: '宝山', credit: '1', weeks: [1, 2], summary: '自主安排'
  }],
  fetchedAt: '2026-10-08T00:00:00Z'
};

test('snapshot whitelist keeps scheduled data and excludes identity and optional notes', () => {
  const without = canonicalSnapshot(snapshot, false);
  assert.equal(without.snapshot.sessions[0].note, undefined);
  assert.equal(without.snapshot.term.studentId, undefined);
  assert.equal(without.snapshot.sessions[0].id, undefined);
  assert.deepEqual(without.snapshot.sessions[0].sections, [1, 2]);
  assert.notEqual(canonicalSnapshot(snapshot, true).digest, without.digest);
  assert.equal(canonicalSnapshot({ ...snapshot, fetchedAt: 'later' }, false).digest, without.digest);
  assert.throws(() => canonicalSnapshot({ ...snapshot, sessions: [{ ...snapshot.sessions[0], weekday: 8 }] }, false));
});

test('each deliberate generation rotates the sole code; retries and daily quota are stable', () => {
  const store = new ShareStore({ filename: ':memory:', encryptionKey: '33'.repeat(32) });
  const at = new Date('2026-10-08T09:00:00Z');
  try {
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const result = store.create('account-a', `request-0000000${i}`, snapshot, false,
        new Date(at.getTime() + i * 1000));
      assert.match(result.code, /^[A-Za-z0-9]{6}$/);
      codes.push(result.code);
      const storedHash = store.db.prepare('SELECT code_hash FROM shares WHERE owner_id = ?')
        .get('account-a').code_hash;
      assert.notEqual(storedHash, crypto.createHash('sha256').update(result.code).digest('hex'));
      assert.equal(store.current('account-a', at).code, result.code);
      if (i > 0) assert.equal(store.resolve(codes[i - 1], at), null);
    }
    assert.equal(new Set(codes).size, 4);
    const retry = store.create('account-a', 'request-00000003', snapshot, false, at);
    assert.equal(retry.code, codes[3]);
    assert.equal(retry.reusedRequest, true);
    assert.deepEqual(store.create('account-a', 'request-00000004', snapshot, false, at),
      { error: 'daily_limit' });
    assert.equal(store.current('account-a', at).code, codes[3]);
    assert.equal(store.resolve(codes[3], at).snapshot.term.studentId, undefined);
    assert.equal(store.destroy('account-a'), true);
    assert.equal(store.current('account-a'), null);
    assert.equal(store.resolve(codes[3], at), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM retired_codes').get().n, 4);
    assert.deepEqual(store.create('account-a', 'request-00000005', snapshot, false, at),
      { error: 'daily_limit' });
  } finally { store.close(); }
});

test('expiry and account deletion remove access without affecting another account', () => {
  const store = new ShareStore({ filename: ':memory:', encryptionKey: '33'.repeat(32) });
  const at = new Date('2026-10-08T09:00:00Z');
  try {
    const a = store.create('account-a', 'request-aaaaaaaa', snapshot, true, at);
    const b = store.create('account-b', 'request-bbbbbbbb', snapshot, false, at);
    assert.equal(store.resolve(a.code, new Date(at.getTime() + 14 * 86400000)), null);
    store.deleteAccount('account-a');
    assert.equal(store.resolve(a.code, at), null);
    assert.ok(store.resolve(b.code, at));
    store.cleanup(new Date(at.getTime() + 15 * 86400000));
    assert.equal(store.current('account-b'), null);
  } finally { store.close(); }
});

test('encrypted share and idempotency survive a database restart', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-shares-'));
  const filename = path.join(directory, 'shares.sqlite');
  const at = new Date('2026-10-08T09:00:00Z');
  try {
    const first = new ShareStore({ filename, encryptionKey: '33'.repeat(32) });
    const created = first.create('account-a', 'request-aaaaaaaa', snapshot, true, at);
    first.close();
    assert.equal(readFileSync(filename).includes(Buffer.from('线性代数')), false);
    assert.equal(readFileSync(filename).includes(Buffer.from(created.code)), false);
    const restarted = new ShareStore({ filename, encryptionKey: '33'.repeat(32) });
    assert.equal(restarted.current('account-a', at).code, created.code);
    assert.equal(restarted.create('account-a', 'request-aaaaaaaa', snapshot, true, at).code,
      created.code);
    assert.equal(restarted.resolve(created.code, at).snapshot.sessions[0].note, '个人备注');
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
