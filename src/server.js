import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';

import {
  createAdminAuth
} from './auth.js';
import { AdminStore } from './adminStore.js';
import { createRateLimit } from './rateLimit.js';
import { fetchSchoolStudentId, maskedStudentId } from './identityProbe.js';
import { StudentIdentityStore } from './studentIdentityStore.js';
import { startTipImageCleanup } from './tipImageCleanup.js';
import {
  imageType, latestAnnouncement, moveItem, nextSortOrder, ordered,
  publicItems, renderTipMarkdown, validateTipMarkdown
} from './publishedContent.js';
import { dataDir, hashToken, makeId, mutateState, nowIso, readState } from './store.js';
import {
  initializeWebVpnMonitor,
  publicWebVpnStatus
} from './webvpnMonitor.js';
import {
  renderAccountPage,
  renderAdminListPage,
  renderAuditPage,
  renderDashboard,
  renderFeedbackDetail,
  renderFeedbackListPage,
  renderVersionPage,
  renderLoginPage,
  renderStudentListPage,
  renderStudentRevealPage
} from './views.js';
import { renderContentListPage } from './contentViews.js';

if (process.env.NODE_ENV === 'production') {
  for (const name of ['COOKIE_SECRET', 'PRESENCE_HMAC_SECRET']) {
    const value = process.env[name]?.trim();
    if (!value || value === 'change-me' || value.startsWith('change-this-')) {
      throw new Error(`${name} must be configured before starting in production`);
    }
  }
}

process.umask(0o077);

const app = express();
const port = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const adminStore = new AdminStore({ filename: dataDir + '/admins.sqlite' });
const {
  currentAdmin, requireAdmin, requireSuperadmin, requireCsrf,
  createLoginCsrf, checkLoginCsrf, clearLoginCsrf, registerSession, clearSession
} = createAdminAuth(adminStore);
const studentIdentityStore = new StudentIdentityStore({
  filename: `${dataDir}/accounts.sqlite`,
  hmacSecret: process.env.STUDENT_ID_HMAC_SECRET,
  encryptionKey: process.env.STUDENT_ID_ENCRYPTION_KEY
});
const tipImageDir = path.join(dataDir, 'tip-images');
const tipEditorScript = fileURLToPath(new URL('./adminTipEditor.js', import.meta.url));
const tipImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 2, parts: 3 }
});
const tipImageRateLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: '图片上传过于频繁，请稍后再试。'
});

function receiveTipImage(req, res, next) {
  tipImageUpload.single('image')(req, res, (error) => {
    if (!error) { next(); return; }
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .type('text').send('图片上传失败，请检查文件大小和格式。');
  });
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
morgan.token('safe-url', (req) => {
  const originalUrl = req.originalUrl ?? req.url ?? '';
  try {
    const url = new URL(originalUrl, 'http://localhost');
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().includes('token')) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return originalUrl.replace(
      /([?&][^=&]*token[^=&]*=)[^&]*/gi,
      '$1[redacted]'
    );
  }
});
app.use(
  morgan(
    ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'
  )
);
app.use(cookieParser(process.env.COOKIE_SECRET ?? 'change-this-cookie-secret'));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
// Body-parser errors may contain the raw request body. Never print a school
// session value, even when a malformed identity request cannot reach its route.
app.use((error, req, res, next) => {
  if (!req.path.startsWith('/api/v1/student/') && !req.path.startsWith('/admin')) return next(error);
  res.setHeader('Cache-Control', 'no-store');
  if (req.path.startsWith('/admin')) {
    res.status(400).type('text').send('请求格式无效。');
    return;
  }
  res.status(400).json({ success: false, error: '请求格式无效。' });
});

const feedbackRateLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: '反馈提交过于频繁，请稍后再试。'
});

const presenceRateLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: '统计请求过于频繁，请稍后再试。'
});

const loginRateLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: '登录尝试过于频繁，请稍后再试。'
});

const studentEnrollmentRateLimit = createRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  message: '身份核验过于频繁，请稍后再试。'
});

function studentToken(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.get('authorization') ?? '');
  return match?.[1] ?? null;
}

function requireStudentSession(req, res, next) {
  const session = studentIdentityStore.getSession(studentToken(req));
  if (!session) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({ success: false, error: 'ShuYo 身份已失效，请重新核验。' });
    return;
  }
  req.studentSession = session;
  next();
}

function jsonEtag(value) {
  return `"${crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex')}"`;
}

