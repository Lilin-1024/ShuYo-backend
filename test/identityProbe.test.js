import assert from 'node:assert/strict';
import test from 'node:test';

import { probeSchoolIdentity } from '../src/identityProbe.js';

test('reads the school identity without returning its full value', async () => {
  let target;
  let options;
  const result = await probeSchoolIdentity({
    cookieHeader: 'JSESSIONID=temporary-value',
    expectedStudentId: '23123456',
    fetchImpl: async (url, request) => {
      target = url;
      options = request;
      return new Response('<form id="form"><input value="23123456" name="xh_id"></form>');
    }
  });
  assert.equal(new URL(target).hostname, 'jwxt.shu.edu.cn');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.headers.cookie, 'JSESSIONID=temporary-value');
  assert.deepEqual(result, {
    status: 'verified',
    matchesLocal: true,
    maskedStudentId: '23****56'
  });
  assert.equal(JSON.stringify(result).includes('23123456'), false);
});

test('rejects malformed cookie input before contacting school', async () => {
  const result = await probeSchoolIdentity({
    cookieHeader: 'JSESSIONID=ok\r\nHost: example.com',
    expectedStudentId: '23123456',
    fetchImpl: () => { throw new Error('must not run'); }
  });
  assert.deepEqual(result, { status: 'invalid_cookie' });
});

test('does not follow an expired-session redirect', async () => {
  const result = await probeSchoolIdentity({
    cookieHeader: 'JSESSIONID=temporary-value',
    expectedStudentId: '23123456',
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: 'https://newsso.shu.edu.cn/oauth2/login/' }
    })
  });
  assert.deepEqual(result, { status: 'session_expired' });
});

test('finds an identity after a large page prefix and stops reading', async () => {
  const encoder = new TextEncoder();
  let canceled = false;
  const schoolResponse = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('x'.repeat(600 * 1024)));
      controller.enqueue(encoder.encode('<form id="form"><input name="xh_id" value="23123456">'));
      controller.enqueue(encoder.encode('x'.repeat(600 * 1024)));
    },
    cancel() { canceled = true; }
  }));
  const result = await probeSchoolIdentity({
    cookieHeader: 'JSESSIONID=temporary-value',
    expectedStudentId: '23123456',
    fetchImpl: async () => schoolResponse
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.matchesLocal, true);
  assert.equal(canceled, true);
});
