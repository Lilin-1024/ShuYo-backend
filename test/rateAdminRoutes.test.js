import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-rate-admin-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.COOKIE_SECURE = 'false';
process.env.STUDENT_ID_HMAC_SECRET = '11'.repeat(32);
process.env.STUDENT_ID_ENCRYPTION_KEY = '22'.repeat(32);
process.env.SHARE_DATA_KEY = '33'.repeat(32);

const { app, adminStore, studentIdentityStore, reviewStore } = await import('../src/server.js');

function csrf(html) {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'a POST form needs a CSRF token');
  return match[1];
}

function cookie(response, name) {
  const value = response.headers.getSetCookie()
    .map((item) => item.split(';')[0])
    .find((item) => item.startsWith(name + '='));
  assert.ok(value, 'expected cookie ' + name);
  return value;
}

test('superadmins moderate reviews and answer course review feedback', async () => {
  const ownerId = adminStore.bootstrap('owner', 'a long private password');
  adminStore.createAdmin(ownerId, 'editor', 'another long password', 'content');
  reviewStore.importCatalog([{ 课程号: 'C1', 课程名称: '线性代数', 上课教师工号: 'T1', 上课教师姓名: '张老师', 教学班ID: 'S1' }],
    '2026-2027-1');
  const unitId = reviewStore.course('C1').units[0].id;
  const student = studentIdentityStore.createSession({ studentId: '12345678' });
  reviewStore.saveReview(student.accountId, unitId, { overall: 2, answers: { grading: 'strict' } });
  const feedback = reviewStore.createFeedback(student.accountId,
    { kind: 'incorrect', unitId, content: '<b>教师名</b>有误', appVersion: '1', platform: 'ios' });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (route, sessionCookie) => fetch(base + route, { redirect: 'manual', headers: { cookie: sessionCookie } });
  const post = (route, sessionCookie, body) => fetch(base + route, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  async function login(username, password) {
    const page = await fetch(base + '/admin/login');
    const response = await post('/admin/login', cookie(page, 'shuyo_admin_login_csrf'),
      { username, password, _csrf: csrf(await page.text()) });
    assert.equal(response.status, 302);
    return cookie(response, 'shuyo_admin_session');
  }
  try {
    const editor = await login('editor', 'another long password');
    assert.equal((await get('/admin/rate', editor)).status, 403);
    assert.doesNotMatch(await (await get('/admin', editor)).text(), /课评/);

    const owner = await login('owner', 'a long private password');
    let html = await (await get('/admin/rate', owner)).text();
    assert.match(html, /线性代数/);
    assert.match(html, /给分倾向：给分较严/);
    assert.match(html, /2026-2027-1/);
    const token = csrf(html);
    assert.equal((await post(`/admin/rate/accounts/${student.accountId}/block`, owner, { blocked: 'true' })).status, 403);

    html = await (await get(`/admin/rate/feedback/${feedback.id}`, owner)).text();
    assert.match(html, /&lt;b&gt;教师名&lt;\/b&gt;有误/);
    assert.equal((await post(`/admin/rate/feedback/${feedback.id}/reply`, owner,
      { _csrf: token, message: '已更正', status: 'replied' })).status, 302);
    assert.equal(reviewStore.getFeedback(feedback.id).status, 'replied');
    assert.equal((await post(`/admin/rate/feedback/${feedback.id}/close`, owner, { _csrf: token })).status, 302);
    assert.equal(reviewStore.getFeedback(feedback.id).status, 'closed');
    assert.match(await (await get('/admin/rate/feedback?status=closed', owner)).text(), /已关闭/);

    assert.equal((await post(`/admin/rate/accounts/${student.accountId}/block`, owner,
      { _csrf: token, blocked: 'true', purge: 'true' })).status, 302);
    assert.equal(reviewStore.isBlocked(student.accountId), true);
    assert.equal(reviewStore.unit(unitId).reviewCount, 0);
    reviewStore.setBlocked(student.accountId, false);
    const again = reviewStore.saveReview(student.accountId, unitId, { overall: 4 }).review;
    const deleted = await post(`/admin/rate/reviews/${again.id}/delete`, owner,
      { _csrf: token, returnTo: 'https://evil.example/' });
    assert.equal(deleted.headers.get('location').startsWith('/admin'), true);
    assert.equal(reviewStore.unit(unitId).reviewCount, 0);
    assert.equal((await post('/admin/rate/reviews/missing/delete', owner, { _csrf: token })).status, 404);

    const actions = adminStore.listAudit().map((entry) => entry.action);
    for (const action of ['rate.review.delete', 'rate.account_block', 'rate.feedback.reply', 'rate.feedback.close']) {
      assert.ok(actions.includes(action), action);
    }
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