function sendCachedJson(req, res, payload, maxAgeSeconds = 60) {
  const etag = jsonEtag(payload);
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
  res.setHeader('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  res.json(payload);
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function trimText(value) {
  return String(value ?? '').trim();
}

function validateLength(value, max, label) {
  if (value.length > max) {
    throw new Error(`${label} 不能超过 ${max} 个字符`);
  }
}

function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function presenceAccountKey(userId) {
  const secret = process.env.PRESENCE_HMAC_SECRET ?? process.env.COOKIE_SECRET ?? 'change-this-presence-secret';
  return crypto.createHmac('sha256', secret).update(String(userId)).digest('hex');
}

function presenceStats(state) {
  const today = shanghaiDateKey();
  const now = Date.now();
  const countSince = (days) => {
    const cutoff = new Date(now - (days - 1) * 24 * 60 * 60 * 1000);
    const cutoffKey = shanghaiDateKey(cutoff);
    return Object.values(state.presence ?? {}).filter((item) =>
      Array.isArray(item.activeDates) && item.activeDates.some((day) => day >= cutoffKey && day <= today)
    ).length;
  };
  return {
    active1d: countSince(1),
    active3d: countSince(3),
    active7d: countSince(7),
    total: Object.keys(state.presence ?? {}).length
  };
}

function selectLatestAnnouncement(announcements) {
  return latestAnnouncement(announcements);
}

function publicAnnouncement(item) {
  if (!item) {
    return null;
  }

  return {
    id: item.id,
    title: item.title,
    content: item.content,
    active: item.active !== false,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function publicFeedback(item) {
  return {
    id: item.id,
    title: item.title,
    content: item.content,
    contact: item.contact ?? '',
    deviceId: item.deviceId ?? '',
    appVersion: item.appVersion ?? '',
    platform: item.platform ?? '',
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    replies: (item.replies ?? []).map((reply) => ({
      id: reply.id,
      author: reply.author,
      message: reply.message,
      createdAt: reply.createdAt
    }))
  };
}

function isFeedbackDeviceBlocked(state, deviceId) {
  const normalized = trimText(deviceId);
  if (!normalized) {
    return false;
  }
  return (state.blockedFeedbackDevices ?? []).some(
    (item) => item.deviceId === normalized
  );
}

function publicVersionPayload(state) {
  const latestAnnouncement = selectLatestAnnouncement(state.announcements);
  return {
    success: true,
    data: {
      appName: state.meta.appName,
      latestVersion: state.meta.latestVersion,
      latestBuild: state.meta.latestBuild,
      forceUpdate: state.meta.forceUpdate,
      updateTitle: state.meta.updateTitle,
      updateMessage: state.meta.updateMessage,
      downloadUrl: state.meta.downloadUrl,
      noticeText: state.meta.noticeText,
      publishedAt: state.meta.publishedAt,
      updatedAt: state.meta.updatedAt,
      announcement: publicAnnouncement(latestAnnouncement)
    }
  };
}

function adminRedirectWithMessage(res, path, message) {
  const safePath = String(path ?? '').startsWith('/admin') ? String(path) : '/admin';
  const separator = safePath.includes('?') ? '&' : '?';
  res.redirect(`${safePath}${separator}message=${encodeURIComponent(message)}`);
}

function contentRouteError(error, res, next) {
  if (error instanceof Error && /^(标题|正文|提示正文|图片)/.test(error.message)) {
    res.status(400).type('text').send(error.message);
  } else {
    next(error);
  }
}

async function getFeedbackById(id) {
  const state = await readState();
  return {
    state,
    item: state.feedback.find((feedback) => feedback.id === id) ?? null
  };
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'lehu-update-feedback-server',
    time: nowIso()
  });
});

app.post('/api/v1/student/sessions', studentEnrollmentRateLimit, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const expectedStudentId = String(req.body?.expectedStudentId ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,24}$/.test(expectedStudentId)) {
    res.status(400).json({ success: false, error: '本机学号无效。' });
    return;
  }
  const identity = await fetchSchoolStudentId({ cookieHeader: req.body?.schoolCookie });
  if (identity.status !== 'verified') {
    const code = {
      invalid_cookie: 400,
      session_expired: 401,
      school_rejected: 403,
      no_student_id: 422
    }[identity.status] ?? 503;
    res.status(code).json({ success: false, code: identity.status,
      error: '暂时无法通过学校核实学号。' });
    return;
  }
  if (identity.studentId.toUpperCase() !== expectedStudentId) {
    res.status(409).json({ success: false, code: 'student_mismatch',
      data: { maskedStudentId: maskedStudentId(identity.studentId) },
      error: '学校返回的学号与本机账户不一致。' });
    return;
  }
  const session = studentIdentityStore.createSession({
    studentId: identity.studentId,
    deviceLabel: req.body?.deviceLabel,
    previousToken: studentToken(req)
  });
  res.status(201).json({ success: true, data: session });
});

