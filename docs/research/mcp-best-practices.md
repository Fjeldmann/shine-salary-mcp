# MCP server best practices (November 2026)

A compact research summary to guide shine-mcp v1. Before pinning a version, check it against the linked primary sources. The SDK version numbers came from search summaries.

## Spec

The current revision is **`2026-07-28`** ([changelog](https://modelcontextprotocol.io/specification/latest/changelog)). The previous one was `2025-11-25`.

- **Stateless protocol:**
  - There is no `initialize` handshake and no `Mcp-Session-Id`.
  - Every request carries its version and capabilities in `_meta`.
  - Servers implement `server/discover`.
  - Use an SDK that supports 2026-07-28.
- **Multi Round-Trip Requests (MRTR)** replace server-initiated requests. Elicitation, sampling and roots now return `resultType: "input_required"`, and the client retries. URL-mode elicitation remains the primitive for "open this URL to log in".
- **Deprecated:** roots, sampling and logging. `logging/setLevel` has been removed. Log to **stderr** (stdio) or via OpenTelemetry.
- **Tasks** now live in an extension, `io.modelcontextprotocol/tasks`.
- `inputSchema` and `outputSchema` accept any JSON Schema 2020-12 keyword. `structuredContent` can be any JSON value.
- `tools/list` should be **deterministic in order**, which helps prompt caching. List results can carry `ttlMs` and `cacheScope`.
- **Transport:** use **stdio** for a local, single-user server. Streamable HTTP is for remote or multi-user servers. HTTP+SSE is deprecated.
- **Structured output:** declare an `outputSchema`, return `structuredContent`, and also return a text block of the JSON for older clients.
- **Annotations:** mark every v1 tool `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` and `openWorldHint: true`. Clients treat annotations as hints, not as enforcement.
- **Tools or resources:** models reliably see tools. Resources are read by the application. Make every capability a tool, and optionally expose stable blobs, such as payslip PDFs, as resources too.
- The protocol's pagination only covers `*/list`. Tool results need their own `cursor`/`limit` parameters.

## Tool design

Sources: [Anthropic, "Writing effective tools for agents"](https://www.anthropic.com/engineering/writing-tools-for-agents) and [OpenAI Apps SDK](https://developers.openai.com/apps-sdk).

- **Shape tools around tasks:**
  - Prefer a few high-signal, task-shaped tools over mirroring the API one to one.
  - Do the joins server-side. For example, a payslip summary that already includes the employee name.
  - Use a consistent prefix: `salary_`.
- **Descriptions and schemas:**
  - Write descriptions for a new colleague. Say when to use the tool, explain every parameter, and gloss Danish domain terms (lønperiode, feriepenge, A-skat, AM-bidrag, skattekort).
  - Keep input schemas strict: enums, ISO dates and defaults.
  - Accept human identifiers (a name or employee number) and resolve them to UUIDs internally. Return names next to IDs.
- **Response size:**
  - Accept `response_format: "concise" | "detailed"`, defaulting to concise.
  - Default the limit to 20–50 items.
  - Truncate with a hint such as "N more, pass cursor=…".
  - Drop raw internal fields.
- **Errors:**
  - Return `isError: true` with a next step the model can act on, for example "Session expired: run `shine-mcp login`" or "Did you mean Jens Hansen (#12)?".
  - Never return stack traces.
- **Evaluate:**
  - Write realistic prompts and check which tools the model picks and whether it gets the answer right.
  - Iterate on the descriptions.

## Security for a local server

- **Store credentials in the OS keychain:**
  - Node: `@napi-rs/keyring`. `keytar` is archived.
  - Python: `keyring`.
  - Backends: macOS Keychain, Windows Credential Manager, and Secret Service (libsecret) on Linux.
- **WSL:**
  - WSL often has no Secret Service or D-Bus session.
  - Detect that and fall back to an **encrypted file** under `$XDG_CONFIG_HOME/shine-mcp/`, created with mode `0600` and encrypted with AES-256-GCM.
  - Take the key from a keychain where one exists. Otherwise use a passphrase or a machine-bound key, and warn about the weaker guarantee.
- **Where secrets must not go:**
  - Never into the MCP client config JSON, `.env` files or logs.
  - Redact `Authorization`, `Cookie`, `Set-Cookie` and `apiKey=` query parameters.
- **Payroll data is GDPR personal data:**
  - Mask CPR numbers and bank accounts by default.
  - Never write a response cache to disk.
- **stdout belongs to JSON-RPC on stdio.** Send every log line, and all Playwright output, to stderr.
- **Prompt injection:**
  - Treat returned free text (names, notes, descriptions) as untrusted data. Return it as structured fields.
  - Being read-only limits what an injection can do.
- **Enforce read-only in code:**
  - The HTTP client allows only `GET`, plus the specific `POST` auth endpoints, and only against an endpoint allowlist.
  - Pin the host to `api.salary.dk`.
  - Add timeouts, a modest concurrency limit and backoff on 429/5xx.
- **Concurrency:** take a file lock when refreshing the token, so two server processes don't race.

## Browser login without OAuth

The common pattern, used for example by [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) with `--storage-state`/`--user-data-dir`, and by many community MCPs:

1. A separate CLI command (`shine-mcp login`) launches headed Playwright.
2. The user completes the login, including any MFA or captcha.
3. The command waits for an authenticated signal and captures the cookies or token.
4. It stores them in the keychain.

At runtime the server makes plain HTTP calls with no browser. If a call returns 401, it tries one silent refresh (if the service has one). If that fails, it returns an actionable error or a URL-mode elicitation. Keep the headed browser out of the stdio server process: under WSL it is fragile.

## Testing and packaging

- **Testing:**
  - Use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) (`npx @modelcontextprotocol/inspector`), which also has a CLI mode.
  - Run unit tests with an in-memory client/server pair.
  - Mock HTTP with `msw`/`nock` (TS) or `respx` (Python), using **scrubbed** recorded fixtures.
  - Assert `outputSchema` conformance.
  - Add a test that the HTTP layer rejects non-GET requests.
- **Packaging:**
  - Publish via `npx -y <pkg>` or `uvx <pkg>`.
  - Build a `.mcpb` bundle for Claude Desktop ([anthropics/mcpb](https://github.com/anthropics/mcpb)). Its `sensitive: true` user-config fields go to the OS keychain.
  - Optionally list the server in the [MCP Registry](https://registry.modelcontextprotocol.io).
- **SDKs:**
  - TypeScript SDK v2.x: [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk).
  - Python SDK v2.x: [python-sdk v2.0.0](https://github.com/modelcontextprotocol/python-sdk/releases/tag/v2.0.0).
  - Many tutorials still show the 1.x APIs.
- **Language:** TypeScript is the default recommendation. It has an official SDK, zod schemas that produce both input and output schemas, `@napi-rs/keyring`, first-class Playwright and easy `.mcpb`/npx distribution. Python with `uv` is just as viable.
