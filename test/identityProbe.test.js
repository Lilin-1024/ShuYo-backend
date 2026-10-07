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
