'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME_DIR = path.join(os.homedir(), '.easymcp-refactored');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
const TOKEN_FILE = path.join(HOME_DIR, 'token');
const RECENT_FILE = path.join(HOME_DIR, 'recent-projects.json');

let VERSION = '3.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || VERSION;
} catch {}

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...loadConfig(), ...patch }, null, 2) + '\n');
  } catch {}
}

function loadOrCreateToken({ tokenArg = '', rotate = false } = {}) {
  if (tokenArg) return tokenArg;
  if (!rotate) {
    try {
      const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (/^[0-9a-f]{32,}$/.test(saved)) return saved;
    } catch {}
  }
  const fresh = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, fresh + '\n', { mode: 0o600 });
  } catch {}
  return fresh;
}

function loadRecents() {
  try {
    const list = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecents(list) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(RECENT_FILE, JSON.stringify(list.slice(0, 10), null, 2));
  } catch {}
}

function createState(argv = process.argv.slice(2), env = process.env) {
  const port = Number(env.EASYMCP_PORT || argValue(argv, '--port', '9494'));
  const token = env.EASYMCP_TOKEN || argValue(argv, '--token', '') || loadOrCreateToken({
    rotate: argv.includes('--rotate-token'),
  });
  const skipJail = argv.includes('--dangerously-skip-jail') || env.EASYMCP_SKIP_JAIL === '1';
  const positionalProject = argv.find(
    (a) => !a.startsWith('--') && a !== argValue(argv, '--port', '') && a !== argValue(argv, '--token', '')
  );
  const projectRoot = path.resolve(
    env.EASYMCP_PROJECT || positionalProject || (skipJail ? path.parse(process.cwd()).root : process.cwd())
  );

  let tunnelMode = env.EASYMCP_TUNNEL || loadConfig().tunnel || 'cloudflare';
  if (!['cloudflare', 'funnel', 'none'].includes(tunnelMode)) tunnelMode = 'cloudflare';

  const recentProjects = [...new Set([projectRoot, ...loadRecents()])].slice(0, 10);

  return {
    version: VERSION,
    port,
    token,
    adminSecret: crypto.randomBytes(32).toString('hex'),
    readOnly: argv.includes('--read-only') || env.EASYMCP_READ_ONLY === '1',
    disableShell: !argv.includes('--enable-shell') && env.EASYMCP_ENABLE_SHELL !== '1',
    skipJail,
    projectRoot,
    recentProjects,
    publicUrl: (env.EASYMCP_PUBLIC_URL || '').replace(/\/+$/, ''),
    tunnelMode,
    tunnelError: '',
    startedAt: Date.now(),
    totalCalls: 0,
    totalErrors: 0,
    recentCalls: [],
  };
}

function setProjectRoot(state, newPath) {
  const abs = path.resolve(String(newPath));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Not a folder: ${newPath}`);
  }
  state.projectRoot = abs;
  const idx = state.recentProjects.indexOf(abs);
  if (idx >= 0) state.recentProjects.splice(idx, 1);
  state.recentProjects.unshift(abs);
  if (state.recentProjects.length > 10) state.recentProjects.length = 10;
  saveRecents(state.recentProjects);
  return abs;
}

function recordCall(state, tool, ok, ms, detail = '') {
  state.totalCalls += 1;
  if (!ok) state.totalErrors += 1;
  state.recentCalls.unshift({
    ts: new Date().toISOString(),
    tool,
    ok,
    ms,
    detail: detail ? String(detail).slice(0, 120) : '',
  });
  if (state.recentCalls.length > 100) state.recentCalls.length = 100;
}

module.exports = {
  HOME_DIR,
  VERSION,
  argValue,
  loadConfig,
  saveConfig,
  loadOrCreateToken,
  createState,
  setProjectRoot,
  recordCall,
};
