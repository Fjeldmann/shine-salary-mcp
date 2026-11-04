# shine-salary-mcp

This is a local [Model Context Protocol](https://modelcontextprotocol.io) server. It gives an AI assistant **read-only** access to a [Shine Salary](https://app.salary.dk) account. Shine Salary was formerly Salary.dk.

Status: **milestone 2 of 6** (read-only HTTP boundary). `serve` runs a working MCP server over stdio, but it exposes no tools yet. Secure credential storage (`login`/`logout`) is milestone 3.

## What exists

| Path | What it does |
|---|---|
| `src/api/allowlist.ts` | The reviewed Salary endpoints (GET only) and their allowed query parameters. |
| `src/api/request.ts`, `src/api/client.ts` | Builds URLs on `https://api.salary.dk` only, validates every parameter, blocks redirects, caps response size, and retries 429/502–504 within a budget. Handles 401 with one renewal and one replay. |
| `src/auth/api-client.ts` | The only non-GET call: `POST /v2/auth` with the API client ID, secret and company API key. |
| `src/privacy/redact.ts`, `src/log.ts` | Masks CPR, bank and IBAN identifiers, drops personal fields, and redacts secrets from logs (stderr only). |
| `src/server.ts`, `src/cli.ts` | `serve` (stdio, 2026-07-28 protocol plus 2025-era initialize) and `status [--check]`. |

## Development

Requirements: Node.js 24 or later.

```bash
npm ci
npm run check        # typecheck, build, unit + stdio tests (no network)
```

To try the real API, copy `.env.example` to `.env` and fill in the API client ID, secret and company API key. `.env` is git-ignored. Reading credentials from the environment is **for development only** and stays off unless you turn it on:

```bash
npm run build
SHINE_SALARY_DEV_ENV_CREDENTIALS=1 node --env-file=.env dist/cli.js status --check
SHINE_SALARY_DEV_ENV_CREDENTIALS=1 npm run smoke:live
```

Both commands send only GET requests after logging in. They print company names, counts and the API key's scopes, but never tokens, keys or personal data. `status --check` exits with code 3 if the key's scopes can't be confirmed as read-only.

## Pinned versions

| Package | Version |
|---|---|
| `@modelcontextprotocol/server` | 2.4.0 |
| `zod` | 4.6.7 |
| `commander` | 15.0.0 |
| `typescript` | 7.0.2 |
| `vitest` | 5.0.5 |
| `@types/node` | 24.19.2 |

## Docs

- [`docs/PLAN.md`](docs/PLAN.md) has the v1 implementation plan.
- [`docs/research/salary-api-discovery.md`](docs/research/salary-api-discovery.md) covers what the Salary API exposes and how auth works.
- [`docs/research/salary-api-get-endpoints.md`](docs/research/salary-api-get-endpoints.md) lists the documented GET endpoints.
- [`docs/research/mcp-best-practices.md`](docs/research/mcp-best-practices.md) summarises current MCP best practices.
