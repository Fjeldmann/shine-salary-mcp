#!/usr/bin/env bash
# Installation rehearsal: pack the package, install the tarball into a scratch
# directory, and run login -> status -> serve -> logout against an isolated
# config directory. Uses the development credentials in .env for login.
# Prints no secrets. Usage: npm run rehearse
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export SHINE_SALARY_CONFIG_DIR="$work/config"

cd "$repo"
tarball="$(npm pack --silent --pack-destination "$work" | tail -1)"
echo "== packed $tarball"
cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "./$tarball"
bin="$work/node_modules/.bin/shine-salary-mcp"
echo "== version: $("$bin" --version)"

echo "== status before login (expect exit 2)"
set +e; "$bin" status; code=$?; set -e
[ "$code" = 2 ] || { echo "unexpected exit $code"; exit 1; }

echo "== login --from-env"
node --env-file="$repo/.env" "$bin" login --from-env

echo "== status --check (fresh process, no env credentials)"
"$bin" status --check

echo "== serve: discover, tools/list, one tool call"
meta='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"rehearsal","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}'
{
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$meta}}"
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$meta}}"
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{$meta,\"name\":\"salary_company_overview\",\"arguments\":{}}}"
  sleep 5
} | "$bin" serve 2>"$work/serve.err" | node -e '
  let n = 0;
  require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
    const m = JSON.parse(l); n++;
    const r = m.result ?? {};
    if (m.id === 1) console.log("discover:", r.supportedVersions);
    if (m.id === 2) console.log("tools:", r.tools.map((t) => t.name).join(", "));
    if (m.id === 3) console.log("company_overview:", r.isError ? "ERROR" : `${r.structuredContent.companies.length} company`);
  }).on("close", () => { if (n !== 3) { console.error(`expected 3 responses, got ${n}`); process.exit(1); } });'
echo "stderr lines from serve: $(wc -l < "$work/serve.err")"

echo "== logout"
"$bin" logout
left="$(find "$SHINE_SALARY_CONFIG_DIR" -type f | wc -l)"
echo "files left in config dir: $left"
[ "$left" = 0 ] || exit 1
echo "== rehearsal OK"
