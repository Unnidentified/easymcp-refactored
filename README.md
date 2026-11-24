# Easy MCP

Zero-dependency Model Context Protocol (MCP) server that exposes a local project folder to web and desktop AI clients, paired with a local-only web control plane.

## Quickstart

Requires Node.js 18+.

```bash
node easy-mcp.js /path/to/your/project
```

On Windows, you can also double-click `easy-mcp.bat`.

What happens:
1. A local MCP server starts on `127.0.0.1:9494` (or the next free port).
2. A tunnel publishes the MCP endpoint over HTTPS (Cloudflare quick tunnel by default, Tailscale Funnel, or local-only).
3. Your browser opens the local dashboard at `http://127.0.0.1:9494/`.

## Architecture

```
easy-mcp.js          CLI launcher
server.js            Server assembly & lifecycle
src/
  config.js          CLI flags, env vars, ~/.easy-mcp persistence
  security.js        Path jail, symlink checks, loopback/proxy guards, SSRF filter
  oauth.js           OAuth 2.1 + PKCE + Dynamic Client Registration
  tunnel.js          Cloudflare quick tunnel & Tailscale Funnel manager
  jobs.js            Background job runner & process-tree termination
  picker.js          Native OS folder picker
  mcp.js             JSON-RPC 2.0 handler (tools, resources, prompts)
  http.js            Streamable HTTP (/mcp), legacy SSE (/sse, /messages), admin API
  dashboard.html     Local control plane & interactive tool playground
  tools/             Modular tool definitions (files, search, git, shell, web, project)
test/
  run.js             Automated test suite (node:test)
```

## Capabilities

### Tools
- **Files**: `read_file` (with `start_line`/`end_line`), `read_files`, `write_file`, `write_files`, `edit_file`, `delete_file`, `move_file`, `create_directory`, `list_directory` (with `recursive`/`max_depth`), `get_file_info`
- **Search**: `search_files` (text or regex, glob filter, case sensitivity), `find_files` (glob/filename search)
- **Git** (shell-free): `git_status`, `git_diff` (staged or unstaged), `git_log`, `git_show`, `git_branches`
- **Shell & Jobs** (off by default): `execute_command`, `start_job`, `job_status`, `stop_job`, `list_jobs`
- **Web & Project**: `fetch_url` (SSRF-guarded HTTPS fetch with optional `strip_html`), `project_summary`, `get_current_project`, `set_project` (only when jail is disabled)

### MCP Resources & Prompts
- `resources/list` and `resources/read` expose project files via `easymcp://project/<path>`.
- `prompts/list` and `prompts/get` provide `project_overview` and `review_changes`.

## Options

```bash
node easy-mcp.js [folder] [--port 9494] [--cloudflare|--funnel|--no-tunnel]
                          [--no-open] [--read-only] [--enable-shell]
                          [--token <token>] [--rotate-token] [--dangerously-skip-jail]
```

- `--read-only`: Block all file writes, edits, moves, and deletes.
- `--enable-shell`: Enable `execute_command` and `start_job` on startup (off by default).
- `--dangerously-skip-jail`: Disable the project folder jail.
- `--no-tunnel`: Run locally without opening a public tunnel.
- `--no-open`: Do not open the dashboard in a browser on startup.
- `--rotate-token`: Generate a new access token in `~/.easy-mcp/token`.

## Testing

```bash
npm test
```

## License

MIT — see [LICENSE](LICENSE).
