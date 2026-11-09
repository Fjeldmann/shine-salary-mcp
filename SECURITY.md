# Security

shine-salary-mcp gives an AI assistant read access to payroll data. This page describes what it protects, how, and where the protection ends.

## Trust boundary

| Component | Trusted? | Notes |
|---|---|---|
| Your OS user account | Yes | Anyone who can run code as you can read the stored credentials, just as they could read your browser's cookies. |
| The MCP client (Claude Desktop, Claude Code…) | Yes, for what it is shown | Tool results, which are masked payroll data, enter the assistant's context. The client's and model provider's retention policies apply. |
| The AI model | **No** | It chooses tool calls. Every call is validated, scoped to an allowed company, GET-only and budgeted. Nothing the model sends can change the host, the method or the path. |
| Text inside Salary (names, notes, warning text) | **No** | It is returned as bounded data, never followed as instructions, and never used to choose endpoints or companies. |
| api.salary.dk | Yes | Fixed HTTPS origin, redirects refused. |

## Read-only, three ways

1. **Credential:** `login` only accepts a company API key whose scopes Salary reports as read-only (`ReadAll`), and refuses anything else.
2. **Transport:** the data client builds URLs from an allowlist of 19 reviewed GET endpoints with typed parameters. Callers cannot pass a URL or a method. The only non-GET request in the code is `POST /v2/auth` (login), which sends exactly three fields.
3. **Tools:** six task-shaped tools, all annotated `readOnlyHint: true`. There is no generic "call the API" tool.

## Personal data

- **Never returned:** CPR/CVR numbers, addresses, e-mail, phone numbers, birth dates, bank accounts, pension account/sort code/customer numbers, transfer recipients, the payslip's personal `fields`.
- **How:** tools copy only approved fields into their results. A masking pass then runs over every result as a safety net. It masks identifier fields and scrubs CPR, bank, IBAN and e-mail patterns from all text, and phone numbers from free text.
- **Not stored:** payroll data is never written to disk. There is no cache, no HTTP dump and no telemetry. Logs go to stderr, contain endpoint names, status codes and error codes, and pass through a secret redactor.

## Credentials

See [docs/AUTH.md](docs/AUTH.md) for details.

- **Storage:** the OS keychain, or on WSL AES-256-GCM files whose key is protected by Windows DPAPI. Plaintext storage is not supported.
- **Files:** directories are owner-only `0700` and files `0600`. Symlinks are refused, writes are atomic, and damaged files cause a hard failure instead of a fallback.
- **Revocation:** `logout` deletes everything stored locally. To revoke access at Salary, delete the company API key under *Virksomhed → Avanceret → API-nøgler*. An access token that was already issued stays valid for up to about an hour.

## Known limits

- Native Windows has no POSIX modes, so file mode and ownership checks don't apply there, and symlinks are refused only on write. Secrets live in the Windows Credential Manager, and the profile folder relies on the user-only ACL of `%APPDATA%`. The WSL setup in [docs/CLIENTS.md](docs/CLIENTS.md) keeps the full checks.
- `/v2/apiKeys` is undocumented. It is used only by `login` and `status --check` to read the key's scopes.
- Paginated joins are not transactional: results built from several requests can mix states if Salary changes data between them.

## Reporting a problem

Please report security issues privately to the maintainers at Fjeldmann ApS rather than in a public issue.
