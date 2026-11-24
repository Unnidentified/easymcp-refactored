'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

function realpathOrAncestor(abs) {
  let cur = abs;
  for (;;) {
    try {
      return fs.realpathSync(cur);
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

function resolveInProject(state, p) {
  const abs = path.resolve(state.projectRoot, String(p || '.'));
  if (state.skipJail) return abs;
  const root = realpathOrAncestor(state.projectRoot);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project folder: ${p}`);
  }
  const real = realpathOrAncestor(abs);
  const realRel = path.relative(root, real);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new Error(`Path escapes project folder: ${p}`);
  }
  return abs;
}

function assertNotGitInternal(state, abs) {
  if (!state.disableShell) return;
  const root = realpathOrAncestor(state.projectRoot);
  const candidates = [
    path.relative(state.projectRoot, abs),
    path.relative(root, realpathOrAncestor(abs)),
  ];
  for (const c of candidates) {
    const rel = c.split(path.sep).join('/');
    if (rel === '.gitmodules' || rel === '.git/config' || rel.startsWith('.git/hooks/')) {
      throw new Error('Writing git internals is blocked while the shell is disabled');
    }
  }
}

function relOf(state, abs) {
  const r = path.relative(state.projectRoot, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return abs.split(path.sep).join('/');
  return r === '' ? '.' : r.split(path.sep).join('/');
}

function isLoopbackHost(host, port) {
  const h = String(host || '').toLowerCase();
  return (
    h === `127.0.0.1:${port}` ||
    h === `localhost:${port}` ||
    h === `[::1]:${port}` ||
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '[::1]'
  );
}

function hasTunnelHeaders(req) {
  const h = req.headers;
  return !!(
    h['cf-connecting-ip'] ||
    h['cf-ray'] ||
    h['x-forwarded-for'] ||
    h['x-forwarded-host'] ||
    h['forwarded'] ||
    h['tailscale-user-login']
  );
}

function isLocalAdminRequest(req, port) {
  return isLoopbackHost(req.headers.host, port) && !hasTunnelHeaders(req);
}

function hostAllowed(req, state) {
  if (isLoopbackHost(req.headers.host, state.port)) return true;
  if (state.publicUrl) {
    try {
      return String(req.headers.host || '').toLowerCase() === new URL(state.publicUrl).host.toLowerCase();
    } catch {}
  }
  return false;
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' || h === '0.0.0.0') {
    return true;
  }
  if (h.includes(':')) {
    if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7));
    return (
      h.startsWith('fe8') ||
      h.startsWith('fe9') ||
      h.startsWith('fea') ||
      h.startsWith('feb') ||
      h.startsWith('fc') ||
      h.startsWith('fd')
    );
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

module.exports = {
  sha256hex,
  safeEqual,
  realpathOrAncestor,
  resolveInProject,
  assertNotGitInternal,
  relOf,
  isLoopbackHost,
  hasTunnelHeaders,
  isLocalAdminRequest,
  hostAllowed,
  isPrivateHost,
};
