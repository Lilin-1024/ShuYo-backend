import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-admin-routes-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.COOKIE_SECURE = 'false';
process.env.STUDENT_ID_HMAC_SECRET = '11'.repeat(32);
process.env.STUDENT_ID_ENCRYPTION_KEY = '22'.repeat(32);

const { app, adminStore, studentIdentityStore } = await import('../src/server.js');

function csrf(html) {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'a POST form needs a CSRF token');
  return match[1];
}

function allPostFormsProtected(html) {
  const forms = [...html.matchAll(/<form\b[^>]*method="post"[^>]*>[\s\S]*?<\/form>/gi)];
  assert.ok(forms.length > 0);
  assert.ok(forms.every(([form]) => /name="_csrf" value="[^"]+"/.test(form)));
}

function cookie(response, name) {
  const value = response.headers.getSetCookie()
    .map((item) => item.split(';')[0])
    .find((item) => item.startsWith(name + '='));
  assert.ok(value, 'expected cookie ' + name);
  return value;
}

test('admin roles, CSRF, audit and student ID disclosure', async () => {
  const ownerId = adminStore.bootstrap('lilin', 'a long private password');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (route, sessionCookie) => fetch(base + route, {
    redirect: 'manual', headers: sessionCookie ? { cookie: sessionCookie } : {}
  });
  const post = (route, sessionCookie, body) => fetch(base + route, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  async function login(username, password) {
    const page = await get('/admin/login');
    const loginCookie = cookie(page, 'shuyo_admin_login_csrf');
    const response = await post('/admin/login', loginCookie, {
      username, password, _csrf: csrf(await page.text())
    });
    assert.equal(response.status, 302);
    return cookie(response, 'shuyo_admin_session');
  }
  try {
    const ownerCookie = await login('lilin', 'a long private password');
    let page = await get('/admin/admins', ownerCookie);
    assert.equal(page.status, 200);
    let html = await page.text();
    assert.match(html, /lilin/);
    allPostFormsProtected(html);
    const ownerCsrf = csrf(html);
    assert.equal((await post('/admin/admins', ownerCookie, {
      username: 'editor', password: 'another long password', role: 'content'
    })).status, 403);
    const created = await post('/admin/admins', ownerCookie, {
      username: 'editor', password: 'another long password',
      role: 'content', _csrf: ownerCsrf
    });
    assert.equal(created.status, 302);
    const editorId = adminStore.listAdmins().find((item) => item.username === 'editor').id;
    const editorCookie = await login('editor', 'another long password');
    page = await get('/admin', editorCookie);
    html = await page.text();
    assert.equal(page.status, 200);
    assert.doesNotMatch(html, /href="\/admin\/admins"/);
    allPostFormsProtected(html);
    const editorCsrf = csrf(html);
    assert.equal((await get('/admin/admins', editorCookie)).status, 403);
    assert.equal((await get('/admin/students', editorCookie)).status, 403);
    assert.equal((await post('/admin/admins', editorCookie, {
      username: 'intruder', password: 'another long password',
      role: 'superadmin', _csrf: editorCsrf
    })).status, 403);
    assert.equal((await post('/admin/version', editorCookie, {
      latestVersion: '2.0', latestBuild: '2', _csrf: editorCsrf
    })).status, 302);
    assert.ok(adminStore.listAudit().some((item) =>
      item.action === 'version.update' && item.actor_id === editorId));
    const feedbackResponse = await fetch(base + '/api/v1/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '测试反馈', content: '测试内容', deviceId: 'test-device' })
    });
    assert.equal(feedbackResponse.status, 201);
    const feedbackId = (await feedbackResponse.json()).data.id;
    assert.equal((await post('/admin/feedback/' + feedbackId + '/reply', editorCookie, {
      message: '已处理', status: 'closed', _csrf: editorCsrf
    })).status, 302);
    page = await get('/admin/feedback/' + feedbackId, editorCookie);
    assert.match(await page.text(), /editor/);
    assert.ok(adminStore.listAudit().some((item) =>
      item.action === 'feedback.reply' && item.actor_id === editorId && item.target_id === feedbackId));
    page = await get('/admin/announcements', editorCookie);
    allPostFormsProtected(await page.text());
    assert.equal((await post('/admin/announcements', editorCookie, {
      title: '测试公告', content: '公告内容', active: 'on', _csrf: editorCsrf
    })).status, 302);
    assert.ok(adminStore.listAudit().some((item) =>
      item.action === 'announcement.create' && item.actor_id === editorId));

    const issued = studentIdentityStore.createSession({ studentId: '23123456' });
    page = await get('/admin/students', ownerCookie);
    html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /23\*{4}56/);
    assert.doesNotMatch(html, /23123456/);
    const revealPath = '/admin/students/' + issued.accountId + '/reveal';
    assert.equal((await post(revealPath, editorCookie, {
      reason: 'feedback', _csrf: editorCsrf
    })).status, 403);
    assert.equal((await post(revealPath, ownerCookie, {
      reason: 'unlisted', _csrf: ownerCsrf
    })).status, 400);
    const reveal = await post(revealPath, ownerCookie, {
      reason: 'feedback', _csrf: ownerCsrf
    });
    assert.equal(reveal.status, 200);
    assert.equal(reveal.headers.get('cache-control'), 'no-store');
    assert.match(await reveal.text(), /23123456/);
    const audit = adminStore.listAudit().find((item) => item.action === 'student_id.reveal');
    assert.equal(audit.actor_id, ownerId);
    assert.equal(audit.detail, 'feedback');
    assert.equal(JSON.stringify(adminStore.listAudit()).includes('23123456'), false);

    assert.equal((await get('/admin/logout', editorCookie)).status, 302);
    assert.equal((await get('/admin', editorCookie)).status, 200);
    assert.equal((await post('/admin/admins/' + editorId + '/update', ownerCookie, {
      role: 'content', active: 'false', _csrf: ownerCsrf
    })).status, 302);
    assert.equal((await get('/admin', editorCookie)).status, 302);
    assert.equal((await get('/api/v1/bootstrap')).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    adminStore.close();
    studentIdentityStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
