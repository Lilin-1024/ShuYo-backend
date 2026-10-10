import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-data-deletion-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.STUDENT_ID_HMAC_SECRET = '11'.repeat(32);
process.env.STUDENT_ID_ENCRYPTION_KEY = '22'.repeat(32);
process.env.SHARE_DATA_KEY = '33'.repeat(32);

const { app, adminStore, studentIdentityStore, engagementStore, shareStore } =
  await import('../src/server.js');

test('school verification deletes data without renewing a revoked device', async () => {
  const session = studentIdentityStore.createSession({ studentId: '23123456' });
  engagementStore.createFeedback(session.accountId, {
    title: '问题', content: '内容', contact: '', appVersion: '1', platform: 'ios'
  });
  engagementStore.recordPresence(session.accountId);
  shareStore.create(session.accountId, 'request-aaaaaaaa', {
    term: { yearCode: '2026', termCode: '3' }, sessions: [], untimedCourses: []
  }, false);
  studentIdentityStore.revokeAllSessions(session.accountId);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === 'jwxt.shu.edu.cn') {
      assert.equal(options.headers.cookie, 'JSESSIONID=fresh-school-login');
      return new Response('<form id="form"><input name="xh_id" value="23123456"></form>');
    }
    return originalFetch(url, options);
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, method, body) => originalFetch(base + route, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  try {
    assert.equal((await request('/api/v1/student/data-deletion/verify', 'POST', {
      schoolCookie: 'JSESSIONID=fresh-school-login', expectedStudentId: '87654321'
    })).status, 409);
    const verified = await request('/api/v1/student/data-deletion/verify', 'POST', {
      schoolCookie: 'JSESSIONID=fresh-school-login', expectedStudentId: '23123456'
    });
    assert.equal(verified.status, 200);
    const grant = (await verified.json()).data;
    assert.equal(grant.maskedStudentId, '23****56');
    assert.equal(studentIdentityStore.listSessions(session.accountId).length, 0);
    assert.equal((await request('/api/v1/student/data', 'DELETE', { token: grant.token })).status, 204);
    assert.equal(studentIdentityStore.getAccount(session.accountId), null);
    assert.equal(engagementStore.listFeedback(session.accountId).length, 0);
    assert.equal(shareStore.current(session.accountId), null);
    assert.equal((await request('/api/v1/student/data', 'DELETE', { token: grant.token })).status, 401);
    assert.equal((await request('/api/v1/student/sessions', 'POST', {
      schoolCookie: 'JSESSIONID=fresh-school-login', expectedStudentId: '23123456'
    })).status, 403);
    assert.equal(studentIdentityStore.getAccount(session.accountId), null);
    const started = await request('/api/v1/student/sessions', 'POST', {
      schoolCookie: 'JSESSIONID=fresh-school-login', expectedStudentId: '23123456',
      userInitiated: true
    });
    assert.equal(started.status, 201);
    assert.notEqual((await started.json()).data.accountId, session.accountId);
  } finally {
    globalThis.fetch = originalFetch;
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
