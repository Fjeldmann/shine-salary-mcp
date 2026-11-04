# Shine / Salary.dk API discovery

Findings from a signed-in session in the web app, 3 November 2026. All identifiers below are placeholders. No tokens, IDs or personal data from the session are recorded here.

## Which product we are targeting

- `shine.co` / `app.shine.co` sends you to `login.shine.co`, which is a different Shine product that uses Cognito, Zervant and invoicing. The account cannot sign in there.
- The payroll product, **Shine Salary**, is at **`https://app.salary.dk`**. It logs in at `login.salary.dk`.
- The web app is a SPA that talks to **`https://api.salary.dk`**.

v1 targets `api.salary.dk` only.

## The API is public and documented

- Docs are at <https://api.salary.dk/docs> (ReDoc), and the spec is at <https://api.salary.dk/swagger.json> (Swagger 2.0, "Salary.dk API 1.0.0", 148 paths, 93 of them with `GET`).
- The spec says: "Our webapp uses the exact same API … not all endpoints are documented here yet. Only the endpoints documented here are stable."
- The versioning policy promises additive changes only. A breaking change gets a new endpoint version, such as `/v2.1/...`, and the old version is deprecated rather than removed. Enums can grow at any time.
- The documented `GET` endpoints are listed in [`salary-api-get-endpoints.md`](salary-api-get-endpoints.md).

## Authentication facts

| Fact | Evidence |
|---|---|
| The header format is `Authorization: <accessToken>`, with **no** `Bearer` prefix. | Spec `securityDefinitions.authorizedUser`. Verified with curl: raw value → 200, `Bearer …` → 401. |
| Files can also be fetched with `?apiKey=<accessToken>`. | `securityDefinitions.authorizedUserQuery`, used for PDF and Excel downloads. |
| The web app sends the token as an `httpOnly`, `Secure`, `SameSite=Strict` **session cookie** named `sally_access_token` on `.salary.dk`. That cookie has no `Expires`, so it dies when the browser closes. | Cookie metadata from Playwright. |
| Calling the API from outside the browser works with either `Cookie: sally_access_token=…` or `Authorization: …`. | curl → 200. Cloudflare does not block plain HTTP clients on `api.salary.dk`. |
| The spec says the access token "is valid for around one hour, after which a new token should be obtained". | Spec info.description. Being tested empirically (see "Token lifetime probe"). |
| There is no documented refresh endpoint, and API responses send no `Set-Cookie` back. | Spec paths and response headers. |
| The `csrfToken` in the login response is only needed for **mutating** requests made with cookie auth. | Spec `definitions.accessToken`. |

### Ways to get an access token

1. **User login, `POST /v2/login`**
   - Body: `email`, `password`, `cfTurnstileResponse` (Cloudflare Turnstile), `mfaChallengeID`, `mfaResponse`, `recoveryCode`, `trustDevice` ("trust this device for 30 days"), `deviceToken`.
   - When MFA is required, the endpoint returns 401 with `mfaChallengeID` and `channel` (`TOTP`/`SMS`/`EMAIL`).
   - The spec calls this endpoint "not yet publicly available".
   - The web app sends a Turnstile token. A probe with a nonexistent email and no Turnstile field returned `WrongPassword`, not a Turnstile error, so we cannot tell whether Turnstile is enforced for real credentials.
2. **API client plus company API key, `POST /v2/auth`** (`APIClientLogin`)
   - Body: `apiClientID` and `apiClientSecret` (both **required**), plus an optional `apiKey`. Returns `{data: {accessToken, apiClientToken}}`.
   - You get an API client by emailing `dev@salary.dk` with the client's name and purpose. The Salary help centre FAQ says "An API client alone does not give access to user or company data". It has to be combined with the company's API key.
   - A company admin creates the **company API key** in *Virksomhed → Avanceret → API-nøgler* (`/companies/{companyID}/api-keys`, list via `GET /v2/apiKeys?companyID=`). The create dialog has **scoped permissions**:
     - *Fuld læseadgang* (full read)
     - *Fuld skriveadgang* (full write)
     - *Læseadgang til basaldata* (basic data)
     - *Læseadgang til persondata* (personal data)
     - *Læseadgang til ansættelser* (employments)
     - *Læseadgang til fravær* (absence)

     A **read-only key** is possible: turn off "Fuld skriveadgang".
   - A probe with a zero UUID client returned `NotFound: API Client not found`. A random string as `Authorization` returned 401.
   - Verified with a real read-only company key (2026-11-03): the key alone is rejected as `Authorization` (401) and as `?apiKey=` (401), and `POST /v2/auth` with only `apiKey` returns `login.apiClientID in body is required`. **An API client is required.**
   - Salary registered the API client on 2026-11-04 and sent the client ID and secret by email. They state they **do not provide support** for using the API, and they did not answer our questions about token lifetime, rate limits or client-level scoping.

### Verified with the registered API client (2026-11-04)

