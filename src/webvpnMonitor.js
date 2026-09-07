import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { dataDir, nowIso } from './store.js';

const portalUrl =
  'https://webvpn.shu.edu.cn/api/access/authentication/list?type=Login';
const academicProxyUrl =
  'https://https-jwxt-shu-edu-cn-443.webvpn.shu.edu.cn/';
const browserUserAgent =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const statusPath = path.join(dataDir, 'webvpn-status.json');
const checkIntervalMs = positiveInt(
  process.env.WEBVPN_MONITOR_INTERVAL_MS,
  60_000
);
const requestTimeoutMs = positiveInt(
  process.env.WEBVPN_MONITOR_TIMEOUT_MS,
  5_000
);
const slowThresholdMs = positiveInt(
  process.env.WEBVPN_MONITOR_SLOW_MS,
  3_000
);
const staleAfterMs = positiveInt(
  process.env.WEBVPN_MONITOR_STALE_MS,
  5 * 60_000
);
const maxRecentChecks = positiveInt(
  process.env.WEBVPN_MONITOR_HISTORY_SIZE,
  120
);

let snapshot = defaultSnapshot();
let monitorTimer = null;
let checkInFlight = null;
let writeQueue = Promise.resolve();

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultSnapshot() {
  return {
    status: 'unknown',
    checkedAt: null,
    statusSince: nowIso(),
    lastSuccessAt: null,
    latencyMs: null,
    reason: 'initializing',
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    recentChecks: []
  };
}

function normalizeSnapshot(value) {
  const defaults = defaultSnapshot();
  const allowedStatuses = new Set([
    'available',
    'degraded',
    'unavailable',
    'unknown'
  ]);
  const recentChecks = Array.isArray(value?.recentChecks)
    ? value.recentChecks.slice(-maxRecentChecks)
    : [];
  return {
    ...defaults,
    ...value,
    status: allowedStatuses.has(value?.status) ? value.status : 'unknown',
    checkedAt: value?.checkedAt ?? null,
    statusSince: value?.statusSince ?? defaults.statusSince,
    lastSuccessAt: value?.lastSuccessAt ?? null,
    latencyMs: Number.isFinite(value?.latencyMs) ? value.latencyMs : null,
    reason: String(value?.reason ?? defaults.reason),
    consecutiveSuccesses: positiveIntOrZero(value?.consecutiveSuccesses),
    consecutiveFailures: positiveIntOrZero(value?.consecutiveFailures),
    recentChecks
  };
}

