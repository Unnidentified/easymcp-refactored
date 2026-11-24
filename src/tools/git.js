'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { realpathOrAncestor, resolveInProject } = require('../security');

function runGit(state, gitArgs, timeoutMs = 30000) {
  const safeArgs = [
    '--no-pager',
    '-c',
    'core.pager=cat',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'diff.external=',
    ...gitArgs,
  ];
  const env = { ...process.env };
  if (!state.skipJail) {
    env.GIT_CEILING_DIRECTORIES = path.dirname(realpathOrAncestor(state.projectRoot));
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      safeArgs,
      { cwd: state.projectRoot, shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return resolve({ exitCode: -1, output: 'git not found on this machine' });
        resolve({
          exitCode: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          output: ((stdout || '') + (stderr || '')).trim(),
        });
      }
    );
  });
}

function safeGitRelPath(state, p) {
  if (String(p).includes('\0')) throw new Error('Invalid path');
  const abs = resolveInProject(state, p);
  const rel = path.relative(realpathOrAncestor(state.projectRoot), abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith(':')) {
    throw new Error(`Path escapes project folder: ${p}`);
  }
  return rel;
}

function createGitTools(state) {
  return [
    {
      name: 'git_status',
      description: 'Run git status in the project folder.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: async () => (await runGit(state, ['status', '--short', '--branch'])).output || '(clean)',
    },
    {
      name: 'git_diff',
      description: 'Run git diff in the project folder (optionally staged and/or for one path).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          staged: { type: 'boolean' },
        },
      },
      readOnly: true,
      run: async ({ path: p, staged = false }) => {
        const args = ['diff', '--no-ext-diff', '--no-textconv'];
        if (staged) args.push('--cached');
        if (p) args.push('--', safeGitRelPath(state, p));
        return (await runGit(state, args)).output || '(no diff)';
      },
    },
    {
      name: 'git_log',
      description: 'Show recent git commits in the project folder.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          path: { type: 'string' },
        },
      },
      readOnly: true,
      run: async ({ limit = 20, path: p }) => {
        const n = Math.min(100, Math.max(1, Number(limit) || 20));
        const args = ['log', `-${n}`, '--oneline', '--decorate'];
        if (p) args.push('--', safeGitRelPath(state, p));
        return (await runGit(state, args)).output || '(no commits)';
      },
    },
    {
      name: 'git_show',
      description: 'Show details and diff for a specific git commit or ref.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
      readOnly: true,
      run: async ({ ref }) => {
        const cleanRef = String(ref || '').trim();
        if (!cleanRef || cleanRef.startsWith('-') || /[\s\0]/.test(cleanRef)) {
          throw new Error('Invalid git ref');
        }
        return (await runGit(state, ['show', '--stat', '--patch', cleanRef])).output || '(empty)';
      },
    },
    {
      name: 'git_branches',
      description: 'List local and remote git branches.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: async () => (await runGit(state, ['branch', '-a', '--no-color'])).output || '(no branches)',
    },
  ];
}

module.exports = { createGitTools, runGit };
