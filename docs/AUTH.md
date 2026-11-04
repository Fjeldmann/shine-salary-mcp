# Authentication and credential storage

shine-salary-mcp logs in to Salary with an **API client** (ID and secret, issued by Salary) plus a **company API key** (created by a company admin in *Virksomhed → Avanceret → API-nøgler*). The key must have read scopes only. `login` checks the key's scopes and refuses to store a key it can't confirm as read-only.

## Logging in

```bash
shine-salary-mcp login                # prompts; secrets are not echoed
shine-salary-mcp status               # offline: store, company, token estimate
shine-salary-mcp status --check       # also logs in and reads companies + key scopes (GET only)
shine-salary-mcp logout
```

For development, `login --from-env` reads `API_CLIENT_ID`, `API_CLIENT_SECRET` and `API_KEY` from the environment, e.g. `node --env-file=.env dist/cli.js login --from-env`. Credentials are never accepted as command-line arguments.

`login` does the following, in order:

1. `POST /v2/auth` with the three values.
2. `GET /v2/companies` and `GET /v2/apiKeys?companyID=` to confirm that exactly one company is visible and that the key's scopes are read-only. Only `ReadAll` has been verified so far. Any other scope makes `login` refuse.
3. Store the credentials and the first access token, then write `state.json` last. An interrupted login leaves the profile logged out.

## Where credentials live

Files go under `$XDG_CONFIG_HOME/shine-salary-mcp/profiles/<profile>/` on Linux and WSL, `~/Library/Application Support/shine-salary-mcp/` on macOS, and `%APPDATA%\shine-salary-mcp\` on Windows. Directories are `0700` and files `0600`. Native Windows (outside WSL) is untested: the permission checks assume POSIX modes. Symlinks, files owned by another user, and group- or world-readable files are refused.

| Backend | Used when | What is stored |
|---|---|---|
| `keyring` | An OS keychain works: macOS Keychain, Windows Credential Manager, or a Linux Secret Service such as gnome-keyring. | Two keychain entries, `default/credentials` and `default/token`, under service `shine-salary-mcp`. |
| `wsl-dpapi` | Running in WSL without a Secret Service. | `credentials.enc` and `token.enc` (AES-256-GCM), plus `wrapping-key.dpapi`: a random key protected by Windows DPAPI for the current Windows user, unwrapped through `powershell.exe` over stdin/stdout. |

`login --backend auto` (the default) picks the first one that passes a real write, read and delete round trip.

On Linux, the keyring backend requires the Secret Service. Without one, `@napi-rs/keyring` falls back to the kernel keyutils store, which forgets everything on reboot, so that fallback is never used.

`wsl-dpapi` needs the Windows user's profile to be loaded. That works when a desktop MCP client launches `wsl.exe`, but not under a Windows service account. Copying the files to another machine or another Windows user makes them unreadable.

`state.json` is not secret. It records the backend, company, scopes at login, and a random *generation* ID.

## Tokens

Salary's access token is opaque and lasts "around one hour". The server assumes 50 minutes and renews 2 minutes early. A 401 also triggers one renewal and one replay of the request.

Renewal runs under a per-profile lock file (`profiles/<profile>.lock`). After taking the lock, a process rereads the stored token first, so several `serve` processes share one login. The lock is stolen only if its holder's PID is dead or the lock is more than 3 minutes old.

## Logout and revocation

`logout` takes the lock and deletes `state.json`, both secrets and the wrapped key. Every token request reads `state.json`, so a running `serve` stops before its next API call.

Local logout does not revoke anything at Salary. To cut off access, delete the company API key in Salary. A token that was already copied stays valid until it expires (about an hour).

## Browser login (interactive alternative)

```bash
npx playwright-core install chromium        # once; playwright-core is an optional dependency
shine-salary-mcp login --method browser     # add --profile web to keep an API-key login alongside
```

A Chromium window opens at app.salary.dk. You sign in there yourself, including Turnstile and MFA. The window closes on its own when the `sally_access_token` session cookie appears, or after 10 minutes. While the window is open, only `POST /v2/login` reaches the API. Every other API call gets an immediate 401 from the server itself, so no payroll data loads into the browser. The login page and Cloudflare Turnstile are not intercepted.

**Trust caveat.** The stored session has every permission your Salary user has, including writes. shine-salary-mcp still only sends allowlisted GET requests, but in this mode read-only is guaranteed by the client, not by the credential. `login` therefore asks you to type `yes`, or to pass `--accept-user-session`. `status` repeats the caveat. The API-key method stays the recommended one.

Before the token is stored, it is checked with `GET /v2/companies`.

The browser itself keeps nothing: there is no profile directory, cache, trace or screenshot. To carry "trust this device" over to the next browser login, Salary's other cookies and localStorage are saved as a third encrypted secret, `browser-state` (max 16 KB). The session cookie itself is never part of it. The next browser login restores them into a fresh browser context.

**Renewal needs you.** There is no way to renew a web session without signing in again. The token is used until Salary rejects it, with no clock-based expiry, because its real lifetime is unknown. When Salary rejects it, the tools answer `AUTH_REQUIRED`, and `state.json` records how long the session lasted (`tokenRejectedAfterMs`). `status` shows that value. This is the token-lifetime probe from the plan, measured through normal use.

`serve` never opens a browser: the browser code can only be reached from the `login` command, and a test enforces this.

## Not supported (v1)

- Email/password login.
- A passphrase-encrypted fallback when no secure store exists. `login` fails with `STORE_UNAVAILABLE` instead.
- Storing credentials in plaintext.
