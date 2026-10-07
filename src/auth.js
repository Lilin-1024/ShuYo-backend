import crypto from 'node:crypto';

const SESSION_COOKIE = 'shuyo_admin_session';
const LOGIN_CSRF_COOKIE = 'shuyo_admin_login_csrf';

function cookieSecure() {
  const value = String(process.env.COOKIE_SECURE ?? '').toLowerCase();
  return value === '1' || value === 'true';
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function createAdminAuth(store) {
  function sessionToken(req) {
    return req.signedCookies?.[SESSION_COOKIE] ?? null;
  }

  function currentAdmin(req) {
    return store.getSession(sessionToken(req));
  }

  function requireAdmin(req, res, next) {
    const admin = currentAdmin(req);
    if (!admin) {
      res.redirect('/admin/login');
      return;
    }
    req.admin = admin;
    res.locals.csrfToken = admin.csrf_token;
    next();
  }

  function requireSuperadmin(req, res, next) {
    if (req.admin?.role !== 'superadmin') {
      res.status(403).send('没有权限。');
      return;
    }
    next();
  }

  function requireCsrf(req, res, next) {
    if (!safeEqual(req.body?._csrf, req.admin?.csrf_token)) {
      res.status(403).send('页面已过期，请刷新后重试。');
      return;
    }
    next();
  }

  function createLoginCsrf(res) {
    const token = crypto.randomBytes(32).toString('base64url');
    res.cookie(LOGIN_CSRF_COOKIE, token, {
      signed: true, httpOnly: true, sameSite: 'lax', secure: cookieSecure(),
      maxAge: 10 * 60 * 1000, path: '/admin'
    });
    return token;
  }

  function checkLoginCsrf(req) {
    return safeEqual(req.body?._csrf, req.signedCookies?.[LOGIN_CSRF_COOKIE]);
  }

  function clearLoginCsrf(res) {
    res.clearCookie(LOGIN_CSRF_COOKIE, { path: '/admin' });
  }

  function registerSession(res, adminId) {
    const session = store.createSession(adminId);
    res.cookie(SESSION_COOKIE, session.token, {
      signed: true, httpOnly: true, sameSite: 'lax', secure: cookieSecure(),
      maxAge: session.maxAge, path: '/admin'
    });
  }

  function clearSession(req, res) {
    store.revokeSession(sessionToken(req), req.admin?.id);
    res.clearCookie(SESSION_COOKIE, { path: '/admin' });
  }

  return {
    currentAdmin, requireAdmin, requireSuperadmin, requireCsrf,
    createLoginCsrf, checkLoginCsrf, clearLoginCsrf, registerSession, clearSession
  };
}

export { createAdminAuth };
