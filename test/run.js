'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server');
const { isPrivateHost } = require('../src/security');

function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('easymcp-refactored v3', () => {
  let tmpDir;
  let outsideDir;
  let app;
  let port;
  const token = 'testtoken_0123456789abcdef0123456789abcdef';

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easymcp-test-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easymcp-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'nope');
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'line1\nline2\nline3\nline4\n');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'app.js'), 'const x = 42;\nconsole.log(x);\n');

    app = createApp([], {
      EASYMCP_PORT: '0',
      EASYMCP_TOKEN: token,
      EASYMCP_PROJECT: tmpDir,
      EASYMCP_TUNNEL: 'none',
    });

    await new Promise((resolve) => {
      app.server.listen(0, '127.0.0.1', () => {
        port = app.server.address().port;
        app.state.port = port;
        resolve();
      });
    });
  });

  after(() => {
    app.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated MCP calls', async () => {
    const res = await request(port, 'POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(res.status, 401);
  });

  it('supports initialize, tools/list, resources/list, and prompts/list', async () => {
    const init = await request(port, 'POST', `/mcp/${token}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    });
    assert.equal(init.status, 200);
    assert.ok(init.headers['mcp-session-id']);
    assert.equal(init.json.result.serverInfo.name, 'easymcp-refactored');

    const tools = await request(port, 'POST', '/mcp', {
      headers: { Authorization: `Bearer ${token}` },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    const names = tools.json.result.tools.map((t) => t.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('find_files'));
    assert.ok(names.includes('delete_file'));
    assert.ok(names.includes('move_file'));
    assert.ok(names.includes('git_log'));
    assert.ok(names.includes('project_summary'));
    assert.ok(!names.includes('set_project')); // hidden while jail is active

    const resources = await request(port, 'POST', '/mcp', {
      headers: { Authorization: `Bearer ${token}` },
      body: { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    });
    assert.ok(resources.json.result.resources.some((r) => r.name === 'hello.txt'));

    const prompts = await request(port, 'POST', '/mcp', {
      headers: { Authorization: `Bearer ${token}` },
      body: { jsonrpc: '2.0', id: 4, method: 'prompts/list' },
    });
    assert.ok(prompts.json.result.prompts.some((p) => p.name === 'project_overview'));
  });

  it('reads line ranges, searches with regex, finds files, and mutates safely', async () => {
    const read = await app.registry.callTool('read_file', { path: 'hello.txt', start_line: 2, end_line: 3 });
    assert.match(read, /2 \| line2/);
    assert.match(read, /3 \| line3/);
    assert.doesNotMatch(read, /1 \| line1/);

    const found = await app.registry.callTool('find_files', { pattern: '*.js' });
    assert.equal(found, 'sub/app.js');

    const searched = await app.registry.callTool('search_files', {
      query: 'const\\s+x\\s*=\\s*\\d+',
      regex: true,
      glob: '*.js',
    });
    assert.match(searched, /sub\/app\.js:1:/);

    await app.registry.callTool('create_directory', { path: 'nested/dir' });
    await app.registry.callTool('write_file', { path: 'nested/dir/a.txt', content: 'alpha beta' });
    await app.registry.callTool('edit_file', { path: 'nested/dir/a.txt', old_text: 'beta', new_text: 'gamma' });
    await app.registry.callTool('move_file', { from: 'nested/dir/a.txt', to: 'nested/dir/b.txt' });
    const moved = await app.registry.callTool('read_file', { path: 'nested/dir/b.txt' });
    assert.match(moved, /alpha gamma/);
    await app.registry.callTool('delete_file', { path: 'nested/dir/b.txt' });
    assert.equal(fs.existsSync(path.join(tmpDir, 'nested', 'dir', 'b.txt')), false);
  });

  it('enforces folder jail, symlink escape, and git-internal protection', async () => {
    await assert.rejects(
      () => app.registry.callTool('read_file', { path: '../outside/secret.txt' }),
      /escapes project folder/
    );

    const linkPath = path.join(tmpDir, 'escape-link');
    fs.symlinkSync(outsideDir, linkPath);
    await assert.rejects(
      () => app.registry.callTool('read_file', { path: 'escape-link/secret.txt' }),
      /escapes project folder/
    );
    fs.unlinkSync(linkPath);

    await assert.rejects(
      () => app.registry.callTool('write_file', { path: '.git/config', content: '[core]' }),
      /git internals/
    );
  });

  it('enforces read-only mode and shell-off default', async () => {
    await assert.rejects(
      () => app.registry.callTool('execute_command', { command: 'echo hi' }),
      /Shell is off/
    );

    app.state.readOnly = true;
    await assert.rejects(
      () => app.registry.callTool('write_file', { path: 'ro.txt', content: 'x' }),
      /read-only/
    );
    app.state.readOnly = false;
  });

  it('blocks admin routes when tunnel proxy headers are present', async () => {
    const ok = await request(port, 'GET', '/');
    assert.equal(ok.status, 200);
    assert.match(ok.text, /easymcp-refactored/);
    assert.doesNotMatch(ok.text, /slotPromo|Cinzel/);

    const blocked = await request(port, 'GET', '/api/dashboard', {
      headers: { 'cf-ray': '12345', 'x-easymcp-admin': app.state.adminSecret },
    });
    assert.equal(blocked.status, 404);
  });

  it('blocks private/loopback hosts in SSRF helper', () => {
    assert.equal(isPrivateHost('127.0.0.1'), true);
    assert.equal(isPrivateHost('localhost'), true);
    assert.equal(isPrivateHost('192.168.1.10'), true);
    assert.equal(isPrivateHost('169.254.169.254'), true);
    assert.equal(isPrivateHost('example.com'), false);
  });
});
