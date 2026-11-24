'use strict';

const fs = require('fs');
const path = require('path');
const { setProjectRoot } = require('../config');
const { runGit } = require('./git');

function createProjectTools(state) {
  return [
    {
      name: 'get_current_project',
      description: 'Return the current project folder.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: () => state.projectRoot,
    },
    {
      name: 'set_project',
      description: 'Switch the project folder all tools operate on (only available when folder jail is disabled).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      run: ({ path: p }) => {
        setProjectRoot(state, p);
        return `Project folder: ${state.projectRoot}`;
      },
    },
    {
      name: 'project_summary',
      description: 'Get a concise overview of the current project: top-level files, detected manifests, and git branch.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: async () => {
        const entries = fs.readdirSync(state.projectRoot, { withFileTypes: true }).sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const top = entries.slice(0, 50).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        const manifests = ['package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'README.md'].filter(
          (f) => fs.existsSync(path.join(state.projectRoot, f))
        );
        const git = await runGit(state, ['rev-parse', '--abbrev-ref', 'HEAD']);
        return JSON.stringify(
          {
            projectRoot: state.projectRoot,
            readOnly: state.readOnly,
            shellEnabled: !state.disableShell,
            gitBranch: git.exitCode === 0 ? git.output : null,
            manifests,
            topLevel: top,
          },
          null,
          2
        );
      },
    },
  ];
}

module.exports = { createProjectTools };
