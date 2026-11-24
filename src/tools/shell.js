'use strict';

const { resolveInProject } = require('../security');

function createShellTools(state, jobManager) {
  return [
    {
      name: 'execute_command',
      description:
        'Run a shell command inside the project folder. Returns exit code and output. Shell is OFF by default — if disabled, ask the user to enable Shell in the Easy MCP dashboard.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Optional subdirectory relative to project root' },
          timeout_ms: { type: 'number' },
        },
        required: ['command'],
      },
      shell: true,
      run: async ({ command, cwd, timeout_ms }) => {
        const workDir = cwd ? resolveInProject(state, cwd) : state.projectRoot;
        const r = await jobManager.runCommand(command, {
          timeoutMs: Math.min(Number(timeout_ms) || 120000, 600000),
          cwd: workDir,
        });
        return `Exit code: ${r.exitCode}\n\n${r.output || '(no output)'}`;
      },
    },
    {
      name: 'start_job',
      description: 'Start a long-running background command (dev server, watcher). Returns a job id.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Optional subdirectory relative to project root' },
        },
        required: ['command'],
      },
      shell: true,
      run: ({ command, cwd }) => {
        const workDir = cwd ? resolveInProject(state, cwd) : state.projectRoot;
        const job = jobManager.startJob(command, workDir);
        return `Started ${job.id} (pid ${job.pid}): ${command}`;
      },
    },
    {
      name: 'job_status',
      description: 'Check a background job status and recent output.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tail_chars: { type: 'integer', minimum: 100, maximum: 50000 },
        },
        required: ['id'],
      },
      readOnly: true,
      run: ({ id, tail_chars = 4000 }) => {
        const job = jobManager.jobs.get(id);
        if (!job) throw new Error(`Unknown job: ${id}`);
        const n = Math.min(50000, Math.max(100, Number(tail_chars) || 4000));
        return `${job.id}: ${job.status}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ''}\nCommand: ${job.command}\nStarted: ${job.startedAt}\n\n${job.log.slice(-n) || '(no output yet)'}`;
      },
    },
    {
      name: 'stop_job',
      description: 'Stop a running background job.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: ({ id }) => {
        const job = jobManager.stopJob(id);
        if (!job) throw new Error(`Unknown job: ${id}`);
        return `Stopped ${id}`;
      },
    },
    {
      name: 'list_jobs',
      description: 'List all background jobs.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: () =>
        jobManager.jobs.size
          ? [...jobManager.jobs.values()].map((j) => `${j.id}: ${j.status} — ${j.command}`).join('\n')
          : 'No jobs.',
    },
  ];
}

module.exports = { createShellTools };
