# MCPB bundle

`manifest.json` describes a Claude Desktop extension (MCPB, manifest v0.3; its fields were checked against `mcpb-manifest-v0.3.schema.json` from `@anthropic-ai/mcpb` 2.1.2).

**Status:** the manifest passes the v0.3 JSON schema, but it has not been packed or validated with the `mcpb` CLI yet. Running that CLI needs approval to execute it via `npx`.

**Platforms.** The bundle has to be built on the platform it targets, because `@napi-rs/keyring` ships a different native binary for each one. The manifest declares `darwin` only:
- Windows: native Windows is untested (see [SECURITY.md](../SECURITY.md)). On Windows, use the WSL setup in [docs/CLIENTS.md](../docs/CLIENTS.md) instead.
- Linux: Claude Desktop does not run on Linux.

Steps, on a Mac:

```bash
npm ci && npm run build
rm -rf bundle && mkdir bundle
cp packaging/manifest.json bundle/
cp -R dist package.json package-lock.json bundle/
(cd bundle && npm ci --omit=dev && rm -rf dist/dev)
npx @anthropic-ai/mcpb@2.1.2 validate bundle/manifest.json
npx @anthropic-ai/mcpb@2.1.2 pack bundle shine-salary-mcp-0.1.0-darwin.mcpb
```

Never put a `.env` file or a credential store into the bundle. Users run `shine-salary-mcp login` in a terminal first.
