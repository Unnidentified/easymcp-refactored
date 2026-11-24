'use strict';

const path = require('path');
const { spawn } = require('child_process');

let activePicker = null;

function pickFolderNative({ signal, timeoutMs = 90000 } = {}) {
  if (activePicker) return Promise.resolve({ status: 'busy', path: null });
  return new Promise((resolve) => {
    let file, sargs;
    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      file = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      sargs = [
        '-NoProfile',
        '-NonInteractive',
        '-InputFormat',
        'None',
        '-STA',
        '-Command',
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [System.Windows.Forms.Application]::EnableVisualStyles(); $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'None'; $f.Width = 1; $f.Height = 1; $f.Opacity = 0; $f.ShowInTaskbar = $true; $f.Text = 'Select project folder'; $f.Show(); $f.Activate(); $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select project folder'; $d.ShowNewFolderButton = $true; try { if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) } else { exit 2 } } finally { $d.Dispose(); $f.Close(); $f.Dispose() }",
      ];
    } else if (process.platform === 'darwin') {
      file = 'osascript';
      sargs = ['-e', 'POSIX path of (choose folder with prompt "Select project folder")'];
    } else {
      file = 'zenity';
      sargs = ['--file-selection', '--directory', '--title=Select project folder'];
    }

    const child = spawn(file, sargs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activePicker = child;
    let settled = false,
      timedOut = false,
      aborted = false,
      out = '',
      err = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (activePicker === child) activePicker = null;
      resolve(result);
    };

    const killChild = () => {
      try {
        child.kill();
      } catch {}
    };

    const onAbort = () => {
      aborted = true;
      killChild();
      finish({ status: 'cancelled', path: null });
    };

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (err.length < 8192) err += d.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
      finish({ status: 'timeout', path: null });
    }, timeoutMs);

    child.on('error', (e) => finish({ status: 'error', path: null, error: e.message }));
    child.on('close', (code) => {
      if (timedOut || aborted) return;
      const picked = out.trim();
      if (code === 0 && picked) return finish({ status: 'ok', path: picked });
      const isCancel =
        (process.platform === 'win32' && (code === 2 || (code === 0 && !picked && !err.trim()))) ||
        (process.platform === 'darwin' && code === 1 && err.includes('-128')) ||
        (process.platform !== 'win32' && process.platform !== 'darwin' && code === 1);
      if (isCancel) return finish({ status: 'cancelled', path: null });
      const detail = err.trim() || `Picker exited with code ${code}`;
      finish({ status: 'error', path: null, error: detail });
    });
  });
}

module.exports = { pickFolderNative };
