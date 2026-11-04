# Evaluations

[`scenarios.json`](scenarios.json) lists realistic requests, the tools a good answer needs, and what the answer must and must not contain. Together they cover company selection, payroll questions, ambiguous employees, missing scopes, expired login and injected text.

They are run by hand for now:

1. Connect a client as described in [docs/CLIENTS.md](../docs/CLIENTS.md).
2. Ask each `prompt` in a fresh conversation.
3. Check the tool calls against `expect_tools` and the answer against `must` / `must_not`.

The scenarios use real company data, so the answers contain real payroll figures. Don't paste transcripts into issues or PRs.
