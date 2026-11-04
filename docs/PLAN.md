# shine-salary-mcp v1 plan

## 1. Scope and architecture

Build a local, single-user MCP server for **Shine Salary at `api.salary.dk`**. v1 reads company, employee, payroll, payslip, and time-registration information. It cannot change payroll data.

Use three independent protections:

1. A company API key provisioned with read-only scopes.
2. A data client restricted to reviewed GET endpoints and parameters.
3. Tools exposing specific tasks, without arbitrary HTTP access.

Authentication POSTs live in a separate adapter. They obtain credentials only; no payroll mutation endpoint is reachable through it.

The repository currently contains research, with no application scaffold. Use [API discovery](research/salary-api-discovery.md), the [documented GET inventory](research/salary-api-get-endpoints.md), and [MCP research](research/mcp-best-practices.md) as the starting evidence. Keep unresolved observations explicit.

## 2. Language, dependencies, and protocol

Choose **TypeScript, Node.js, and the official MCP SDK v2**. TypeScript supports shared runtime schemas, Playwright, native keyring integration, and straightforward npm and desktop-bundle distribution.

The official SDK now uses `@modelcontextprotocol/server` and `@modelcontextprotocol/client`; the older `@modelcontextprotocol/sdk` package belongs to v1. Before implementation, verify and pin the latest stable v2 patch, compatible schema-library version, Node LTS, TypeScript, Playwright, keyring library, Inspector, and MCPB tooling. Record exact versions and supported platforms in the lockfile and README. See the [official SDK](https://github.com/modelcontextprotocol/typescript-sdk).

Use **stdio**. Implement the 2026-07-28 protocol through the SDK: `server/discover`, per-request version/capability metadata, and required `resultType`. Do not copy older initialization flows. Return deterministic tool ordering and required list cache metadata. Tool definitions contain no account data; use private caching conservatively. No resources, sampling, roots, task extension, or elicitation is necessary for v1. See the [current specification changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

Test actual target clients. Advertise older protocol support only where the SDK provides a tested compatibility path; otherwise document the minimum supported client version.

## 3. Files and responsibilities

Create these files and directories:

| Files | Responsibility |
|---|---|
| `package.json`, lockfile, `tsconfig.json` | CLI binary, strict compilation, pinned dependencies, build/check scripts. |
| `src/cli.ts`, `src/commands/` | `login`, `status`, `logout`, `serve`; terminal interaction stays outside MCP handlers. |
| `src/server.ts` | SDK registration, schemas, annotations, deterministic tool list, stdio lifecycle. |
| `src/auth/store.ts`, `keyring.ts`, `encrypted-file.ts` | Versioned secret records, secure persistence, migration, atomic replacement. |
| `src/auth/token-manager.ts`, `lock.ts` | Expiry, renewal, cross-process coordination, credential generations. |
| `src/auth/api-client.ts`, `browser-login.ts` | Separate authentication mechanisms and narrowly permitted auth requests. |
| `src/api/client.ts`, `allowlist.ts`, `schemas.ts` | Fixed-origin GET transport, endpoint/query policies, response validation. |
| `src/domain/` | Company ownership checks, employee resolution, joins, pagination, money/date handling. |
| `src/tools/` | One module per task-shaped tool and shared result schemas. |
| `src/privacy/`, `src/errors.ts` | Field projections, identifier masking, safe diagnostics, actionable errors. |
| `tests/`, `tests/fixtures/`, `evals/` | Unit/integration/security tests, synthetic or scrubbed fixtures, task evaluations. |
| `packaging/`, `.github/workflows/` | MCPB manifests, platform builds, validation and release workflow. |
| `README.md`, `SECURITY.md`, `docs/AUTH.md`, `docs/CLIENTS.md` | Setup, trust boundary, credential recovery/revocation, client examples. |

Commit only reviewed API schemas needed by these tools. Do not generate executable access to all 93 GET endpoints.

## 4. Read-only HTTP boundary

The data client accepts an endpoint identifier and validated parameters, never a URL or caller-supplied method. Pin HTTPS origin to `https://api.salary.dk`, validate UUID path segments, reject unknown query keys, and disable redirects. Do not forward credentials to download URLs or alternate hosts.

Use the raw header **`Authorization: <token>`**, without `Bearer`. Never use query-string authentication.

Maintain an explicit allowlist containing only the endpoints below. GET alone is insufficient: exclude sensitive or potentially consequential endpoints such as recovery-code retrieval, invitations, and report generation.

Only the auth adapter may POST, and only to `/v2/auth`. It does not accept arbitrary paths or bodies from tools.

Apply bounded response sizes, deadlines, cancellation, concurrency limits, and capped jittered retries for 429 and transient 5xx responses. Respect `Retry-After`; do not retry permission failures. Set an overall request budget so pagination and joins cannot expand indefinitely.

## 5. v1 tools

All endpoints below are **documented**. Paths are prefixed with `/v2`. No undocumented endpoint is required.

Common inputs: explicit `company_id` except company discovery, `response_format: concise|detailed` defaulting to concise, and `limit`/opaque `cursor` on collections. Default limit 25, maximum 100. Validate ISO dates, UUIDs, ranges, and unknown fields.

| Tool | Inputs and output | Endpoints composed |
|---|---|---|
| `salary_company_overview` | Optional company ID. Without it, return authorized company choices; with it, return company identity, active payrolls, statistics, warnings, and section availability. | `/companies`, `/companies/{companyID}`, `/companies/{companyID}/activePayrolls`, `/companies/{companyID}/statistics/overview`, `/warnings?companyID=` |
| `salary_find_employees` | Company, optional name or employee-number query, cursor/limit. Return IDs, names, employee numbers, and employment status where available. | `/employees?companyID=`, optionally documented `employeeNumber=`; bounded server-side name filtering. |
| `salary_employee_summary` | Company and employee ID or human identifier. Return employment/contract context, department, and selected remuneration fields. Ambiguous matches return candidates. | `/employees`, `/employees/{employeeID}`, `/employments?employeeID=`, `/employeeContracts?employeeID=`, `/departments?companyID=` |
| `salary_payroll_overview` | Company, date range and cursor, or a payroll ID. Return payroll periods/statuses; detail mode adds deviations and transfer status/totals. | `/payRolls?companyID=&from=&to=`, `/payRolls/{id}`, `/payRollDeviations?payRollID=`, `/transfers?payRollID=` |
| `salary_payslip_summary` | Company plus employee or payroll selector; optional payslip ID. Return employee-labelled gross/net, A-tax, AM contribution, pension, holiday-pay and line-item summaries where present. | `/paySlips?employeeID=|payRollID=`, `/paySlips/{id}`, `/employees/{employeeID}`; payroll lookup when needed for ownership. |
| `salary_time_summary` | Company, date range, optional employee and documented state filter. Return registration rows and totals grouped by employee/type, with leave-type labels. | `/timeRegistrations`, `/leaveTypes?companyID=`; employee lookup for labels. |

Avoid undocumented `includeActiveContract` and `includeActiveEmployment` query flags; compose documented employment/contract endpoints instead. `/leaveBalances`, `/dashboard`, and other observed undocumented routes remain excluded. Time registrations must not be presented as an authoritative remaining leave balance.

Enforce company membership for every supplied employee, payroll, and payslip ID, including detail endpoints lacking a company parameter. Never select the first company or ambiguous person silently.

Results include retrieval time, company context, section status, pagination/truncation information, and source endpoint identifiers. Missing permission is distinguishable from empty data. Mark incomplete totals; preserve currency and decimal accuracy. Paginated joins are not transactional snapshots.

Declare input/output schemas and return matching `structuredContent` plus a text JSON representation. Describe Danish payroll terms and tool selection clearly. Set `readOnlyHint`, `destructiveHint: false`, `idempotentHint`, and `openWorldHint`; annotations supplement enforcement.

## 6. Authentication and persistence

### Primary: durable API credentials

`shine-salary-mcp login --method api` securely prompts for `apiClientID`, `apiClientSecret`, and the company API key. Obtain the API client through `dev@salary.dk`; a company administrator creates the scoped key in Salary.

Require read-only provisioning and document the selected scopes. Confirm access with necessary GETs. Successful reads do **not** prove write access is absent: verify scopes through available authoritative metadata or the provisioning UI, never through a mutation probe. `GET /v2/apiKeys?companyID=` is that metadata: it reports the key's `scopes` (verified 2026-11-04: `["ReadAll"]`). `status --check` should warn when the scopes contain anything other than read scopes.

Persist the credential tuple once. Use `POST /v2/auth` to obtain approximately one-hour access tokens and repeat that exchange silently when needed. There is no refresh-token endpoint. Do not assume the returned `apiClientToken` is a refresh credential.

This is the supported “authenticate once” path across restarts, subject to credential revocation and secure-store availability.

### Storage contract

Use a versioned secret record containing auth mode, credential material, company binding, token acquisition/expiry metadata, and credential generation. Browser mode additionally contains captured token and necessary trusted-device state. Nonsecret configuration stores only profile identifiers, backend selection, and company preferences.

Prefer an OS keychain through a maintained library such as `@napi-rs/keyring`. Feature-test storage and retrieval; do not assume installation means an unlocked backend exists.

For encrypted-file storage, use `$XDG_CONFIG_HOME/shine-salary-mcp/` or the platform equivalent:

- Owner-only directory (`0700`) and files (`0600`), with equivalent Windows ACLs.
- Versioned AES-256-GCM envelope: key identifier/KDF parameters, unique nonce, ciphertext, authentication tag; bind version/profile as associated data.
- Atomic replacement, ownership checks, symlink rejection, bounded parsing, and fail-closed handling of corruption.
- A random encryption key protected by an OS keychain, or a passphrase-derived key using a reviewed memory-hard KDF.

**Never store an unprotected decryption key beside the ciphertext or derive it from public machine identifiers.**

On WSL2, test Secret Service availability first. **Decided (2026-11-03): Windows Credential Manager is an approved backend.** For unattended reboot persistence, support a tested Windows Credential Manager/DPAPI helper protecting the wrapping key, with secrets passed through private IPC rather than arguments. If neither secure backend works, passphrase encryption is supported, but requires unlocking after reboot; it avoids repeated Salary authentication, not local unlocking. `serve` fails promptly with an unlock instruction rather than prompting over stdio. Unattended WSL support is a release gate, not an assumed property of encryption.

### Token renewal and concurrency

Use conservative expiry metadata and a safety margin; do not assume tokens are JWTs. Coordinate renewal through in-process single-flight plus a per-profile cross-process lock. After acquiring the lock, reread the shared encrypted token record before exchanging credentials. Bound lock waits and recover stale ownership safely.

On 401, invalidate the affected token, renew once, and replay the GET once. A second failure returns an auth error. A 403 indicates permissions, not expiry. Retry transient exchange failures within bounds without deleting durable credentials.

All auth changes share the lock. Generation checks prevent an old process from restoring credentials after logout.

### Browser bootstrap (dropped from v1, 2026-11-04)

**Decided (2026-11-04): no browser login in v1.** A Playwright-driven login window was built (branch `feat/m5-browser-login`, not merged). Salary's Cloudflare Turnstile refuses automated browsers ("Sikkerhedstjekket blev blokeret"). Hiding the automation would mean bypassing a bot check, which this plan rules out. The API-key login covers every v1 need with a safer, read-only credential. The token-lifetime probe stays open. The original design is kept below for reference.

`shine-salary-mcp login --method browser` launches headed Playwright at `app.salary.dk`; the user completes Turnstile/MFA. Capture `sally_access_token` and validate it through an allowed GET.

Offer the site's `trustDevice` option. Preserve a dedicated, encrypted browser profile between logins, restoring it only for the CLI. Store only necessary authentication state; block payroll fetches during capture and exclude browser caches, traces, screenshots, and downloaded data. A browser profile contains secrets and requires the same protection as credentials.

The token-lifetime probe is pending. A session cookie's lack of `Expires` does not establish server-side invalidation when the browser closes. Until measured, promise no unattended renewal from browser mode.

If the probe establishes a long-lived token, securely reuse it across restarts until rejection. If sliding validity is established, update expiry tracking from verified behavior; do not add artificial keepalive traffic. Neither finding replaces the durable API credential recommendation.

**Decided (2026-11-03): no email/password fallback in v1.** The server never stores a password and never calls `POST /v2/login`. Turnstile, MFA, or an expired session returns control to the foreground browser login rather than attempting bypasses.

### CLI errors and logout

`status` reports mode, backend availability, company binding, expiry estimate, and renewal capability without secrets. Network validation is explicit.

Use stable errors such as `AUTH_REQUIRED`, `STORE_LOCKED`, `CREDENTIALS_REJECTED`, and `SCOPE_REQUIRED`, with terminal commands as next steps. `serve` never launches a browser.

`logout` invalidates the generation and deletes local credentials, token records, and browser profile. Running processes discard credentials before further requests. Explain that local deletion cannot revoke a copied token or undo an already-issued GET. Provider-side revocation requires deleting the company key or using available account-session controls; no revocation API is assumed.

## 7. Privacy and untrusted content

Project API responses into approved fields before constructing output. Mask CPR and bank identifiers in every response, including detailed mode and errors; v1 has no model-selectable unmasking switch. Drop addresses, emergency contacts, and unrelated personal fields. Include scrubbed text handling for identifiers embedded in notes.

Keep payroll responses in memory only: no disk caches, HTTP dumps, browser captures, telemetry payloads, or debug bodies. Authentication persistence is separate. All diagnostics go to stderr; `serve` stdout contains JSON-RPC only.

Redact authorization/cookie headers, passwords, client secrets, API keys, and sensitive URL parameters. Log endpoint identifiers, timings, and safe error codes.

Treat names, notes, and descriptions as untrusted data. Return bounded structured fields, never instructions. Do not follow returned links or let returned text influence endpoints, company scope, or authentication. Document that returned payroll data enters the assistant/client context and its retention policies.

## 8. Verification and distribution

Use Vitest with mocked HTTP and synthetic or irreversibly scrubbed fixtures. Cover schemas, pagination, ambiguous names, company isolation, partial permissions, evolving enums, missing fields, currency arithmetic, and incomplete totals.

Security tests must reject mutation methods, unlisted GETs, unknown query parameters, redirects, hostile URLs, and traversal. Scan outputs/logs for secrets and unmasked identifiers. Test encrypted-file tampering, wrong passphrases, unavailable keyrings, restart persistence, simultaneous renewal, stale locks, logout races, and bounded 401 replay.

Run SDK integration tests and MCP Inspector against the real stdio executable. Evaluate realistic prompts for company selection, payroll questions, ambiguous employees, insufficient scopes, expired auth, and injected notes. Use opt-in read-only live smoke tests; CI contains no real credentials or payroll fixtures.

Publish a pinned npm release usable as `npx -y shine-salary-mcp@<version> serve`. Build platform-appropriate `.mcpb` bundles, validating native keyring dependencies. Follow the [MCPB specification and tooling](https://github.com/modelcontextprotocol/mcpb). Never bundle credentials.

Example desktop configuration:

```json
{"mcpServers":{"shine":{"command":"npx","args":["-y","shine-salary-mcp@<version>","serve"]}}}
```

For a Windows client running the WSL installation:

```json
{"mcpServers":{"shine":{"command":"wsl.exe","args":["-d","<distribution>","--","/absolute/path/to/shine-salary-mcp","serve"]}}}
```

Authenticate in the same OS/user/distribution context first. Verify WSL launch paths, stderr isolation, and protocol compatibility in the documented client matrix.

## 9. Ordered milestones and decisions

1. **Validate contracts:** pin dependencies, confirm minimum client versions, record token-probe results, request API-client registration, and confirm read scopes. *API client registered and read scopes confirmed (2026-11-04); see the discovery doc.*
2. **Establish the boundary:** scaffold CLI/SDK, endpoint allowlist, schemas, redaction, and negative transport tests. *Done (2026-11-04). Every allowlisted path was checked against `swagger.json`; `/v2/employments` and `/v2/paySlips/{id}` exist. `/v2/apiKeys` is undocumented and allowlisted only for the scope self-check, not for tools. `employees.nationalID` is excluded so a CPR number never appears in a URL.*
3. **Complete durable auth:** secure stores, WSL helper, locking, renewal, status/logout, and reboot tests. This gates the persistence promise. *Implemented (2026-11-04), see [AUTH.md](AUTH.md): `keyring` backend (Secret Service forced on Linux, because the keyutils fallback is lost on reboot) and `wsl-dpapi` (AES-256-GCM files, key wrapped by Windows DPAPI via `powershell.exe`). Restart verified with a fresh process; a real Windows reboot is a manual check. Passphrase fallback deferred: `login` fails with `STORE_UNAVAILABLE` when neither backend works.*
4. **Implement tools:** company discovery first, then employee resolution, payroll/payslip joins, and time summaries. *Done (2026-11-04). All six tools were run live against a real company. Deviations and time registrations were empty in the live data, so those paths are only tested with fixtures. `paySlips.list` omits `aggregates`, so the payslip tool fetches each payslip on the page (default 10, max 25). Payslip `fields` (CPR, address, e-mail, phone) are never read.*
5. ~~**Add interactive mode:** protected browser bootstrap.~~ *Dropped (2026-11-04): Turnstile blocks the automated login window; see §6.*
6. **Release validation:** Inspector, evals, client matrix, packaging, installation/logout rehearsal, and security documentation. *Done (2026-11-04): `npm run rehearse` passes against the live API; `SECURITY.md`, `docs/CLIENTS.md`, `evals/scenarios.json` and CI (Ubuntu and macOS) added; the MCPB manifest passes the v0.3 schema. Open: MCP Inspector and `mcpb pack`/`validate` (they run external code via `npx` and need approval), real-client runs, manual evals, and the darwin bundle build on a Mac.*

Main risks are API-client approval delays, incomplete read scopes, unavailable WSL secure storage, browser/MFA changes, SDK/client compatibility, API schema drift, and inconsistent multi-request snapshots. None justifies plaintext credentials, broader endpoints, or silent data omission.

Decided with the user (2026-11-03): Windows Credential Manager is an acceptable storage backend on WSL; no email/password fallback in v1; a read-only company API key has been created, and an API-client request to dev@salary.dk is being sent (verified: the key alone is rejected, `/v2/auth` requires `apiClientID`).

Done (2026-11-04): Salary registered the API client. `POST /v2/auth` returns an opaque access token with no expiry metadata and no `apiClientToken`; there are no rate-limit headers; the company key's scopes are `["ReadAll"]`. Salary does not offer API support, so undocumented behaviour stays out of scope. For local development the credentials live in an untracked `.env` (template: `.env.example`); the shipped CLI still uses the secure store.

Still to resolve during implementation: which companies and read scopes are needed; which clients/OS contexts must work; and whether passphrase unlocking is acceptable where no secure backend exists.

## 10. Explicitly out of scope

Payroll creation/approval, payments, employee edits, uploads, credential administration, arbitrary API access, undocumented business endpoints, PDF/HTML/CSV exports, raw CPR/bank disclosure, background synchronization, persistent payroll caches, remote HTTP hosting, multi-user operation, OAuth-provider implementation, email/password login, and automatic CAPTCHA/MFA bypass.