'use strict';

const { spawn, execFile } = require('child_process');

function shellCommand(command) {
  return process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { file: '/bin/sh', args: ['-c', command] };
}

function killPidTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      return;
    } catch {}
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
      return;
    } catch {}
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
}

function createJobManager(state) {
  const jobs = new Map();
  let jobSeq = 0;

  function startJob(command, cwd = state.projectRoot) {
    const id = `job-${++jobSeq}`;
    const { file, args: sargs } = shellCommand(command);
    const child = spawn(file, sargs, {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const job = {
      id,
      command,
      cwd,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      status: 'running',
      exitCode: null,
      log: '',
    };
    const push = (d) => {
      job.log += d.toString();
      if (job.log.length > 200000) job.log = job.log.slice(-200000);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('close', (code) => {
      if (job.status === 'running') {
        job.status = 'exited';
        job.exitCode = code;
      }
    });
    child.on('error', (err) => {
      job.status = 'error';
      job.log += `\n${err.message}`;
    });
    jobs.set(id, job);
    return job;
  }

  function stopJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    killPidTree(job.pid);
    job.status = 'stopped';
    return job;
  }

  function stopAll() {
    for (const job of jobs.values()) {
      if (job.status === 'running') {
        killPidTree(job.pid);
        job.status = 'stopped';
      }
    }
  }

  function runCommand(command, { timeoutMs = 120000, cwd = state.projectRoot } = {}) {
    return new Promise((resolve) => {
      const { file, args: sargs } = shellCommand(command);
      const child = spawn(file, sargs, {
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let out = '';
      const push = (d) => {
        out += d.toString();
        if (out.length > 300000) out = out.slice(-300000);
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      const timer = setTimeout(() => {
        killPidTree(child.pid);
        out += '\n[timed out]';
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, output: out.trim() });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, output: err.message });
      });
    });
  }

  function list() {
    return [...jobs.values()].map((j) => ({
      id: j.id,
      command: j.command,
      cwd: j.cwd,
      status: j.status,
      exitCode: j.exitCode,
      startedAt: j.startedAt,
      log: j.log,
    }));
  }

  return {
    jobs,
    startJob,
    stopJob,
    stopAll,
    runCommand,
    list,
  };
}

module.exports = { createJobManager, killPidTree };
