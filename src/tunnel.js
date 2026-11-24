'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const { EASY_MCP_HOME, saveConfig } = require('./config');

function cloudflaredPath() {
  return path.join(EASY_MCP_HOME, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

function ensureCloudflared() {
  const bin = cloudflaredPath();
  if (fs.existsSync(bin)) return Promise.resolve(bin);
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  const name =
    process.platform === 'win32'
      ? 'cloudflared-windows-amd64.exe'
      : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? 'cloudflared-darwin-arm64.tgz'
          : 'cloudflared-darwin-amd64.tgz'
        : process.arch === 'arm64'
          ? 'cloudflared-linux-arm64'
          : 'cloudflared-linux-amd64';

  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const tmp = bin + '.tmp';

  return new Promise((resolve, reject) => {
    const get = (url) =>
      https
        .get(url, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(res.headers.location);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error('cloudflared download failed: HTTP ' + res.statusCode));
          }
          const out = fs.createWriteStream(tmp);
          res.pipe(out);
          out.on('finish', () => {
            try {
              if (name.endsWith('.tgz')) {
                const dir = path.dirname(bin);
                const r = spawnSync('tar', ['-xzf', tmp, '-C', dir], { stdio: 'ignore' });
                if (r.status !== 0) return reject(new Error('cloudflared extract failed'));
                const extracted = path.join(dir, 'cloudflared');
                if (extracted !== bin && fs.existsSync(extracted)) fs.renameSync(extracted, bin);
                try {
                  fs.unlinkSync(tmp);
                } catch {}
              } else {
                fs.renameSync(tmp, bin);
              }
              if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
              resolve(bin);
            } catch (e) {
              reject(e);
            }
          });
          out.on('error', reject);
        })
        .on('error', reject);
    get(base + name);
  });
}

function createTunnelManager(state) {
  let tunnelProc = null;

  function stopTunnel() {
    if (tunnelProc) {
      try {
        tunnelProc.kill();
      } catch {}
      tunnelProc = null;
    }
    state.publicUrl = '';
  }

  async function startTunnel(mode) {
    state.tunnelError = '';
    if (mode === 'none') {
      state.tunnelMode = 'none';
      return;
    }

    if (mode === 'funnel') {
      try {
        spawnSync('tailscale', ['funnel', '--bg', String(state.port)], { stdio: 'ignore', timeout: 20000 });
      } catch {}
      let dns = '';
      try {
        const st = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 15000 });
        dns = JSON.parse(st.stdout || '{}').Self?.DNSName?.replace(/\.$/, '') || '';
      } catch {}
      dns = dns || process.env.EASY_MCP_FUNNEL_HOST || '';
      if (!dns) {
        state.tunnelError = 'Tailscale not found or not signed in. Install: https://tailscale.com/download';
        state.tunnelMode = 'funnel';
        return;
      }
      state.tunnelMode = 'funnel';
      state.publicUrl = 'https://' + dns;
      console.log(`MCP link:  ${state.publicUrl}/mcp/${state.token}`);
      return;
    }

    state.tunnelMode = 'cloudflare';
    const bin = await ensureCloudflared();
    tunnelProc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${state.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (d) => {
      const m = String(d).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !state.publicUrl) {
        state.publicUrl = m[0];
        console.log(`MCP link:  ${state.publicUrl}/mcp/${state.token}`);
      }
    };
    tunnelProc.stdout.on('data', onData);
    tunnelProc.stderr.on('data', onData);
    tunnelProc.on('exit', () => {
      tunnelProc = null;
      if (!state.publicUrl) {
        state.tunnelError = 'Cloudflare tunnel failed to start (no internet route?)';
      }
    });
  }

  async function setTunnel(mode) {
    if (!['cloudflare', 'funnel', 'none'].includes(mode)) {
      throw new Error('Unknown tunnel mode: ' + mode);
    }
    stopTunnel();
    saveConfig({ tunnel: mode });
    await startTunnel(mode);
  }

  return { startTunnel, stopTunnel, setTunnel };
}

module.exports = { createTunnelManager };
