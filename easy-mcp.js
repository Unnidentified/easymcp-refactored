#!/usr/bin/env node
/*
 * Easy MCP — launcher
 *
 * Usage:
 *   node easy-mcp.js [project-folder] [--port 9494] [--funnel|--cloudflare|--no-tunnel]
 *                    [--no-open] [--read-only] [--enable-shell] [--token <token>]
 *                    [--rotate-token] [--dangerously-skip-jail]
 */
'use strict';

const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { VERSION, argValue, loadOrCreateToken } = require('./src/config');

const args = process.argv.slice(2);
let PORT = Number(argValue(args, '--port', '9494'));
const TOKEN = loadOrCreateToken({
  tokenArg: argValue(args, '--token', process.env.EASY_MCP_TOKEN || ''),
  rotate: args.includes('--rotate-token'),
});
const NO_TUNNEL = args.includes('--no-tunnel');
const TUNNEL_MODE = NO_TUNNEL ? 'none' : args.includes('--funnel') ? 'funnel' : args.includes('--cloudflare') ? 'cloudflare' : '';
const NO_OPEN = args.includes('--no-open');
const SKIP_JAIL = args.includes('--dangerously-skip-jail');
const projectArg = args.find(
  (a) => !a.startsWith('--') && a !== argValue(args, '--port', '') && a !== argValue(args, '--token', '')
);
const projectDir = path.resolve(projectArg || (SKIP_JAIL ? path.parse(process.cwd()).root : process.cwd()));

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, cmdArgs, () => {});
}

function findFreePort(start) {
  return new Promise((resolve) => {
    const tryPort = (port, left) => {
      const srv = net.createServer();
      srv.once('error', () => {
        if (left > 0) tryPort(port + 1, left - 1);
        else resolve(start);
      });
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort(start, 20);
  });
}

function killOldInstances() {
  try {
    if (process.platform === 'win32') {
      const ps = [
        "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*easy-mcp*server.js*') -or ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*.easy-mcp*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }`,
      ].join('; ');
      spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    } else {
      spawnSync('pkill', ['-f', '^node .*easy-mcp.*server\\.js']);
      spawnSync('pkill', ['-f', 'cloudflared.*\\.easy-mcp']);
    }
  } catch {}
}

async function main() {
  killOldInstances();
  await new Promise((r) => setTimeout(r, 300));
  PORT = await findFreePort(PORT);
  if (!fs.existsSync(projectDir)) {
    console.error(`Project folder does not exist: ${projectDir}`);
    process.exit(1);
  }

  const serverArgs = [path.join(__dirname, 'server.js')];
  if (args.includes('--read-only')) serverArgs.push('--read-only');
  if (args.includes('--enable-shell')) serverArgs.push('--enable-shell');
  if (SKIP_JAIL) serverArgs.push('--dangerously-skip-jail');

  const server = spawn(process.execPath, serverArgs, {
    env: {
      ...process.env,
      EASY_MCP_PORT: String(PORT),
      EASY_MCP_TOKEN: TOKEN,
      EASY_MCP_PROJECT: projectDir,
      ...(TUNNEL_MODE ? { EASY_MCP_TUNNEL: TUNNEL_MODE } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(d));
  server.stderr.on('data', (d) => process.stderr.write(d));

  const localDashboard = `http://127.0.0.1:${PORT}/`;
  console.log(`Easy MCP v${VERSION}`);
  console.log(`Project:   ${projectDir}`);
  if (SKIP_JAIL) {
    console.log('WARNING: --dangerously-skip-jail is ON. Tools can access the entire machine.');
  }
  console.log(`Dashboard: ${localDashboard}`);

  if (!NO_OPEN) setTimeout(() => openBrowser(localDashboard), 700);
  console.log('Press Ctrl+C to stop.');

  const stop = () => {
    try {
      server.kill('SIGTERM');
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
