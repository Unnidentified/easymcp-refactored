'use strict';

const { recordCall } = require('../config');
const { createFileTools } = require('./files');
const { createSearchTools } = require('./search');
const { createGitTools } = require('./git');
const { createShellTools } = require('./shell');
const { createWebTools } = require('./web');
const { createProjectTools } = require('./project');

function createToolRegistry(state, jobManager) {
  const allTools = [
    ...createFileTools(state),
    ...createSearchTools(state),
    ...createGitTools(state),
    ...createShellTools(state, jobManager),
    ...createWebTools(),
    ...createProjectTools(state),
  ];

  function listTools() {
    return allTools
      .filter((t) => state.skipJail || t.name !== 'set_project')
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.readOnly
          ? { readOnlyHint: true, destructiveHint: false, openWorldHint: Boolean(t.openWorld) }
          : { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      }));
  }

  async function callTool(name, toolArgs) {
    const tool = allTools.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (name === 'set_project' && !state.skipJail) {
      throw new Error('set_project is disabled while the folder jail is on; switch projects in the easymcp-refactored dashboard');
    }
    if (state.readOnly && tool.write) {
      throw new Error('Server is in read-only mode');
    }
    if (state.disableShell && tool.shell) {
      throw new Error(
        'Shell is off (the default). If you need to run tests or a build, ask the user to enable Shell in the easymcp-refactored dashboard.'
      );
    }

    const t0 = Date.now();
    const detail = toolArgs?.path || toolArgs?.command || toolArgs?.query || toolArgs?.pattern || toolArgs?.url || '';
    try {
      const result = await tool.run(toolArgs || {});
      recordCall(state, name, true, Date.now() - t0, detail);
      return String(result);
    } catch (err) {
      recordCall(state, name, false, Date.now() - t0, detail);
      throw err;
    }
  }

  return {
    allTools,
    listTools,
    callTool,
  };
}

module.exports = { createToolRegistry };
