'use strict';

const fs = require('fs');
const path = require('path');
const { relOf, resolveInProject } = require('./security');
const { walkFiles } = require('./tools/search');
const { readTextFile } = require('./tools/files');

const PROMPTS = [
  {
    name: 'project_overview',
    description: 'Summarize the architecture, entry points, and key files of the current project.',
    arguments: [],
    build: (state) => ({
      description: 'Project architecture overview',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Inspect the project at "${state.projectRoot}" using project_summary, list_directory, and read_file on key manifests/entrypoints, then provide a concise architecture overview.`,
          },
        },
      ],
    }),
  },
  {
    name: 'review_changes',
    description: 'Review uncommitted git changes in the current project for bugs, edge cases, and style.',
    arguments: [],
    build: () => ({
      description: 'Review uncommitted git changes',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Run git_status and git_diff, inspect affected files with read_file as needed, and give a focused code review highlighting bugs, security issues, and improvements.',
          },
        },
      ],
    }),
  },
];

function createMcpHandler(state, registry) {
  function listResources() {
    const files = walkFiles(state.projectRoot, [], 0, 200);
    return files.map((abs) => {
      const rel = relOf(state, abs);
      return {
        uri: `easymcp-refactored://project/${encodeURIComponent(rel)}`,
        name: rel,
        mimeType: 'text/plain',
      };
    });
  }

  function readResource(uri) {
    const prefix = 'easymcp-refactored://project/';
    if (!String(uri || '').startsWith(prefix)) {
      throw new Error(`Unsupported resource URI: ${uri}`);
    }
    const rel = decodeURIComponent(uri.slice(prefix.length));
    const abs = resolveInProject(state, rel);
    const text = readTextFile(abs);
    return {
      contents: [{ uri, mimeType: 'text/plain', text }],
    };
  }

  async function handleRpc(msg) {
    const { id, method, params } = msg || {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params?.protocolVersion || '2025-03-26',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: { name: 'easymcp-refactored', version: state.version },
        });
      case 'notifications/initialized':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: registry.listTools() });
      case 'tools/call':
        try {
          const text = await registry.callTool(params?.name, params?.arguments);
          return reply({ content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
      case 'resources/list':
        return reply({ resources: listResources() });
      case 'resources/read':
        try {
          return reply(readResource(params?.uri));
        } catch (err) {
          return fail(-32602, err.message);
        }
      case 'prompts/list':
        return reply({
          prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })),
        });
      case 'prompts/get': {
        const prompt = PROMPTS.find((p) => p.name === params?.name);
        if (!prompt) return fail(-32602, `Unknown prompt: ${params?.name}`);
        return reply(prompt.build(state, params?.arguments || {}));
      }
      default:
        return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
    }
  }

  return { handleRpc };
}

module.exports = { createMcpHandler };