function positiveIntOrZero(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function errorReason(error) {
  const name = String(error?.name ?? '').toLowerCase();
  const code = String(error?.cause?.code ?? error?.code ?? '').toUpperCase();
  if (name.includes('timeout') || name.includes('abort')) {
    return 'timeout';
  }
  if (code.includes('CERT') || code.includes('TLS') || code.includes('SSL')) {
    return 'tls_error';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'dns_error';
  }
  return 'network_error';
}

async function probePortal(fetchImpl, timeoutMs, clock) {
  const startedAt = clock();
  try {
    const response = await fetchImpl(portalUrl, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'cache-control': 'no-cache',
        origin: 'https://webvpn.shu.edu.cn',
        referer: 'https://webvpn.shu.edu.cn/auth/login',
        'user-agent': browserUserAgent
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status !== 200) {
      return {
        ok: false,
        statusCode: response.status,
        latencyMs: Math.max(0, clock() - startedAt),
        reason: 'http_error'
      };
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      return {
        ok: false,
        statusCode: response.status,
        latencyMs: Math.max(0, clock() - startedAt),
        reason:
          errorReason(error) === 'network_error'
            ? 'invalid_response'
            : errorReason(error)
      };
    }
    const latencyMs = Math.max(0, clock() - startedAt);
    const methods = Array.isArray(body?.data?.list) ? body.data.list : [];
    const oauthAvailable = methods.some(
      (item) => item && item.authType === 5 && String(item.externalId ?? '')
    );
    return {
      ok: body?.code === 0 && oauthAvailable,
      statusCode: response.status,
      latencyMs,
      reason:
        body?.code === 0 && oauthAvailable ? 'ok' : 'oauth_unavailable'
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.max(0, clock() - startedAt),
      reason: errorReason(error)
    };
  }
}

async function probeAcademicProxy(fetchImpl, timeoutMs, clock) {
  const startedAt = clock();
  try {
    const response = await fetchImpl(academicProxyUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'cache-control': 'no-cache',
        'user-agent': browserUserAgent
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const latencyMs = Math.max(0, clock() - startedAt);
    const ok = response.status >= 200 && response.status < 400;
    return {
      ok,
      statusCode: response.status,
      latencyMs,
      reason: ok ? 'ok' : 'http_error'
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.max(0, clock() - startedAt),
      reason: errorReason(error)
    };
  }
}

function sampleFromChecks(portal, academicProxy, checkedAt) {
  const latencyMs = Math.max(portal.latencyMs, academicProxy.latencyMs);
  const portalCriticalFailure = [
    'invalid_response',
    'oauth_unavailable'
  ].includes(portal.reason);
  let outcome;
  let reason;
  if (portal.ok && academicProxy.ok) {
    outcome = latencyMs >= slowThresholdMs ? 'degraded' : 'healthy';
    reason = outcome === 'healthy' ? 'ok' : 'slow';
  } else if ((!portal.ok && !academicProxy.ok) || portalCriticalFailure) {
    outcome = 'failed';
    reason = portalCriticalFailure
      ? portal.reason
      : portal.reason !== 'ok'
        ? portal.reason
        : academicProxy.reason;
  } else {
    outcome = 'degraded';
    reason = 'partial_failure';
  }
  return {
    checkedAt,
    outcome,
    reason,
    latencyMs,
    portal,
    academicProxy
  };
}

function nextSnapshot(previousValue, sample) {
  const previous = normalizeSnapshot(previousValue);
  let status = 'degraded';
  let consecutiveSuccesses = 0;
  let consecutiveFailures = 0;
  let lastSuccessAt = previous.lastSuccessAt;

  if (sample.outcome === 'healthy') {
    consecutiveSuccesses = previous.consecutiveSuccesses + 1;
    lastSuccessAt = sample.checkedAt;
    status =
      previous.status === 'unavailable' && consecutiveSuccesses < 2
        ? 'degraded'
        : 'available';
  } else if (sample.outcome === 'failed') {
    consecutiveFailures = previous.consecutiveFailures + 1;
    status = consecutiveFailures >= 2 ? 'unavailable' : 'degraded';
  }

  const statusSince =
    status === previous.status ? previous.statusSince : sample.checkedAt;
  return {
    status,
    checkedAt: sample.checkedAt,
    statusSince,
    lastSuccessAt,
    latencyMs: sample.latencyMs,
    reason: sample.reason,
    consecutiveSuccesses,
    consecutiveFailures,
    recentChecks: [...previous.recentChecks, sample].slice(-maxRecentChecks)
  };
}

async function performWebVpnCheck({
  fetchImpl = fetch,
  clock = Date.now,
  timeoutMs = requestTimeoutMs
} = {}) {
  const checkedAt = new Date(clock()).toISOString();
  const [portal, academicProxy] = await Promise.all([
    probePortal(fetchImpl, timeoutMs, clock),
    probeAcademicProxy(fetchImpl, timeoutMs, clock)
  ]);
  return sampleFromChecks(portal, academicProxy, checkedAt);
}

async function loadSnapshot() {
  try {
    const raw = await readFile(statusPath, 'utf8');
    snapshot = normalizeSnapshot(JSON.parse(raw));
  } catch {
    snapshot = defaultSnapshot();
  }
  return snapshot;
}

async function persistSnapshot(value) {
  const task = writeQueue.then(async () => {
    await mkdir(dataDir, { recursive: true });
    const temporary = `${statusPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, statusPath);
  });
  writeQueue = task.catch(() => {});
  return task;
}

async function refreshWebVpnStatus(options) {
  if (checkInFlight) {
    return checkInFlight;
  }
  checkInFlight = (async () => {
    const sample = await performWebVpnCheck(options);
    snapshot = nextSnapshot(snapshot, sample);
    await persistSnapshot(snapshot);
    console.log(
      `[webvpn-monitor] status=${snapshot.status} reason=${snapshot.reason} ` +
        `latencyMs=${snapshot.latencyMs}`
    );
    return snapshot;
  })().finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

function publicWebVpnStatus(value = snapshot, now = Date.now()) {
  const checkedAtMs = Date.parse(value?.checkedAt ?? '');
  const stale =
    !Number.isFinite(checkedAtMs) || now - checkedAtMs > staleAfterMs;
  return {
    status: stale ? 'unknown' : value.status,
    checkedAt: value.checkedAt,
    statusSince: value.statusSince,
    lastSuccessAt: value.lastSuccessAt,
    latencyMs: value.latencyMs,
    reason: stale ? 'stale' : value.reason
  };
}

async function initializeWebVpnMonitor() {
  await loadSnapshot();
  void refreshWebVpnStatus().catch((error) => {
    console.error('[webvpn-monitor] initial check failed', error);
  });
  if (!monitorTimer) {
    monitorTimer = setInterval(() => {
      void refreshWebVpnStatus().catch((error) => {
        console.error('[webvpn-monitor] scheduled check failed', error);
      });
    }, checkIntervalMs);
    monitorTimer.unref();
  }
}

function stopWebVpnMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

export {
  academicProxyUrl,
  initializeWebVpnMonitor,
  nextSnapshot,
  performWebVpnCheck,
  portalUrl,
  publicWebVpnStatus,
  refreshWebVpnStatus,
  sampleFromChecks,
  stopWebVpnMonitor
};
