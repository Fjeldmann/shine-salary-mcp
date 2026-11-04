# MCPB bundle

`manifest.json` describes a Claude Desktop extension (MCPB, manifest v0.3; its fields were checked against `mcpb-manifest-v0.3.schema.json` from `@anthropic-ai/mcpb` 2.1.2).

**Status (2026-11-04):** `mcpb validate` passes (mcpb 2.1.2). A test bundle packed on Linux was 3.7 MB with 866 files and no credential files. Unpacked, its server listed all six tools. The real darwin bundle still has to be built on a Mac.

**Platforms.** The bundle has to be built on the platform it targets, because `@napi-rs/keyring` ships a different native binary for each one. The manifest declares `darwin` only:
- Windows: native Windows is untested (see [SECURITY.md](../SECURITY.md)). On Windows, use the WSL setup in [docs/CLIENTS.md](../docs/CLIENTS.md) instead.
- Linux: Claude Desktop does not run on Linux.

To build, run this on a Mac:

```bash
npm ci
npm run bundle        # -> shine-salary-mcp-<version>-darwin.mcpb
```

`scripts/build-mcpb.sh` builds the code and assembles a bundle with production dependencies only. It refuses to continue if any credential-like files are present. Then it runs `mcpb validate` and `mcpb pack`. On any platform other than macOS it refuses to run, unless `MCPB_ALLOW_OTHER_PLATFORM=1` is set for testing.

Never put a `.env` file or a credential store into the bundle. Users run `shine-salary-mcp login` in a terminal first.
