'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HOME_DIR } = require('./config');
const { sha256hex, safeEqual } = require('./security');

const OAUTH_CLIENTS_FILE = path.join(HOME_DIR, 'oauth-clients.json');
const OAUTH_TOKENS_FILE = path.join(HOME_DIR, 'oauth-tokens.json');

function loadOAuthStore(file) {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch {
    return new Map();
  }
}

function createOAuthManager(state) {
  const oauthClients = loadOAuthStore(OAUTH_CLIENTS_FILE);
  const oauthTokens = loadOAuthStore(OAUTH_TOKENS_FILE);
  const oauthCodes = new Map();
  const registerHits = [];

  function saveOAuth() {
    try {
      fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
      for (const [file, map] of [
        [OAUTH_CLIENTS_FILE, oauthClients],
        [OAUTH_TOKENS_FILE, oauthTokens],
      ]) {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
        fs.renameSync(tmp, file);
      }
    } catch {}
  }

  function pruneClients() {
    if (oauthClients.size <= 100) return;
    const sorted = [...oauthClients.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
    for (const [id] of sorted.slice(0, oauthClients.size - 100)) {
      oauthClients.delete(id);
    }
  }

  function registerRateOk() {
    const now = Date.now();
    while (registerHits.length && registerHits[0] < now - 60000) registerHits.shift();
    if (registerHits.length >= 20) return false;
    registerHits.push(now);
    return true;
  }

  function validRedirectUri(u) {
    try {
      const x = new URL(String(u));
      if (x.protocol === 'https:') return true;
      return x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname);
    } catch {
      return false;
    }
  }

  function hasValidAccessToken(token) {
    const rec = oauthTokens.get(sha256hex(token));
    return !!(rec && rec.type === 'access' && (!rec.exp || rec.exp > Date.now()));
  }

  function baseUrl(req) {
    return state.publicUrl || `http://${req.headers.host || '127.0.0.1:' + state.port}`;
  }

  async function handleOAuthRoute(req, res, url, readBody, sendJson) {
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
      const base = baseUrl(req);
      sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        scopes_supported: ['mcp', 'mcp:read', 'mcp:write'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      });
      return true;
    }

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      const base = baseUrl(req);
      sendJson(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
      });
      return true;
    }

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource/')) {
      const base = baseUrl(req);
      const suffix = url.pathname.slice('/.well-known/oauth-protected-resource'.length) || '/mcp';
      sendJson(res, 200, {
        resource: `${base}${suffix}`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
      });
      return true;
    }

    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      if (!registerRateOk()) {
        sendJson(res, 429, { error: 'rate_limited', error_description: 'Too many registrations, try again in a minute' });
        return true;
      }
      let meta = {};
      try {
        meta = JSON.parse((await readBody(req, 65536)) || '{}');
      } catch {}
      const rawUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
      const redirectUris = rawUris.filter((u) => validRedirectUri(u));
      if (rawUris.length && !redirectUris.length) {
        sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http loopback)' });
        return true;
      }
      const authMethod = ['none', 'client_secret_post', 'client_secret_basic'].includes(meta.token_endpoint_auth_method)
        ? meta.token_endpoint_auth_method
        : 'client_secret_post';
      const clientId = 'mcp_' + crypto.randomBytes(16).toString('hex');
      const clientSecret = authMethod === 'none' ? '' : crypto.randomBytes(32).toString('hex');
      oauthClients.set(clientId, {
        secretHash: clientSecret ? sha256hex(clientSecret) : '',
        redirect_uris: redirectUris,
        authMethod,
        createdAt: Date.now(),
      });
      pruneClients();
      saveOAuth();
      const out = {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: authMethod,
        scope: 'mcp',
      };
      if (clientSecret) out.client_secret = clientSecret;
      sendJson(res, 201, out);
      return true;
    }

    if (url.pathname === '/oauth/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const stateParam = url.searchParams.get('state') || '';
      const clientId = url.searchParams.get('client_id') || '';
      const client = oauthClients.get(clientId);
      if (redirectUri) {
        if (!client) {
          sendJson(res, 400, { error: 'invalid_client', error_description: 'Unknown client_id — register first' });
          return true;
        }
        if (url.searchParams.get('response_type') !== 'code') {
          sendJson(res, 400, { error: 'unsupported_response_type' });
          return true;
        }
        const challenge = url.searchParams.get('code_challenge') || '';
        if (!challenge && client.authMethod === 'none') {
          sendJson(res, 400, { error: 'invalid_request', error_description: 'code_challenge (PKCE) is required for public clients' });
          return true;
        }
        const uriOk = client.redirect_uris.length ? client.redirect_uris.includes(redirectUri) : validRedirectUri(redirectUri);
        if (!uriOk) {
          sendJson(res, 400, { error: 'invalid_redirect_uri' });
          return true;
        }
        const code = crypto.randomBytes(32).toString('hex');
        oauthCodes.set(code, {
          exp: Date.now() + 600000,
          challenge,
          method: url.searchParams.get('code_challenge_method') || 'S256',
          clientId,
          redirectUri,
        });
        if (oauthCodes.size > 100) {
          for (const [k, v] of oauthCodes) {
            if (v.exp < Date.now()) oauthCodes.delete(k);
          }
        }
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        if (stateParam) target.searchParams.set('state', stateParam);
        target.searchParams.set('iss', baseUrl(req));
        res.writeHead(302, { Location: target.toString() });
        res.end();
        return true;
      }
      sendJson(res, 200, { status: 'authorized' });
      return true;
    }

    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const raw = await readBody(req, 65536);
      const form = new URLSearchParams(raw);
      let secret = form.get('client_secret') || '';
      let clientId = form.get('client_id') || '';
      const basic = req.headers.authorization || '';
      if (basic.startsWith('Basic ')) {
        try {
          const [id, ...rest] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
          if (!clientId) clientId = id;
          if (!secret) secret = rest.join(':');
        } catch {}
      }
      const grantType = form.get('grant_type') || 'authorization_code';
      const mintTokens = (cid, keepRefresh) => {
        const access = 'emcp_at_' + crypto.randomBytes(32).toString('hex');
        oauthTokens.set(sha256hex(access), { type: 'access', clientId: cid, exp: Date.now() + 86400000, createdAt: Date.now() });
        let refresh = keepRefresh;
        if (!refresh) {
          refresh = 'emcp_rt_' + crypto.randomBytes(32).toString('hex');
          oauthTokens.set(sha256hex(refresh), { type: 'refresh', clientId: cid, exp: 0, createdAt: Date.now() });
        }
        saveOAuth();
        return { access_token: access, token_type: 'Bearer', expires_in: 86400, refresh_token: refresh, scope: 'mcp' };
      };

      if (grantType === 'refresh_token') {
        const rt = form.get('refresh_token') || '';
        if (rt && safeEqual(rt, state.token)) {
          sendJson(res, 200, mintTokens(clientId || 'legacy', state.token));
          return true;
        }
        const rec = oauthTokens.get(sha256hex(rt));
        if (!rec || rec.type !== 'refresh') {
          sendJson(res, 401, { error: 'invalid_grant', error_description: 'Unknown refresh token' });
          return true;
        }
        const client = oauthClients.get(rec.clientId);
        if (client && client.authMethod !== 'none' && !safeEqual(sha256hex(secret), client.secretHash)) {
          sendJson(res, 401, { error: 'invalid_client', error_description: 'Client secret mismatch' });
          return true;
        }
        sendJson(res, 200, mintTokens(rec.clientId, rt));
        return true;
      }

      const code = form.get('code') || '';
      const rec = oauthCodes.get(code);
      if (code) oauthCodes.delete(code);
      if (!rec || rec.exp < Date.now()) {
        sendJson(res, 401, { error: 'invalid_grant', error_description: 'Unknown or expired code' });
        return true;
      }
      if (clientId && rec.clientId !== clientId) {
        sendJson(res, 401, { error: 'invalid_grant', error_description: 'Code was issued to another client' });
        return true;
      }
      const redirectUri = form.get('redirect_uri') || '';
      if (redirectUri && rec.redirectUri && redirectUri !== rec.redirectUri) {
        sendJson(res, 401, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return true;
      }
      let pkceOk = !rec.challenge;
      if (rec.challenge) {
        const verifier = form.get('code_verifier') || '';
        const computed = rec.method === 'plain'
          ? verifier
          : crypto.createHash('sha256').update(verifier).digest('base64url');
        pkceOk = !!verifier && safeEqual(computed, rec.challenge);
      }
      const client = oauthClients.get(rec.clientId);
      let secretOk = !client || client.authMethod === 'none';
      if (client && client.authMethod !== 'none') {
        secretOk = safeEqual(sha256hex(secret), client.secretHash);
      }
      if (!pkceOk || !secretOk) {
        sendJson(res, 401, { error: 'invalid_client', error_description: 'PKCE verifier or client secret mismatch' });
        return true;
      }
      sendJson(res, 200, mintTokens(rec.clientId, ''));
      return true;
    }

    return false;
  }

  return {
    hasValidAccessToken,
    handleOAuthRoute,
  };
}

module.exports = { createOAuthManager };