app.get('/api/v1/student/session', requireStudentSession, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = req.studentSession;
  res.json({ success: true, data: {
    accountId: session.account_id,
    sessionId: session.id,
    maskedStudentId: session.student_id_masked,
    expiresAt: session.expires_at
  } });
});

app.get('/api/v1/student/sessions', requireStudentSession, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: studentIdentityStore.listSessions(req.studentSession.account_id) });
});

app.delete('/api/v1/student/session', requireStudentSession, (req, res) => {
  studentIdentityStore.revokeSession(studentToken(req));
  res.status(204).end();
});

app.post('/api/v1/student/sessions/revoke-all', requireStudentSession, (req, res) => {
  studentIdentityStore.revokeAllSessions(req.studentSession.account_id);
  res.status(204).end();
});

app.delete('/api/v1/student/account', requireStudentSession, (req, res) => {
  studentIdentityStore.deleteAccount(req.studentSession.account_id);
  res.status(204).end();
});

app.get('/api/v1/version', async (req, res, next) => {
  try {
    const state = await readState();
    sendCachedJson(req, res, publicVersionPayload(state), 120);
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/announcements/latest', async (req, res, next) => {
  try {
    const state = await readState();
    const latest = selectLatestAnnouncement(state.announcements);
    sendCachedJson(
      req,
      res,
      {
        success: true,
        data: publicAnnouncement(latest)
      },
      300
    );
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/announcements', async (req, res, next) => {
  try {
    const state = await readState();
    sendCachedJson(req, res, {
      success: true,
      data: publicItems(state.announcements).map(publicAnnouncement)
    }, 0);
  } catch (error) { next(error); }
});

app.get('/api/v1/tips', async (req, res, next) => {
  try {
    const state = await readState();
    sendCachedJson(req, res, {
      success: true,
      data: publicItems(state.tips).map(({ id, title, content, createdAt, updatedAt }) =>
        ({ id, title, content, createdAt, updatedAt }))
    }, 0);
  } catch (error) { next(error); }
});

function sendTipImage(req, res, { publicImage }) {
  const filename = String(req.params.filename ?? '');
  if (!/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(filename)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', publicImage ? 'public, max-age=0, must-revalidate' : 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filename, { root: tipImageDir }, (error) => {
    if (error && !res.headersSent) res.status(error.statusCode ?? 404).end();
  });
}

app.get('/api/v1/tips/images/:filename', async (req, res, next) => {
  try {
    const filename = String(req.params.filename ?? '');
    if (!/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(filename)) {
      res.status(404).end();
      return;
    }
    const pathInMarkdown = `/api/v1/tips/images/${filename}`;
    const state = await readState();
    if (!state.tips.some((item) => !item.deletedAt && item.active !== false &&
        item.content.includes(pathInMarkdown))) {
      res.status(404).end();
      return;
    }
    sendTipImage(req, res, { publicImage: true });
  } catch (error) { next(error); }
});

app.get('/api/v1/service-status/webvpn', (req, res) => {
  sendCachedJson(
    req,
    res,
    {
      success: true,
      data: publicWebVpnStatus()
    },
    30
  );
});

app.get('/api/v1/bootstrap', async (req, res, next) => {
  try {
    const state = await readState();
    sendCachedJson(
      req,
      res,
      {
        success: true,
        data: {
          version: publicVersionPayload(state).data,
          latestAnnouncement: publicAnnouncement(selectLatestAnnouncement(state.announcements)),
          webVpnStatus: publicWebVpnStatus()
        }
      },
      30
    );
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/feedback', feedbackRateLimit, async (req, res, next) => {
  try {
    const title = trimText(req.body.title ?? '');
    const content = trimText(req.body.content ?? '');
    const contact = trimText(req.body.contact ?? '');
    const deviceId = trimText(req.body.deviceId ?? '');
    const appVersion = trimText(req.body.appVersion ?? '');
    const platform = trimText(req.body.platform ?? '');

    if (!content) {
      res.status(400).json({
        success: false,
        error: '反馈内容不能为空。'
      });
      return;
    }

    validateLength(title, 120, '标题');
    validateLength(content, 4000, '内容');
    validateLength(contact, 120, '联系方式');
    validateLength(deviceId, 120, '设备标识');
    validateLength(appVersion, 60, '客户端版本');
    validateLength(platform, 60, '平台信息');

    const state = await readState();
    if (isFeedbackDeviceBlocked(state, deviceId)) {
      res.status(403).json({
        success: false,
        error: '该设备暂无法提交反馈。'
      });
      return;
    }

    const createdAt = nowIso();
    const lookupToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = hashToken(lookupToken);
    const feedback = {
      id: makeId('fb'),
      tokenHash,
      title: title || '未命名反馈',
      content,
      contact,
      deviceId,
      appVersion,
      platform,
      status: 'open',
      createdAt,
      updatedAt: createdAt,
      replies: []
    };

    await mutateState((state) => {
      state.feedback.unshift(feedback);
    });

    res.status(201).json({
      success: true,
      data: {
        id: feedback.id,
        lookupToken,
        status: feedback.status,
        createdAt: feedback.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/presence/heartbeat', presenceRateLimit, async (req, res, next) => {
  try {
    const userId = Number.parseInt(String(req.body.userId ?? ''), 10);
    const installationId = trimText(req.body.installationId ?? '');
    const appVersion = trimText(req.body.appVersion ?? '');
    const platform = trimText(req.body.platform ?? '');
    if (!Number.isSafeInteger(userId) || userId <= 0 || !installationId) {
      res.status(400).json({ success: false, error: '统计参数无效。' });
      return;
    }
    validateLength(installationId, 120, '安装标识');
    validateLength(appVersion, 60, '客户端版本');
    validateLength(platform, 60, '平台信息');

    const today = shanghaiDateKey();
    const accountKey = presenceAccountKey(userId);
    await mutateState((state) => {
      state.presence = state.presence && typeof state.presence === 'object' ? state.presence : {};
      const previous = state.presence[accountKey] ?? {};
      const activeDates = Array.isArray(previous.activeDates) ? previous.activeDates : [];
      if (!activeDates.includes(today)) activeDates.push(today);
      activeDates.sort();
      state.presence[accountKey] = {
        firstSeenAt: previous.firstSeenAt ?? nowIso(),
        lastSeenAt: nowIso(),
        activeDates: activeDates.slice(-7),
        installationKey: crypto.createHash('sha256').update(installationId).digest('hex'),
        appVersion,
        platform
      };
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/feedback/:id', async (req, res, next) => {
  try {
    const { item } = await getFeedbackById(req.params.id);
    if (!item) {
      res.status(404).json({
        success: false,
        error: '未找到反馈。'
      });
      return;
    }

    const token =
      trimText(req.query.token ?? '') ||
      trimText(req.get('x-feedback-token') ?? '') ||
      trimText((req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));

    if (!token || hashToken(token) !== item.tokenHash) {
      res.status(403).json({
        success: false,
        error: '验证失败。'
      });
      return;
    }

    res.json({
      success: true,
      data: publicFeedback(item)
    });
  } catch (error) {
    next(error);
  }
});

app.use('/admin', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST' && req.path === '/tips/images') {
    requireAdmin(req, res, next);
    return;
  }
  if (req.method === 'POST' && req.path !== '/login') {
    requireAdmin(req, res, () => requireCsrf(req, res, next));
    return;
  }
  next();
});

app.get('/admin/login', (req, res) => {
  if (currentAdmin(req)) {
    res.redirect('/admin');
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(renderLoginPage({ csrfToken: createLoginCsrf(res) }));
});

app.post('/admin/login', loginRateLimit, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkLoginCsrf(req)) {
    res.status(403).send(renderLoginPage({
      errorMessage: '页面已过期，请刷新后重试。',
      csrfToken: createLoginCsrf(res)
    }));
    return;
  }
  const username = trimText(req.body.username ?? '');
  const password = String(req.body.password ?? '');
  const admin = adminStore.authenticate(username, password);
  if (!admin) {
    res.status(401).send(renderLoginPage({
      errorMessage: '登录名或密码错误。',
      csrfToken: createLoginCsrf(res)
    }));
    return;
  }

  clearLoginCsrf(res);
  registerSession(res, admin.id);
  res.redirect('/admin');
});

app.post('/admin/logout', requireAdmin, requireCsrf, (req, res) => {
  clearSession(req, res);
  res.redirect('/admin/login');
});

app.get('/admin/logout', (req, res) => {
  res.redirect('/admin');
});

app.get('/admin/account', requireAdmin, (req, res) => {
  res.send(renderAccountPage({
    admin: req.admin, csrfToken: res.locals.csrfToken,
    message: trimText(req.query.message ?? '')
  }));
});

app.post('/admin/account/password', requireAdmin, (req, res) => {
  try {
    adminStore.changeOwnPassword(req.admin.id, req.body.currentPassword, req.body.newPassword);
    res.clearCookie('shuyo_admin_session', { path: '/admin' });
    res.redirect('/admin/login');
  } catch (error) {
    res.status(400).send(renderAccountPage({
      admin: req.admin, csrfToken: res.locals.csrfToken,
      message: error.message
    }));
  }
});

app.get('/admin/admins', requireAdmin, requireSuperadmin, (req, res) => {
  res.send(renderAdminListPage({
    admins: adminStore.listAdmins(), admin: req.admin,
    csrfToken: res.locals.csrfToken, message: trimText(req.query.message ?? '')
  }));
});

app.post('/admin/admins', requireAdmin, requireSuperadmin, (req, res) => {
  try {
    adminStore.createAdmin(req.admin.id, req.body.username, req.body.password, req.body.role);
    res.redirect('/admin/admins?message=' + encodeURIComponent('管理员已创建。'));
  } catch (error) {
    res.status(400).send(renderAdminListPage({
      admins: adminStore.listAdmins(), admin: req.admin,
      csrfToken: res.locals.csrfToken, message: error.message
    }));
  }
});

app.post('/admin/admins/:id/update', requireAdmin, requireSuperadmin, (req, res) => {
  try {
    adminStore.updateAdmin(req.admin.id, req.params.id, {
      role: req.body.role, active: req.body.active === 'true'
    });
    res.redirect('/admin/admins?message=' + encodeURIComponent('管理员设置已保存。'));
  } catch (error) {
    res.status(400).send(renderAdminListPage({
      admins: adminStore.listAdmins(), admin: req.admin,
      csrfToken: res.locals.csrfToken, message: error.message
    }));
  }
});

app.post('/admin/admins/:id/password', requireAdmin, requireSuperadmin, (req, res) => {
  try {
    adminStore.resetPassword(req.admin.id, req.params.id, req.body.password);
    res.redirect('/admin/admins?message=' + encodeURIComponent('密码已重设，旧会话已退出。'));
  } catch (error) {
    res.status(400).send(renderAdminListPage({
      admins: adminStore.listAdmins(), admin: req.admin,
      csrfToken: res.locals.csrfToken, message: error.message
    }));
  }
});

app.get('/admin/students', requireAdmin, requireSuperadmin, (req, res) => {
  const accountId = trimText(req.query.accountId ?? '');
  const account = accountId ? studentIdentityStore.getAccount(accountId) : null;
  res.send(renderStudentListPage({
    accounts: accountId ? (account ? [account] : []) : studentIdentityStore.listAccounts(),
    accountId,
    admin: req.admin, csrfToken: res.locals.csrfToken
  }));
});

app.post('/admin/students/:id/reveal', requireAdmin, requireSuperadmin, (req, res) => {
  const reasons = new Set(['feedback', 'appeal', 'security']);
  const reason = trimText(req.body.reason);
  if (!reasons.has(reason)) {
    res.status(400).send('请选择查看原因。');
    return;
  }
  const account = studentIdentityStore.getAccount(req.params.id);
  if (!account) {
    res.status(404).send('学生账户不存在。');
    return;
  }
  const studentId = studentIdentityStore.getStudentId(account.id);
  adminStore.audit(req.admin.id, 'student_id.reveal', 'student_account', account.id, reason);
  res.send(renderStudentRevealPage({
    account, studentId, admin: req.admin, csrfToken: res.locals.csrfToken
  }));
});

app.get('/admin/audit', requireAdmin, requireSuperadmin, (req, res) => {
  res.send(renderAuditPage({
    entries: adminStore.listAudit(), admin: req.admin,
    csrfToken: res.locals.csrfToken
  }));
});

app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const state = await readState();
    const feedbackItems = [...state.feedback].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const announcementItems = ordered(state.announcements.filter((item) => !item.deletedAt));
    const presence = presenceStats(state);

    res.status(200).send(
      renderDashboard({
        state,
        feedbackItems,
        announcementItems,
        presence,
        webVpnStatus: publicWebVpnStatus(),
        message: trimText(req.query.message ?? ''),
        csrfToken: res.locals.csrfToken,
        admin: req.admin
      })
    );
  } catch (error) {
    next(error);
  }
});

app.get('/admin/version', requireAdmin, async (req, res, next) => {
  try {
    const state = await readState();
    res.status(200).send(renderVersionPage({
      state,
      message: trimText(req.query.message ?? ''),
      csrfToken: res.locals.csrfToken,
      admin: req.admin
    }));
  } catch (error) {
    next(error);
  }
});

function registerContentRoutes(route, key, label) {
  const auditName = key === 'tips' ? 'tip' : 'announcement';
  app.get(route, requireAdmin, async (req, res, next) => {
    try {
      const state = await readState();
      res.send(renderContentListPage({
        kind: key, label,
        items: ordered(state[key].filter((item) => !item.deletedAt)),
        message: trimText(req.query.message ?? ''),
        image: key === 'tips' ? trimText(req.query.image ?? '') : '',
        csrfToken: res.locals.csrfToken,
        admin: req.admin,
        renderMarkdown: renderTipMarkdown
      }));
    } catch (error) { next(error); }
  });

  app.post(route, requireAdmin, async (req, res, next) => {
    try {
      const title = trimText(req.body.title);
      const content = trimText(req.body.content);
      const active = isTruthy(req.body.active);
      if (!title || !content) { res.status(400).send('标题和正文不能为空。'); return; }
      validateLength(title, 160, '标题');
      validateLength(content, key === 'tips' ? 12000 : 4000, '正文');
      if (key === 'tips') validateTipMarkdown(content);
      const id = makeId(key === 'tips' ? 'tip' : 'ann');
      await mutateState((state) => {
        state[key].unshift({
          id, title, content, active,
          sortOrder: active ? nextSortOrder(publicItems(state[key])) : 0,
          createdAt: nowIso(), updatedAt: nowIso()
        });
      });
      adminStore.audit(req.admin.id, `${auditName}.create`, auditName, id, active ? 'public' : 'private');
      adminRedirectWithMessage(res, route, `${label}已创建。`);
    } catch (error) { contentRouteError(error, res, next); }
  });

  app.post(`${route}/:id/edit`, requireAdmin, async (req, res, next) => {
    try {
      const title = trimText(req.body.title);
      const content = trimText(req.body.content);
      if (!title || !content) { res.status(400).send('标题和正文不能为空。'); return; }
      validateLength(title, 160, '标题');
      validateLength(content, key === 'tips' ? 12000 : 4000, '正文');
      if (key === 'tips') validateTipMarkdown(content);
      const updated = await mutateState((state) => {
        const item = state[key].find((entry) => entry.id === req.params.id && !entry.deletedAt);
        if (!item) return false;
        item.title = title;
        item.content = content;
        item.updatedAt = nowIso();
        return true;
      });
      if (!updated) { res.status(404).send('内容不存在。'); return; }
      adminStore.audit(req.admin.id, `${auditName}.edit`, auditName, req.params.id);
      adminRedirectWithMessage(res, route, `${label}已保存。`);
    } catch (error) { contentRouteError(error, res, next); }
  });

  app.post(`${route}/:id/visibility`, requireAdmin, async (req, res, next) => {
    try {
      const active = isTruthy(req.body.active);
      const updated = await mutateState((state) => {
        const item = state[key].find((entry) => entry.id === req.params.id && !entry.deletedAt);
        if (!item) return false;
        if (active && item.active === false) {
          item.sortOrder = nextSortOrder(publicItems(state[key]));
        }
        item.active = active;
        item.updatedAt = nowIso();
        return true;
      });
      if (!updated) { res.status(404).send('内容不存在。'); return; }
      adminStore.audit(req.admin.id, `${auditName}.visibility`, auditName, req.params.id, active ? 'public' : 'private');
      adminRedirectWithMessage(res, route, active ? '已公开。' : '已撤回到待选择。');
    } catch (error) { next(error); }
  });

  app.post(`${route}/:id/move`, requireAdmin, async (req, res, next) => {
    try {
      const direction = trimText(req.body.direction);
      if (!['up', 'down'].includes(direction)) { res.status(400).send('排序方向无效。'); return; }
      const moved = await mutateState((state) => moveItem(state[key], req.params.id, direction));
      if (!moved) { res.status(400).send('无法移动到该位置。'); return; }
      adminStore.audit(req.admin.id, `${auditName}.move`, auditName, req.params.id, direction);
      adminRedirectWithMessage(res, route, '顺序已调整。');
    } catch (error) { next(error); }
  });

  app.post(`${route}/:id/delete`, requireAdmin, async (req, res, next) => {
    try {
      const deleted = await mutateState((state) => {
        const item = state[key].find((entry) => entry.id === req.params.id && !entry.deletedAt);
        if (!item) return false;
        if (item.active !== false) return 'public';
        item.deletedAt = nowIso();
        item.active = false;
        return true;
      });
      if (deleted === 'public') { res.status(409).send('请先撤回到待选择，再删除。'); return; }
      if (!deleted) { res.status(404).send('内容不存在。'); return; }
      adminStore.audit(req.admin.id, `${auditName}.delete`, auditName, req.params.id);
      adminRedirectWithMessage(res, route, `${label}已删除。`);
    } catch (error) { next(error); }
  });
}

registerContentRoutes('/admin/announcements', 'announcements', '公告');
registerContentRoutes('/admin/tips', 'tips', '使用提示');

app.get('/admin/assets/tip-editor.js', requireAdmin, (req, res) => {
  res.type('application/javascript').sendFile(tipEditorScript);
});

app.get('/admin/tips/images/:filename', requireAdmin, (req, res) => {
  sendTipImage(req, res, { publicImage: false });
});

app.post('/admin/tips/images', requireAdmin, tipImageRateLimit, receiveTipImage, requireCsrf,
  async (req, res, next) => {
    try {
      if (!req.file) { res.status(400).send('请选择图片。'); return; }
      const extension = imageType(req.file.buffer);
      if (!extension) { res.status(400).send('只支持 PNG、JPEG 或 WebP 图片。'); return; }
      await mkdir(tipImageDir, { recursive: true });
      const filename = `${crypto.randomUUID()}.${extension}`;
      await writeFile(path.join(tipImageDir, filename), req.file.buffer, { flag: 'wx', mode: 0o600 });
      adminStore.audit(req.admin.id, 'tips.image_upload', 'tip_image', filename);
      const imageUrl = `/api/v1/tips/images/${filename}`;
      if ((req.get('accept') ?? '').includes('application/json')) {
        res.json({ success: true, data: { url: imageUrl } });
      } else {
        res.redirect('/admin/tips?image=' + encodeURIComponent(imageUrl));
      }
    } catch (error) { next(error); }
  });

app.get('/admin/feedback', requireAdmin, async (req, res, next) => {
  try {
    const state = await readState();
    const feedbackItems = [...state.feedback].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    res.status(200).send(
      renderFeedbackListPage({
        state,
        feedbackItems,
        message: trimText(req.query.message ?? ''),
        csrfToken: res.locals.csrfToken,
        admin: req.admin
      })
    );
  } catch (error) {
    next(error);
  }
});

app.post('/admin/version', requireAdmin, async (req, res, next) => {
  try {
    const appName = trimText(req.body.appName ?? '');
    const latestVersion = trimText(req.body.latestVersion ?? '');
    const latestBuild = Number.parseInt(String(req.body.latestBuild ?? ''), 10);
    const updateTitle = trimText(req.body.updateTitle ?? '');
    const updateMessage = trimText(req.body.updateMessage ?? '');
    const downloadUrl = trimText(req.body.downloadUrl ?? '');
    const noticeText = trimText(req.body.noticeText ?? '');
    const forceUpdate = isTruthy(req.body.forceUpdate);

    if (!latestVersion) {
      res.status(400).send('版本号不能为空。');
      return;
    }

    if (!Number.isFinite(latestBuild) || latestBuild < 1) {
      res.status(400).send('Build 号必须是正整数。');
      return;
    }

    await mutateState((state) => {
      state.meta.appName = appName || state.meta.appName;
      state.meta.latestVersion = latestVersion;
      state.meta.latestBuild = latestBuild;
      state.meta.forceUpdate = forceUpdate;
      state.meta.updateTitle = updateTitle || state.meta.updateTitle;
      state.meta.updateMessage = updateMessage || '';
      state.meta.downloadUrl = downloadUrl;
      state.meta.noticeText = noticeText;
      state.meta.publishedAt = nowIso();
    });
    adminStore.audit(req.admin.id, 'version.update', 'version', 'current');

    res.redirect('/admin/version?message=' + encodeURIComponent('版本设置已保存。'));
  } catch (error) {
    next(error);
  }
});

app.post('/admin/feedback/device-block', requireAdmin, async (req, res, next) => {
  try {
    const deviceId = trimText(req.body.deviceId ?? '');
    const blocked = isTruthy(req.body.blocked);
    const returnTo = trimText(req.body.returnTo ?? '/admin/feedback');

    if (!deviceId) {
      res.status(400).send('设备标识不能为空。');
      return;
    }

    validateLength(deviceId, 120, '设备标识');

    await mutateState((state) => {
      state.blockedFeedbackDevices = Array.isArray(state.blockedFeedbackDevices)
        ? state.blockedFeedbackDevices
        : [];

      if (blocked) {
        if (!isFeedbackDeviceBlocked(state, deviceId)) {
          state.blockedFeedbackDevices.unshift({
            deviceId,
            blockedAt: nowIso()
          });
        }
        return;
      }

      state.blockedFeedbackDevices = state.blockedFeedbackDevices.filter(
        (item) => item.deviceId !== deviceId
      );
    });
    adminStore.audit(req.admin.id, 'feedback.device_block', 'feedback_device',
      hashToken(deviceId).slice(0, 16), blocked ? 'blocked' : 'unblocked');

    adminRedirectWithMessage(
      res,
      returnTo,
      blocked ? '发送者已拉黑。' : '发送者已解除拉黑。'
    );
  } catch (error) {
    next(error);
  }
});

app.get('/admin/feedback/:id', requireAdmin, async (req, res, next) => {
  try {
    const state = await readState();
    const item = state.feedback.find((feedback) => feedback.id === req.params.id);

    if (!item) {
      res.status(404).send('未找到反馈。');
      return;
    }

    res.status(200).send(
      renderFeedbackDetail({
        state,
        item,
        csrfToken: res.locals.csrfToken,
        admin: req.admin
      })
    );
  } catch (error) {
    next(error);
  }
});

app.post('/admin/feedback/:id/reply', requireAdmin, async (req, res, next) => {
  try {
    const message = trimText(req.body.message ?? '');
    const status = trimText(req.body.status ?? '');

    if (!message) {
      res.status(400).send('回复内容不能为空。');
      return;
    }

    validateLength(message, 4000, '回复内容');

    const now = nowIso();
    const feedbackId = req.params.id;

    const updated = await mutateState((state) => {
      const item = state.feedback.find((feedback) => feedback.id === feedbackId);
      if (!item) {
        return null;
      }

      item.replies = Array.isArray(item.replies) ? item.replies : [];
      item.replies.push({
        id: makeId('rp'),
        author: req.admin.username,
        authorId: req.admin.id,
        message,
        createdAt: now
      });
      item.status = ['open', 'closed'].includes(status) ? status : 'replied';
      item.updatedAt = now;

      return item;
    });

    if (!updated) {
      res.status(404).send('未找到反馈。');
      return;
    }
    adminStore.audit(req.admin.id, 'feedback.reply', 'feedback', feedbackId,
      ['open', 'closed'].includes(status) ? status : 'replied');

    res.redirect(`/admin/feedback/${encodeURIComponent(feedbackId)}`);
  } catch (error) {
    next(error);
  }
});

app.get('/', (req, res) => {
  res.type('text').send('ShuYo API is running.');
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({
      success: false,
      error: 'Not Found'
    });
    return;
  }

  res.status(404).type('text').send('Not Found');
});

app.use((error, req, res, next) => {
  const message = error instanceof Error ? error.message : 'Internal Server Error';
  if (req.path.startsWith('/admin')) {
    console.error('[admin]', error?.name ?? 'Error', error?.code ?? '');
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).type('text').send('后台操作失败，请稍后重试。');
    return;
  }
  console.error(error);

  if (req.path.startsWith('/api/')) {
    res.status(500).json({
      success: false,
      error: message
    });
    return;
  }

  res.status(500).type('text').send(message);
});

if (process.env.NODE_ENV !== 'test') {
  await initializeWebVpnMonitor();
  startTipImageCleanup({
    directory: tipImageDir,
    loadTips: async () => (await readState()).tips,
  });
  app.listen(port, '0.0.0.0', () => {
    console.log(`Lehu update feedback server listening on ${port}`);
  });
}

export { app, adminStore, studentIdentityStore };
