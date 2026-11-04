# Connecting MCP clients

Log in once in the same OS user and environment the client will start the server in (see [AUTH.md](AUTH.md)):

```bash
shine-salary-mcp login        # or: node /path/to/shine-salary-mcp/dist/cli.js login
shine-salary-mcp status --check
```

The server talks MCP over stdio and supports the 2026-07-28 protocol (`server/discover`) as well as 2025-era clients that start with `initialize`. It never prompts and never opens a browser. If you are not logged in, it still starts, and every tool replies `AUTH_REQUIRED` with the command to run.

## Claude Code (WSL or Linux/macOS)

```bash
claude mcp add shine-salary -- node /absolute/path/to/shine-salary-mcp/dist/cli.js serve
```

## Claude Desktop on Windows, server in WSL

Credentials are stored in WSL (the `wsl-dpapi` backend), so let the client start the server inside WSL. In `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shine-salary": {
      "command": "wsl.exe",
      "args": ["-d", "Ubuntu", "--", "node", "/home/<you>/code/shine-salary-mcp/dist/cli.js", "serve"]
    }
  }
}
```

- Replace `Ubuntu` with the name shown by `wsl -l -v`, and use absolute paths. A login shell isn't started, so `node` must be on the default PATH. If it isn't (for example with nvm), use the absolute path from `which node`.
- The DPAPI key belongs to your Windows user, so it works when Claude Desktop runs as you. It does not work from a service account.

## Claude Desktop on macOS

```json
{ "mcpServers": { "shine-salary": { "command": "node", "args": ["/absolute/path/to/shine-salary-mcp/dist/cli.js", "serve"] } } }
```

The credentials go in the macOS Keychain. The first use may show a Keychain access prompt.

## Other clients

Any stdio MCP client works with the command `node /absolute/path/to/dist/cli.js serve`. Use `--profile <name>` before `serve` to pick a credential profile other than `default`.

## Tested

| Client / harness | Result |
|---|---|
| Raw JSON-RPC over stdio (2026-07-28 and 2025-06-18), `tests/stdio.test.ts` | Passes in CI |
| In-memory MCP round trip calling all six tools against a fake Salary, with outputs checked against the declared schemas (`tests/tools.test.ts`) | Passes in CI |
| Live run of all six tools against a real company (2026-11-04) | Passes, no personal data in any output |
| Installation from the packed tarball: login, status, serve, logout (`npm run rehearse`) | Passes (2026-11-04, live API, isolated config dir) |
| MCP Inspector, Claude Desktop, Claude Code | Not yet run; needs the user's go-ahead (Inspector runs via `npx`) |
