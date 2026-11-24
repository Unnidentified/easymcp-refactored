'use strict';

const fs = require('fs');
const path = require('path');
const { resolveInProject, relOf } = require('../security');
const { readTextFile, SKIP_DIRS } = require('./files');

function walkFiles(dir, out = [], depth = 0, maxFiles = 5000) {
  if (depth > 14 || out.length >= maxFiles) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out, depth + 1, maxFiles);
    else if (e.isFile()) out.push(full);
    if (out.length >= maxFiles) break;
  }
  return out;
}

function globToRegex(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function createSearchTools(state) {
  return [
    {
      name: 'search_files',
      description: 'Search file contents for text or regex across the project (skips node_modules/.git and binary files).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          regex: { type: 'boolean' },
          case_sensitive: { type: 'boolean' },
          glob: { type: 'string', description: 'Optional relative path glob filter, e.g. "*.js" or "src/**/*.ts"' },
          max_results: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['query'],
      },
      readOnly: true,
      run: ({ query, path: p, regex = false, case_sensitive = true, glob = '', max_results = 200 }) => {
        const base = resolveInProject(state, p || '.');
        const files = fs.statSync(base).isDirectory() ? walkFiles(base) : [base];
        const limit = Math.min(500, Math.max(1, Number(max_results) || 200));
        const globRe = glob ? globToRegex(glob) : null;
        let matcher;
        if (regex) {
          matcher = new RegExp(query, case_sensitive ? '' : 'i');
        }
        const needle = case_sensitive ? query : query.toLowerCase();
        const hits = [];

        for (const f of files) {
          const rel = relOf(state, f);
          if (globRe && !globRe.test(rel) && !globRe.test(path.basename(rel))) continue;
          try {
            if (fs.statSync(f).size > 2 * 1024 * 1024) continue;
          } catch {
            continue;
          }
          let text;
          try {
            text = readTextFile(f);
          } catch {
            continue;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const matched = regex
              ? matcher.test(line)
              : (case_sensitive ? line : line.toLowerCase()).includes(needle);
            if (matched) {
              hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
              if (hits.length >= limit) break;
            }
          }
          if (hits.length >= limit) break;
        }
        return hits.length ? hits.join('\n') : 'No matches.';
      },
    },
    {
      name: 'find_files',
      description: 'Find files by name or glob pattern (e.g. "*.test.js", "src/**") in the project folder.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          max_results: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['pattern'],
      },
      readOnly: true,
      run: ({ pattern, path: p, max_results = 200 }) => {
        const base = resolveInProject(state, p || '.');
        const files = fs.statSync(base).isDirectory() ? walkFiles(base) : [base];
        const limit = Math.min(500, Math.max(1, Number(max_results) || 200));
        const re = globToRegex(pattern);
        const hits = [];
        for (const f of files) {
          const rel = relOf(state, f);
          if (re.test(rel) || re.test(path.basename(rel))) {
            hits.push(rel);
            if (hits.length >= limit) break;
          }
        }
        return hits.length ? hits.join('\n') : 'No matching files.';
      },
    },
  ];
}

module.exports = { createSearchTools, walkFiles };
