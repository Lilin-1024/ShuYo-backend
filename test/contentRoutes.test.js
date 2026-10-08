import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-content-routes-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.COOKIE_SECURE = 'false';
process.env.STUDENT_ID_HMAC_SECRET = '11'.repeat(32);
process.env.STUDENT_ID_ENCRYPTION_KEY = '22'.repeat(32);

const { app, adminStore, studentIdentityStore } = await import('../src/server.js');
const { readState } = await import('../src/store.js');

function cookie(response, name) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0])
    .find((value) => value.startsWith(name + '='));
}

test('public announcements and tips, ordering, deletion, markdown and image boundaries', async () => {
  adminStore.bootstrap('lilin', 'a long private password');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (route, session = '') => fetch(base + route, {
    redirect: 'manual', headers: session ? { cookie: session } : {}
  });
  const post = (route, session, fields) => fetch(base + route, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: session, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  });
  try {
    const login = await get('/admin/login');
    const loginCsrf = /name="_csrf" value="([^"]+)"/.exec(await login.text())[1];
    const loginResponse = await post('/admin/login', cookie(login, 'shuyo_admin_login_csrf'), {
      username: 'lilin', password: 'a long private password', _csrf: loginCsrf
    });
    const session = cookie(loginResponse, 'shuyo_admin_session');
    const page = await get('/admin/announcements', session);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())[1];
    assert.equal((await post('/admin/announcements', session, {
      title: '第一条', content: '旧公告', active: 'on', _csrf: csrf
    })).status, 302);
    assert.equal((await post('/admin/announcements', session, {
      title: '第二条', content: '新公告', active: 'on', _csrf: csrf
    })).status, 302);
    let state = await readState();
    const [second, first] = state.announcements;
    let data = (await (await get('/api/v1/announcements')).json()).data;
    assert.deepEqual(data.map((item) => item.title), ['第二条', '第一条']);
    assert.equal((await (await get('/api/v1/announcements/latest')).json()).data.id, second.id);
    assert.equal((await (await get('/api/v1/bootstrap')).json()).data.latestAnnouncement.id, second.id);
    assert.equal((await post('/admin/announcements/' + first.id + '/move', session, {
      direction: 'up', _csrf: csrf
    })).status, 302);
    data = (await (await get('/api/v1/announcements')).json()).data;
    assert.deepEqual(data.map((item) => item.title), ['第一条', '第二条']);
    assert.equal((await (await get('/api/v1/announcements/latest')).json()).data.id, second.id);
    assert.equal((await post('/admin/announcements/' + first.id + '/edit', session, {
      title: '第一条已改', content: '编辑后的正文', _csrf: csrf
    })).status, 302);
    assert.equal((await post('/admin/announcements/' + second.id + '/visibility', session, {
      active: 'false', _csrf: csrf
    })).status, 302);
    data = (await (await get('/api/v1/announcements')).json()).data;
    assert.deepEqual(data.map((item) => item.title), ['第一条已改']);
    const managementHtml = await (await get('/admin/announcements', session)).text();
    const publicHeading = managementHtml.indexOf('<h2>公开</h2>');
    const pendingHeading = managementHtml.indexOf('<h2>待选择</h2>');
    assert.ok(publicHeading >= 0 && pendingHeading > publicHeading);
    assert.ok(managementHtml.indexOf('第一条已改', publicHeading) < pendingHeading);
    assert.ok(managementHtml.indexOf('第二条', pendingHeading) > pendingHeading);
    assert.ok(!managementHtml.slice(publicHeading, pendingHeading)
      .includes(`/admin/announcements/${first.id}/delete`));
    assert.ok(managementHtml.slice(pendingHeading)
      .includes(`/admin/announcements/${second.id}/delete`));
    assert.equal((await post('/admin/announcements/' + first.id + '/delete', session, {
      _csrf: csrf
    })).status, 409);
    assert.equal((await post('/admin/announcements/' + second.id + '/move', session, {
      direction: 'up', _csrf: csrf
    })).status, 400);
    assert.equal((await post('/admin/announcements/' + first.id + '/visibility', session, {
      active: 'false', _csrf: csrf
    })).status, 302);
    assert.equal((await post('/admin/announcements/' + first.id + '/delete', session, {
      _csrf: csrf
    })).status, 302);
    assert.deepEqual((await (await get('/api/v1/announcements')).json()).data, []);
    assert.equal((await (await get('/api/v1/announcements/latest')).json()).data, null);
    assert.ok(adminStore.listAudit().some((entry) => entry.action === 'announcement.delete'
      && entry.target_id === first.id));

    const invalid = await post('/admin/tips', session, {
      title: '恶意图片', content: '![x](https://evil.example/x.png)', active: 'on', _csrf: csrf
    });
    assert.equal(invalid.status, 400);
    assert.equal((await readState()).tips.length, 0);
    const safeMarkdown = '# 使用方法\n\n**加粗** [官网](https://shuyo.work)';
    assert.equal((await post('/admin/tips', session, {
      title: '使用方法', content: safeMarkdown, active: 'on', _csrf: csrf
    })).status, 302);
    state = await readState();
    const tip = state.tips[0];
    assert.equal((await (await get('/api/v1/tips')).json()).data[0].content, safeMarkdown);
    assert.equal((await post('/admin/tips/' + tip.id + '/visibility', session, {
      active: 'false', _csrf: csrf
    })).status, 302);
    assert.deepEqual((await (await get('/api/v1/tips')).json()).data, []);

    const imageForm = new FormData();
    imageForm.set('_csrf', csrf);
    imageForm.set('image', new Blob([Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytAAAAABJRU5ErkJggg==',
      'base64')],
      { type: 'image/png' }), 'sample.png');
    const upload = await fetch(base + '/admin/tips/images', {
      method: 'POST', redirect: 'manual', headers: { cookie: session }, body: imageForm
    });
    assert.equal(upload.status, 302);
    const uploadedPath = new URL(upload.headers.get('location'), base).searchParams.get('image');
    assert.match(uploadedPath, /^\/api\/v1\/tips\/images\/[0-9a-f-]+\.png$/);
    assert.equal((await get(uploadedPath)).status, 404);
    assert.equal((await get(uploadedPath.replace('/api/v1/', '/admin/'), session)).status, 200);
    assert.equal((await post('/admin/tips/' + tip.id + '/edit', session, {
      title: '使用方法', content: '![示例](' + uploadedPath + ')', _csrf: csrf
    })).status, 302);
    const tipPage = await get('/admin/tips', session);
    const tipHtml = await tipPage.text();
    assert.match(tipHtml, /<img/);
    assert.match(tipHtml, /src="\/admin\/tips\/images\//);
    assert.match(tipHtml, /src="\/admin\/assets\/tip-editor\.js"/);
    assert.match(tipHtml, /<form[^>]*multipart\/form-data[^>]*><input type="hidden" name="_csrf"/);
    const script = await get('/admin/assets/tip-editor.js', session);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.match(await script.text(), /event\.preventDefault\(\)/);
    const ajaxForm = new FormData();
    ajaxForm.set('_csrf', csrf);
    ajaxForm.set('image', new Blob([Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytAAAAABJRU5ErkJggg==',
      'base64')], { type: 'image/png' }), 'second.png');
    const ajaxUpload = await fetch(base + '/admin/tips/images', {
      method: 'POST', redirect: 'manual',
      headers: { cookie: session, accept: 'application/json' },
      body: ajaxForm
    });
    assert.equal(ajaxUpload.status, 200);
    assert.match((await ajaxUpload.json()).data.url,
      /^\/api\/v1\/tips\/images\/[0-9a-f-]+\.png$/);
    assert.equal((await post('/admin/tips/' + tip.id + '/visibility', session, {
      active: 'true', _csrf: csrf
    })).status, 302);
    assert.equal((await get(uploadedPath)).status, 200);
    assert.equal((await post('/admin/tips/' + tip.id + '/visibility', session, {
      active: 'false', _csrf: csrf
    })).status, 302);
    assert.equal((await get(uploadedPath)).status, 404);
    const unsafeMarkup = await post('/admin/tips/' + tip.id + '/edit', session, {
      title: '使用方法', content: '<script>alert(1)</script>', _csrf: csrf
    });
    assert.equal(unsafeMarkup.status, 302);
    const safePage = await get('/admin/tips', session);
    assert.doesNotMatch(await safePage.text(), /<script>alert\(1\)<\/script>/);

    const missingCsrf = new FormData();
    missingCsrf.set('image', new Blob([Buffer.from('not an image')],
      { type: 'image/png' }), 'fake.png');
    const missingCsrfResult = await fetch(base + '/admin/tips/images', {
      method: 'POST', redirect: 'manual', headers: { cookie: session }, body: missingCsrf
    });
    assert.equal(missingCsrfResult.status, 403);
    const badImage = new FormData();
    badImage.set('_csrf', csrf);
    badImage.set('image', new Blob([Buffer.from('not an image')],
      { type: 'image/png' }), 'fake.png');
    const badImageResult = await fetch(base + '/admin/tips/images', {
      method: 'POST', redirect: 'manual', headers: { cookie: session }, body: badImage
    });
    assert.equal(badImageResult.status, 400);

    const stateFile = path.join(directory, 'db.json');
    writeFileSync(stateFile, '{broken json');
    await assert.rejects(readState());
    assert.equal(readFileSync(stateFile, 'utf8'), '{broken json');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    adminStore.close();
    studentIdentityStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
