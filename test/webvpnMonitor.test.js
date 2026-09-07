import test from 'node:test';
import assert from 'node:assert/strict';

import {
  academicProxyUrl,
  nextSnapshot,
  performWebVpnCheck,
  portalUrl,
  publicWebVpnStatus,
  sampleFromChecks
} from '../src/webvpnMonitor.js';

function check({ ok, reason = ok ? 'ok' : 'timeout', latencyMs = 100 }) {
  return {
    ok,
    statusCode: ok ? 200 : null,
    latencyMs,
    reason
  };
}

function sample(outcome, checkedAt) {
  const healthy = outcome === 'healthy';
  return {
    checkedAt,
    outcome,
    reason: healthy ? 'ok' : 'timeout',
    latencyMs: healthy ? 100 : 5000,
    portal: check({ ok: healthy }),
    academicProxy: check({ ok: healthy })
  };
}

test('checks both WebVPN entry points and validates the OAuth method', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url === portalUrl) {
      return {
        status: 200,
        json: async () => ({
          code: 0,
          data: { list: [{ authType: 5, externalId: 'shu-oauth' }] }
        })
      };
    }
    return { status: 302 };
  };

  const result = await performWebVpnCheck({
    fetchImpl,
    clock: () => 0,
    timeoutMs: 50
  });

  assert.deepEqual(new Set(requested), new Set([portalUrl, academicProxyUrl]));
  assert.equal(result.outcome, 'healthy');
  assert.equal(result.reason, 'ok');
});

test('treats a missing campus OAuth method as a failed check', () => {
  const result = sampleFromChecks(
    check({ ok: false, reason: 'oauth_unavailable' }),
    check({ ok: true }),
    '2026-09-07T12:00:00.000Z'
  );

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'oauth_unavailable');
});

test('requires two failures before reporting an outage', () => {
  const first = nextSnapshot(
    null,
    sample('failed', '2026-09-07T12:00:00.000Z')
  );
  const second = nextSnapshot(
    first,
    sample('failed', '2026-09-07T12:01:00.000Z')
  );

  assert.equal(first.status, 'degraded');
  assert.equal(second.status, 'unavailable');
  assert.equal(second.consecutiveFailures, 2);
});

test('requires two successes to recover from an outage', () => {
  const unavailable = {
    ...nextSnapshot(null, sample('failed', '2026-09-07T12:00:00.000Z')),
    status: 'unavailable',
    consecutiveFailures: 2
  };
  const first = nextSnapshot(
    unavailable,
    sample('healthy', '2026-09-07T12:02:00.000Z')
  );
  const second = nextSnapshot(
    first,
    sample('healthy', '2026-09-07T12:03:00.000Z')
  );

  assert.equal(first.status, 'degraded');
  assert.equal(second.status, 'available');
});

test('publishes stale monitoring data as unknown', () => {
  const value = {
    status: 'available',
    checkedAt: '2026-09-07T12:00:00.000Z',
    statusSince: '2026-09-07T12:00:00.000Z',
    lastSuccessAt: '2026-09-07T12:00:00.000Z',
    latencyMs: 120,
    reason: 'ok'
  };

  const result = publicWebVpnStatus(
    value,
    Date.parse('2026-09-07T12:06:00.000Z')
  );

  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'stale');
});
