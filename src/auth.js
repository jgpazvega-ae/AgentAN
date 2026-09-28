// Contraseñas (scrypt), sesiones con cookie y control de acceso por rol.
const crypto = require('node:crypto');
const { get, run } = require('./db');
const config = require('./config');

const COOKIE = 'fletes_sid';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = config.sessionDays * 24 * 60 * 60 * 1000;
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, Date.now() + maxAge);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge,
    path: '/',
  });
}

function destroySession(req, res) {
  const token = readToken(req);
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.clearCookie(COOKIE, { path: '/' });
}

function readToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// Middleware: agrega req.user si hay una sesión válida.
function loadUser(req, _res, next) {
  const token = readToken(req);
  if (token) {
    const row = get(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.active, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`,
      token
    );
    if (row && row.expires_at > Date.now() && row.active) {
      delete row.expires_at;
      req.user = row;
    } else if (row) {
      run('DELETE FROM sessions WHERE token = ?', token);
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede hacer esto.' });
  next();
}

// Límite sencillo de intentos de inicio de sesión por IP (en memoria).
const attempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (entry.reset < now) {
    entry.count = 0;
    entry.reset = now + 15 * 60 * 1000;
  }
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count > 20) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
  }
  next();
}

function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadUser,
  requireUser,
  requireAdmin,
  loginRateLimit,
  purgeExpiredSessions,
};
