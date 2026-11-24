#!/usr/bin/env node
'use strict';

const { createState } = require('./src/config');
const { createOAuthManager } = require('./src/oauth');
const { createTunnelManager } = require('./src/tunnel');
const { createJobManager } = require('./src/jobs');
const { createToolRegistry } = require('./src/tools');
const { createMcpHandler } = require('./src/mcp');
const { createHttpServer } = require('./src/http');

function createApp(argv = process.argv.slice(2), env = process.env) {
  const state = createState(argv, env);
  const jobManager = createJobManager(state);
  const registry = createToolRegistry(state, jobManager);
  const mcpHandler = createMcpHandler(state, registry);
  const oauth = createOAuthManager(state);
  const tunnel = createTunnelManager(state);
  const server = createHttpServer({ state, registry, mcpHandler, oauth, tunnel, jobManager });

  function shutdown() {
    tunnel.stopTunnel();
    jobManager.stopAll();
    try {
      server.close();
    } catch {}
  }

  return { state, jobManager, registry, mcpHandler, oauth, tunnel, server, shutdown };
}

if (require.main === module) {
  const app = createApp();
  const { state, tunnel, server, shutdown } = app;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${state.port} is already in use. Stop the old instance or use --port <n>.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(state.port, '127.0.0.1', () => {
    console.log(`Easy MCP server on http://127.0.0.1:${state.port} — project: ${state.projectRoot}`);
    tunnel.startTunnel(state.tunnelMode).catch((err) => {
      state.tunnelError = err.message;
    });
    if (state.skipJail) {
      console.log('WARNING: --dangerously-skip-jail is ON. Tools can access the entire machine.');
    }
  });

  const onSignal = () => {
    shutdown();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

module.exports = { createApp };