| Fact | Evidence |
|---|---|
| An unknown `apiClientID` returns **404 `NotFound: API Client not found`**, even when the secret and key are present. The spec documents 401 for wrong credentials, so a 404 means the client ID itself is wrong. | First attempt with an incomplete client ID. |
| `POST /v2/auth` with `apiClientID`, `apiClientSecret` and `apiKey` returns 200 with **only `accessToken`**. No `apiClientToken` and no `csrfToken` are returned. | Live call. |
| The access token is an opaque 256-character string, **not a JWT**. There is no expiry in the token or the response, so lifetime must come from the spec ("around one hour") and 401 handling. | Live call. |
| Responses carry **no rate-limit headers** (`X-RateLimit-*`, `RateLimit-*`, `Retry-After`). | Headers on `/v2/auth` and `/v2/companies`. |
| `GET /v2/companies` returns exactly the one company bound to the key. | Live call. |
| `GET /v2/apiKeys?companyID=` works with the key's own token and reports its scopes: **`["ReadAll"]`**. This is authoritative, non-mutating proof that the key has no write scope. | Live call. |
| `GET /v2/employees?companyID=&limit=1` → 200. | Live call. |
| `GET /v2/payRolls?companyID=` **requires `from`** (422, code 602, `from in query is required`). With `from` and `to` it returns 200. | Live call. |

## Endpoints the web app calls (observed)

`{companyID}`, `{employeeID}` and `{payRollID}` are placeholders. Endpoints marked ⚠ are **not in the public spec**, so treat them as unstable.

| Area | Calls |
|---|---|
| Identity | `GET /v2/users`, `GET /v2/companies`, `GET /v2/companies/{companyID}`, `GET /v2/companyUsers?companyID=` |
| Dashboard | ⚠`GET /v2/dashboard[?companyID=]`, `GET /v2/warnings?companyID=`, ⚠`GET /v2/companyFeatures?companyID=`, `GET /v2/companies/{companyID}/activePayrolls`, `GET /v2/companies/{companyID}/statistics/overview` |
| Employees | `GET /v2/employees?companyID=&includeActiveContract=true[&includeActiveEmployment=true][&includeRemuneration=true]&limit=500&offset=0`, `GET /v2/employees/{employeeID}?companyID=&includeActiveContract=true&includeActiveEmployment=true`, `GET /v2/employeeContracts?companyID=|employeeID=`, `GET /v2/departments?companyID=`, ⚠`GET /v2/employeeDimensions?companyID=`, `GET /v2/employmentPositions?country=DK` |
| Payroll | `GET /v2/payRolls?companyID=&from=&to=`, `GET /v2/payRolls/{payRollID}`, `GET /v2/paySlips?payRollID=|employeeID=`, `GET /v2/payRollDeviations?payRollID=`, `GET /v2/transfers?payRollID=&includeDetails=true`, `GET /v2/vouchers?payRollID=`, `GET /v2/invoices?payRollID=`, `GET /v2/incomeTaxReports?payRollID=`, ⚠`GET /v2/shipments?workflowID=` |
| Time and leave | `GET /v2/timeRegistrations?companyID=|employeeID=&from=&to=[&stateFilter=Pending]`, `GET /v2/coarseTimeRegistrations?companyID=&salaryPeriodID=`, ⚠`GET /v2/leaveBalances?companyID=|employeeID=`, `GET /v2/leaveTypes?companyID=`, `GET /v2/salaryCycles?companyID=&includeSalaryPeriods=true` |
| Car allowance | ⚠`GET /v2/carAllowances?companyID=&from=&to=`, ⚠`GET /v2/coarseCarAllowances?companyID=&salaryPeriodID=…` |
| Tax | `GET /v2/taxCards?employeeID=`, `GET /v2/taxCardRequests?employeeID=` |
| Config | `GET /v2/salaryTypes?companyID=`, `GET /v2/supplementTypes?companyID=`, ⚠`GET /v2/agreements?companyID=`, ⚠`GET /v2/projects?companyID=`, `GET /v2/pensionCompanies`, ⚠`GET /v2/accountingIntegrations?companyID=` |
| Files (query auth) | `GET /v2/paySlipsPDF/{id}`, `GET /v2/payslipsHTML/{id}`, `GET /v2/reportPDF`, `GET /v2/reportCSV`, `GET /v2/reportExcel` |

Pagination uses `limit` and `offset`. The web app asks for up to 500–1000 records per page.

## Token lifetime probe

The token from the browser login was captured at about 18:05 UTC. After 18:20 it was idle, with the browser closed. It was then checked at 19:15, 19:45 and 20:30 UTC. The result is recorded in the PR description and in `docs/PLAN.md` §Auth.

## Implications for v1

- **Confirmed 2026-11-04:** the API client, secret and `ReadAll` company key work end to end.
- The **only durable, supported, read-only-scoped** credential is a **company API key with read scopes**, used through an **API client** registered with Salary. That credential is stored once in the OS keychain, and access tokens of about 1 hour are refreshed silently with `POST /v2/auth`. This setup meets the goal of "authenticate once, survives reboots".
- **Browser session capture** gives you a token of about 1 hour, held in a cookie that dies with the browser. On its own it cannot survive a restart without logging in again. It works as an "interactive mode" or bootstrap while the API client registration is pending.
- **Stored email/password plus `trustDevice`/`deviceToken`** could renew silently for 30 days if Turnstile is not enforced for API logins. But it means storing a password and depending on an endpoint that is "not yet publicly available". It is a fallback only, and it needs explicit opt-in. **Rejected for v1 (user decision, 2026-11-03).**
