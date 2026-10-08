import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-engagement-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.COOKIE_SECURE = 'false';
process.env.PRESENCE_HMAC_SECRET = 'test-presence-secret';
process.env.STUDENT_ID_HMAC_SECRET = '11'.repeat(32);
process.env.STUDENT_ID_ENCRYPTION_KEY = '22'.repeat(32);

const { app, adminStore, studentIdentityStore, engagementStore } = await import('../src/server.js');
const { EngagementStore } = await import('../src/engagementStore.js');

test('verified feedback, account moderation and legacy compatibility', async () => {
  adminStore.bootstrap('owner', 'a long private password');
  const first = studentIdentityStore.createSession({ studentId: '12345678' });
  const second = studentIdentityStore.createSession({ studentId: '12345678' });
  const outsider = studentIdentityStore.createSession({ studentId: '87654321' });
  assert.equal(first.accountId, second.accountId);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', token, body, cookie } = {}) => fetch(base + route, {
    method, redirect: 'manual',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  try {
    const route = '/api/v1/student/feedback';
    assert.equal((await request(route, { method: 'POST', body: { content: 'x' } })).status, 401);
    const created = await request(route, { method: 'POST', token: first.token,
      body: { title: '测试', content: '内容', studentId: '87654321' } });
    assert.equal(created.status, 201);
    const id = (await created.json()).data.id;
    assert.equal((await (await request(route, { token: second.token })).json()).data[0].id, id);
    assert.deepEqual((await (await request(route, { token: outsider.token })).json()).data, []);
    assert.equal((await request(`${route}/${id}`, { token: outsider.token })).status, 404);
    assert.equal((await request(`${route}/${id}/close`, { method: 'POST', token: outsider.token })).status, 404);
    assert.equal((await request(`${route}/${id}/close`, { method: 'POST', token: second.token })).status, 200);
    assert.equal(engagementStore.getFeedback(id).status, 'closed');

    engagementStore.setBlocked(first.accountId, true);
    assert.equal((await request(route, { method: 'POST', token: second.token, body: { content: 'blocked' } })).status, 403);
    assert.equal((await request(route, { method: 'POST', token: outsider.token, body: { content: 'other' } })).status, 201);
    for (let i = 0; i < 4; i++) {
      assert.equal((await request(route, { method: 'POST', token: outsider.token,
        body: { content: `other ${i}` } })).status, 201);
    }
    assert.equal((await request(route, { method: 'POST', token: outsider.token,
      body: { content: 'too many' } })).status, 429);

    assert.equal((await request('/api/v1/presence/heartbeat', { method: 'POST',
      body: { userId: 999999, installationId: 'legacy' } })).status, 204);
    assert.equal(engagementStore.presenceStats().total, 0);
    assert.equal((await request('/api/v1/student/presence/heartbeat', { method: 'POST' })).status, 401);
    for (const token of [first.token, second.token, outsider.token]) {
      assert.equal((await request('/api/v1/student/presence/heartbeat', { method: 'POST', token })).status, 204);
    }
    assert.equal(engagementStore.presenceStats().active1d, 2);

    const old = await request('/api/v1/feedback', { method: 'POST', body: { content: '旧版', deviceId: 'old-device' } });
    assert.equal(old.status, 201);
    const oldData = (await old.json()).data;
    assert.equal((await request(`/api/v1/feedback/${oldData.id}`,
      { token: outsider.token })).status, 403);
    const legacy = await fetch(base + `/api/v1/feedback/${oldData.id}`, {
      headers: { 'x-feedback-token': oldData.lookupToken }
    });
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).data.content, '旧版');

    const csrfPage = await request('/admin/login');
    const loginCookie = csrfPage.headers.getSetCookie()[0].split(';')[0];
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await csrfPage.text())[1];
    const login = await fetch(base + '/admin/login', {
      method: 'POST', redirect: 'manual',
      headers: { cookie: loginCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'owner', password: 'a long private password', _csrf: csrf })
    });
    const sessionCookie = login.headers.getSetCookie().find((item) => item.startsWith('shuyo_admin_session=')).split(';')[0];
    const page = await request(`/admin/feedback/${id}`, { cookie: sessionCookie });
    const html = await page.text();
    assert.match(html, /账户反馈/);
    assert.match(html, new RegExp(first.accountId));
    assert.doesNotMatch(html, /87654321/);
    assert.match(await (await request('/admin/feedback', { cookie: sessionCookie })).text(), /旧版反馈/);
    const adminCsrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    const formPost = (path, fields) => fetch(base + path, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields)
    });
    assert.equal((await formPost('/admin/feedback/account-block',
      { accountId: first.accountId, blocked: 'false' })).status, 403);
    assert.equal((await formPost('/admin/feedback/account-block',
      { accountId: first.accountId, blocked: 'false', _csrf: adminCsrf })).status, 302);
    assert.equal(engagementStore.isBlocked(first.accountId), false);
    assert.ok(adminStore.listAudit().some((item) => item.action === 'feedback.account_block' &&
      item.target_id === first.accountId));
    assert.equal((await formPost(`/admin/feedback/${id}/reply`,
      { message: '管理员回复', status: 'closed', _csrf: adminCsrf })).status, 302);
    const detail = (await (await request(`${route}/${id}`, { token: second.token })).json()).data;
    assert.equal(detail.replies[0].message, '管理员回复');
    assert.equal(detail.status, 'closed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('presence counts verified accounts by Shanghai calendar day and starts empty', () => {
  const store = new EngagementStore({ filename: ':memory:', hmacSecret: 'test-presence-secret' });
  assert.deepEqual(store.presenceStats(new Date('2026-10-08T15:59:00Z')),
    { active1d: 0, active3d: 0, active7d: 0, total: 0 });
  const a = 'account-a';
  const b = 'account-b';
  store.recordPresence(a, new Date('2026-10-08T15:59:00Z'));
  store.recordPresence(a, new Date('2026-10-08T15:59:30Z'));
  store.recordPresence(a, new Date('2026-10-08T16:00:00Z'));
  store.recordPresence(b, new Date('2026-10-08T16:01:00Z'));
  assert.deepEqual(store.presenceStats(new Date('2026-10-08T16:02:00Z')),
    { active1d: 2, active3d: 2, active7d: 2, total: 2 });
  assert.deepEqual(store.presenceStats(new Date('2026-10-08T15:59:30Z')),
    { active1d: 1, active3d: 1, active7d: 1, total: 2 });
  store.deleteAccount(a);
  assert.equal(store.presenceStats(new Date('2026-10-08T16:02:00Z')).total, 1);
  store.close();
});

test.after(() => {
  engagementStore.close();
  studentIdentityStore.close();
  adminStore.close();
  rmSync(directory, { recursive: true, force: true });
});
