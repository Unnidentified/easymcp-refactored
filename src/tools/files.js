'use strict';

const fs = require('fs');
const path = require('path');
const { resolveInProject, assertNotGitInternal, relOf } = require('../security');

const MAX_READ_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv']);

function readTextFile(abs) {
  const size = fs.statSync(abs).size;
  if (size > MAX_READ_BYTES) {
    throw new Error(`File too large to read as text (${(size / 1048576).toFixed(1)} MB, limit 10 MB)`);
  }
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error('Binary file, cannot read as text');
  return buf.toString('utf8');
}

function listTree(abs, rootState, { recursive = false, maxDepth = 3, showHidden = false } = {}, depth = 0, out = []) {
  if (depth > maxDepth || out.length >= 2000) return out;
  const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const indent = '  '.repeat(depth);
  for (const e of entries) {
    if (!showHidden && e.name.startsWith('.')) continue;
    const full = path.join(abs, e.name);
    if (e.isDirectory()) {
      out.push(`${indent}[DIR]  ${e.name}/`);
      if (recursive && !SKIP_DIRS.has(e.name) && depth < maxDepth) {
        try {
          listTree(full, rootState, { recursive, maxDepth, showHidden }, depth + 1, out);
        } catch {}
      }
    } else {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {}
      out.push(`${indent}[FILE] ${e.name} (${size} bytes)`);
    }
    if (out.length >= 2000) break;
  }
  return out;
}

function createFileTools(state) {
  return [
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the project folder. Supports optional 1-based start_line and end_line.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
      },
      readOnly: true,
      run: ({ path: p, start_line, end_line }) => {
        const abs = resolveInProject(state, p);
        const lines = readTextFile(abs).split('\n');
        const start = start_line ? Math.max(1, Number(start_line)) : 1;
        const end = end_line ? Math.min(lines.length, Number(end_line)) : lines.length;
        if (start > end && lines.length > 0) {
          throw new Error(`start_line (${start}) exceeds end_line (${end})`);
        }
        const slice = lines.slice(start - 1, end);
        const header = `File: ${relOf(state, abs)} (lines ${start}-${end} of ${lines.length})`;
        return (
          header +
          '\n\n' +
          slice.map((l, idx) => `${String(start + idx).padStart(4)} | ${l}`).join('\n')
        );
      },
    },
    {
      name: 'read_files',
      description: 'Read several UTF-8 text files at once.',
      inputSchema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
        required: ['paths'],
      },
      readOnly: true,
      run: ({ paths }) =>
        (paths || [])
          .map((p) => {
            try {
              return `===== ${p} =====\n${readTextFile(resolveInProject(state, p))}`;
            } catch (e) {
              return `===== ${p} =====\n[error] ${e.message}`;
            }
          })
          .join('\n\n'),
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file in the project folder.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      write: true,
      run: ({ path: p, content }) => {
        const abs = resolveInProject(state, p);
        assertNotGitInternal(state, abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        return `Wrote ${relOf(state, abs)} (${Buffer.byteLength(content)} bytes)`;
      },
    },
    {
      name: 'write_files',
      description: 'Create or overwrite several text files at once.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content'],
            },
          },
        },
        required: ['files'],
      },
      write: true,
      run: ({ files }) =>
        (files || [])
          .map((f) => {
            const abs = resolveInProject(state, f.path);
            assertNotGitInternal(state, abs);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, f.content, 'utf8');
            return `Wrote ${relOf(state, abs)}`;
          })
          .join('\n'),
    },
    {
      name: 'edit_file',
      description: 'Replace an exact text snippet in a file. Fails if old_text is not found or not unique.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
      write: true,
      run: ({ path: p, old_text, new_text }) => {
        const abs = resolveInProject(state, p);
        assertNotGitInternal(state, abs);
        const text = readTextFile(abs);
        const first = text.indexOf(old_text);
        if (first < 0) throw new Error('old_text not found');
        if (text.indexOf(old_text, first + 1) >= 0) throw new Error('old_text is not unique');
        fs.writeFileSync(abs, text.slice(0, first) + new_text + text.slice(first + old_text.length), 'utf8');
        return `Edited ${relOf(state, abs)}`;
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file (or empty directory) inside the project folder.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      write: true,
      run: ({ path: p }) => {
        const abs = resolveInProject(state, p);
        if (abs === resolveInProject(state, '.')) {
          throw new Error('Cannot delete the project root folder');
        }
        assertNotGitInternal(state, abs);
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
          fs.rmdirSync(abs);
        } else {
          fs.unlinkSync(abs);
        }
        return `Deleted ${relOf(state, abs)}`;
      },
    },
    {
      name: 'move_file',
      description: 'Move or rename a file or directory inside the project folder.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'to'],
      },
      write: true,
      run: ({ from, to }) => {
        const src = resolveInProject(state, from);
        const dst = resolveInProject(state, to);
        assertNotGitInternal(state, src);
        assertNotGitInternal(state, dst);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        return `Moved ${relOf(state, src)} -> ${relOf(state, dst)}`;
      },
    },
    {
      name: 'create_directory',
      description: 'Create a directory (including parent directories) inside the project folder.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      write: true,
      run: ({ path: p }) => {
        const abs = resolveInProject(state, p);
        assertNotGitInternal(state, abs);
        fs.mkdirSync(abs, { recursive: true });
        return `Created directory ${relOf(state, abs)}`;
      },
    },
    {
      name: 'list_directory',
      description: 'List files and folders in a project directory. Supports optional recursive listing and max_depth.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean' },
          max_depth: { type: 'integer', minimum: 1, maximum: 8 },
          show_hidden: { type: 'boolean' },
        },
      },
      readOnly: true,
      run: ({ path: p, recursive = false, max_depth = 3, show_hidden = true }) => {
        const abs = resolveInProject(state, p || '.');
        const lines = listTree(abs, state, {
          recursive: Boolean(recursive),
          maxDepth: Math.min(8, Math.max(1, Number(max_depth) || 3)),
          showHidden: Boolean(show_hidden),
        });
        return `Directory: ${relOf(state, abs)}\n\n${lines.join('\n') || '(empty)'}`;
      },
    },
    {
      name: 'get_file_info',
      description: 'Get size, type, permissions and timestamps for a file or folder.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      readOnly: true,
      run: ({ path: p }) => {
        const abs = resolveInProject(state, p);
        const st = fs.statSync(abs);
        return JSON.stringify(
          {
            path: relOf(state, abs),
            type: st.isDirectory() ? 'directory' : 'file',
            size: st.size,
            modified: st.mtime.toISOString(),
            created: st.birthtime.toISOString(),
          },
          null,
          2
        );
      },
    },
  ];
}

module.exports = { createFileTools, readTextFile, SKIP_DIRS };
