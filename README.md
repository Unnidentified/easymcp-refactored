# easymcp-refactored

Connect a local project folder to Claude, ChatGPT, or Gemini over MCP. One command, zero dependencies, local web dashboard.

## Run

Requires [Node.js 18+](https://nodejs.org/). Open Terminal / PowerShell in your project folder and run:

```bash
npx -y github:Unnidentified/easymcp-refactored
```

Or target a specific folder:

```bash
npx -y github:Unnidentified/easymcp-refactored /path/to/your/project
```

On Windows, you can also download the repo and double-click `easymcp-refactored.bat`.

## How it works

1. Starts a local MCP server on `127.0.0.1:9494`.
2. Opens a public HTTPS tunnel (Cloudflare by default, or Tailscale Funnel).
3. Opens the dashboard in your browser — copy the **MCP URL** and paste it into your AI client's custom MCP connector.

File access is jailed to your project folder, and shell commands are **off by default** (toggleable in the dashboard).

## Options

- `--read-only` — block all file writes and edits
- `--enable-shell` — allow running shell commands
- `--funnel` — use Tailscale Funnel for a persistent link
- `--no-tunnel` — local only (no public URL)
- `--port <n>` — use a custom port

## License

MIT — see [LICENSE](LICENSE).
