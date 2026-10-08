import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-share-routes-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.STUDENT_ID_HMAC_SECRET = '11'.repeat(32);
process.env.STUDENT_ID_ENCRYPTION_KEY = '22'.repeat(32);
process.env.SHARE_DATA_KEY = '33'.repeat(32);

const { app, adminStore, studentIdentityStore, engagementStore, shareStore } = await import('../src/server.js');

test('only verified owner rotates and destroys a code; public lookup exposes only allowed fields', async () => {
  const owner = studentIdentityStore.createSession({ studentId: '12345678' });
  const other = studentIdentityStore.createSession({ studentId: '87654321' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', token, body } = {}) => fetch(base + route, {
    method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    }, body: body ? JSON.stringify(body) : undefined
  });
  const snapshot = {
    term: { yearCode: '2026', termCode: '3', academicYearName: '2026-2027',
      termName: '秋', studentId: '12345678', studentName: '不应上传' },
    sessions: [{ courseName: '高数', teacherName: '张老师', campus: '宝山',
      location: '一教', credit: '3', weekday: 1, sections: [1, 2], weeks: [1, 3], note: '秘密' }],
    untimedCourses: []
  };
  try {
    assert.equal((await request('/api/v1/student/shares', { method: 'POST',
      body: { requestId: 'request-aaaaaaaa', snapshot, includeNote: false } })).status, 401);
    const created = await request('/api/v1/student/shares', { method: 'POST', token: owner.token,
      body: { requestId: 'request-aaaaaaaa', snapshot, includeNote: false, studentId: '87654321' } });
    assert.equal(created.status, 201);
    const share = (await created.json()).data;
    assert.equal((await (await request('/api/v1/student/shares/current', { token: owner.token })).json()).data.code,
      share.code);
    assert.equal((await (await request('/api/v1/student/shares/current', { token: other.token })).json()).data,
      null);
    const resolved = await request('/api/v1/shares/resolve', { method: 'POST', body: { code: share.code } });
    assert.equal(resolved.status, 200);
    const data = (await resolved.json()).data;
    assert.equal(data.snapshot.sessions[0].courseName, '高数');
    assert.equal(data.snapshot.sessions[0].note, undefined);
    assert.equal(JSON.stringify(data).includes('12345678'), false);
    assert.equal(JSON.stringify(data).includes(owner.accountId), false);
    assert.equal((await request('/api/v1/student/shares/current', { method: 'DELETE', token: other.token })).status, 204);
    assert.equal((await request('/api/v1/shares/resolve', { method: 'POST', body: { code: share.code } })).status, 200);
    assert.equal((await request('/api/v1/student/shares/current', { method: 'DELETE', token: owner.token })).status, 204);
    assert.equal((await request('/api/v1/shares/resolve', { method: 'POST', body: { code: share.code } })).status, 404);
    const guesses = [];
    for (let i = 0; i < 9; i++) {
      guesses.push((await request('/api/v1/shares/resolve', {
        method: 'POST', body: { code: `AAAAA${i}` }
      })).status);
    }
    assert.ok(guesses.includes(429));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => {
  shareStore.close();
  engagementStore.close();
  studentIdentityStore.close();
  adminStore.close();
  rmSync(directory, { recursive: true, force: true });
});
