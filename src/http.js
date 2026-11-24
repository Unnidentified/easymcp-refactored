'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { setProjectRoot } = require('./config');
const { safeEqual, isLoopbackHost, isLocalAdminRequest, hostAllowed } = require('./security');
const { pickFolderNative } = require('./picker');

const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

const PUBLIC_PATHS = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/.well-known/oauth-protected-resource',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
]);

function isPublicPath(p) {
  return PUBLIC_PATHS.has(p) || p.startsWith('/.well-known/oauth-protected-resource/');
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, maxBytes = 10_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > maxBytes) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function createHttpServer({ state, registry, mcpHandler, oauth, tunnel, jobManager }) {
  const sseSessions = new Map();
  const sseSessionTokens = new Map();
  const mcpSessions = new Map();

  function bearerOf(req, url) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ')
      ? header.slice(7)
      : req.headers['x-easymcp-token'] || url.searchParams.get('token') || req._pathToken || '';
  }

  function authorized(req, url) {
    if (!state.token) return false;
    const given = bearerOf(req, url);
    if (!given) return false;
    if (safeEqual(given, state.token)) return true;
    const sid = url.searchParams.get('sessionId');
    if (sid && sseSessionTokens.has(sid) && safeEqual(given, sseSessionTokens.get(sid))) return true;
    return oauth.hasValidAccessToken(given);
  }

  function dashboardData() {
    const tools = registry.listTools();
    return {
      status: 'online',
      version: state.version,
      project: state.projectRoot,
      recentProjects: state.recentProjects,
      readOnly: state.readOnly,
      disableShell: state.disableShell,
      skipJail: state.skipJail,
      toolsCount: tools.length,
      toolNames: tools.map((t) => t.name),
      tools,
      sseSessions: sseSessions.size,
      mcpSessions: mcpSessions.size,
      uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
      startedAt: new Date(state.startedAt).toISOString(),
      totalCalls: state.totalCalls,
      totalErrors: state.totalErrors,
      jobs: jobManager.list(),
      publicUrl: state.publicUrl || null,
      tunnelMode: state.tunnelMode,
      tunnelError: state.tunnelError || null,
      mcpUrl: state.publicUrl ? `${state.publicUrl}/mcp/${state.token}` : null,
      localMcpUrl: `http://127.0.0.1:${state.port}/mcp/${state.token}`,
      dashboardUrl: `http://127.0.0.1:${state.port}/`,
      recentCalls: state.recentCalls,
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathTokenMatch = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (pathTokenMatch) {
      req._pathToken = decodeURIComponent(pathTokenMatch[1]);
      url.pathname = '/mcp';
    }

    if (req.headers['access-control-request-private-network'] === 'true') {
      res.writeHead(403);
      return res.end();
    }
    if (!hostAllowed(req, state)) {
      res.writeHead(403);
      return res.end();
    }
    if (
      isLoopbackHost(req.headers.host, state.port) &&
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      res.writeHead(403);
      return res.end();
    }

    const corsPath =
      url.pathname === '/mcp' ||
      url.pathname === '/sse' ||
      url.pathname === '/messages' ||
      url.pathname.startsWith('/.well-known/');
    if (corsPath) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, HEAD');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Mcp-Session-Id, x-easymcp-token, mcp-protocol-version, mcp-method, mcp-name, *'
      );
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, *');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      const isAdminRoute = url.pathname === '/' || url.pathname === '/dashboard' || url.pathname.startsWith('/api/');
      if (isAdminRoute) {
        if (!isLocalAdminRequest(req, state.port)) return sendJson(res, 404, { error: 'Not found' });
        if (url.pathname.startsWith('/api/') && !safeEqual(req.headers['x-easymcp-admin'] || '', state.adminSecret)) {
          return sendJson(res, 401, { error: 'Unauthorized' });
        }
      } else if (!isPublicPath(url.pathname) && !authorized(req, url)) {
        if (url.pathname === '/mcp') {
          const base = state.publicUrl || `http://${req.headers.host || '127.0.0.1:' + state.port}`;
          res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
        }
        return sendJson(res, 401, { error: 'Unauthorized' });
      }

      if (await oauth.handleOAuthRoute(req, res, url, readBody, sendJson)) {
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(DASHBOARD_HTML.replace('__EASYMCP_ADMIN__', state.adminSecret));
      }
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        return sendJson(res, 200, dashboardData());
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const d = dashboardData();
        return sendJson(res, 200, {
          status: d.status,
          project: d.project,
          toolsCount: d.toolsCount,
          sseSessions: d.sseSessions,
          uptimeSec: d.uptimeSec,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/set-project') {
        const { path: p } = JSON.parse((await readBody(req)) || '{}');
        try {
          setProjectRoot(state, p);
          return sendJson(res, 200, { success: true, project: state.projectRoot });
        } catch (err) {
          return sendJson(res, 400, { success: false, error: err.message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
        const ac = new AbortController();
        req.on('close', () => {
          if (!res.writableEnded) ac.abort();
        });
        const result = await pickFolderNative({ signal: ac.signal });
        if (result.status === 'ok') {
          try {
            setProjectRoot(state, result.path);
            return sendJson(res, 200, { success: true, status: 'ok', project: state.projectRoot });
          } catch (err) {
            return sendJson(res, 400, { success: false, status: 'error', error: err.message });
          }
        }
        return sendJson(res, 200, { success: false, status: result.status, error: result.error || null });
      }
      if (req.method === 'POST' && url.pathname === '/api/set-tunnel') {
        const { mode } = JSON.parse((await readBody(req)) || '{}');
        try {
          await tunnel.setTunnel(mode);
          return sendJson(res, 200, {
            success: !state.tunnelError,
            tunnelMode: state.tunnelMode,
            publicUrl: state.publicUrl || null,
            error: state.tunnelError || null,
          });
        } catch (err) {
          return sendJson(res, 200, { success: false, tunnelMode: state.tunnelMode, error: err.message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/set-public-url') {
        const { url: u } = JSON.parse((await readBody(req)) || '{}');
        const clean = String(u || '').trim().replace(/\/+$/, '');
        if (!/^https:\/\//.test(clean)) return sendJson(res, 400, { success: false, error: 'url must be https://...' });
        state.publicUrl = clean;
        return sendJson(res, 200, { success: true, publicUrl: state.publicUrl });
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        return sendJson(res, 200, {
          readOnly: state.readOnly,
          disableShell: state.disableShell,
          skipJail: state.skipJail,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.readOnly === 'boolean') state.readOnly = body.readOnly;
        if (typeof body.disableShell === 'boolean') state.disableShell = body.disableShell;
        if (typeof body.skipJail === 'boolean') state.skipJail = body.skipJail;
        return sendJson(res, 200, {
          success: true,
          readOnly: state.readOnly,
          disableShell: state.disableShell,
          skipJail: state.skipJail,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/stop-job') {
        const { id } = JSON.parse((await readBody(req)) || '{}');
        const job = jobManager.stopJob(id);
        if (!job) return sendJson(res, 404, { success: false, error: 'Unknown job' });
        return sendJson(res, 200, { success: true });
      }
      if (req.method === 'POST' && (url.pathname === '/api/call' || url.pathname === '/call')) {
        const { name, arguments: toolArgs } = JSON.parse((await readBody(req)) || '{}');
        try {
          return sendJson(res, 200, { success: true, result: await registry.callTool(name, toolArgs) });
        } catch (err) {
          return sendJson(res, 400, { success: false, error: err.message });
        }
      }

      if (url.pathname === '/mcp' && req.method === 'POST') {
        const raw = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(raw || '{}');
        } catch {
          return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const isInit = messages.some((m) => m && m.method === 'initialize');
        let sessionId = req.headers['mcp-session-id'];
        if (isInit) {
          sessionId = crypto.randomBytes(16).toString('hex');
          mcpSessions.set(sessionId, { createdAt: Date.now() });
        }
        const outs = [];
        for (const m of messages) {
          const out = await mcpHandler.handleRpc(m);
          if (out) outs.push(out);
        }
        if (!outs.length) {
          res.writeHead(202);
          return res.end();
        }
        const payload = Array.isArray(parsed) ? outs : outs[0];
        const sseId = url.searchParams.get('sessionId') || sessionId;
        const sseRes = sseId && sseSessions.get(sseId);
        if (sseRes) {
          try {
            sseRes.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          } catch {}
        }
        const body = JSON.stringify(payload);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        res.writeHead(200, headers);
        return res.end(body);
      }

      if (url.pathname === '/mcp' && req.method === 'GET') {
        const accept = req.headers.accept || '';
        if (!accept.includes('text/event-stream')) {
          const tools = registry.listTools();
          return sendJson(res, 200, {
            status: 'online',
            service: 'easymcp-refactored',
            protocolVersion: '2025-03-26',
            toolsCount: tools.length,
            tools: tools.map((t) => t.name),
          });
        }
        if (req.socket) {
          req.socket.setKeepAlive(true, 10000);
          req.socket.setNoDelay(true);
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const sseId = crypto.randomBytes(16).toString('hex');
        const sseToken = crypto.randomBytes(16).toString('hex');
        sseSessionTokens.set(sseId, sseToken);
        const endpointUri = `${proto}://${host}/mcp?sessionId=${sseId}&token=${sseToken}`;
        res.write(`: ${' '.repeat(4096)}\n\n`);
        res.write(`event: endpoint\ndata: ${endpointUri}\n\n`);
        sseSessions.set(sseId, res);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
            res.write('event: ping\ndata: {}\n\n');
          } catch {}
        }, 20000);
        const cleanup = () => {
          clearInterval(ping);
          sseSessions.delete(sseId);
          sseSessionTokens.delete(sseId);
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        return;
      }

      if (url.pathname === '/mcp' && req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'];
        if (sessionId) mcpSessions.delete(sessionId);
        res.writeHead(200);
        return res.end();
      }

      if (req.method === 'GET' && url.pathname === '/sse') {
        const sessionId = crypto.randomBytes(8).toString('hex');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        sseSessions.set(sessionId, res);
        const sseToken = crypto.randomBytes(16).toString('hex');
        sseSessionTokens.set(sessionId, sseToken);
        const q = state.token ? `?token=${sseToken}&sessionId=${sessionId}` : `?sessionId=${sessionId}`;
        res.write(`event: endpoint\ndata: /messages${q}\n\n`);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          sseSessions.delete(sessionId);
          sseSessionTokens.delete(sessionId);
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        const sse = sseSessions.get(sessionId);
        const msg = JSON.parse((await readBody(req)) || '{}');
        const out = await mcpHandler.handleRpc(msg);
        if (out && sse) sse.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
        res.writeHead(202);
        return res.end();
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });

  return server;
}

module.exports = { createHttpServer };
