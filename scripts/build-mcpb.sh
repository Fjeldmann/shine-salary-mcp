#!/usr/bin/env bash
# Build the Claude Desktop extension bundle (.mcpb) for the platform this runs on.
# The keychain library ships one native binary per platform, so a bundle only
# works on the platform it was built on. The manifest declares darwin; building
# elsewhere is refused unless MCPB_ALLOW_OTHER_PLATFORM=1 (for testing only).
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
platform="$(node -p process.platform)"
if [ "$platform" != "darwin" ] && [ "${MCPB_ALLOW_OTHER_PLATFORM:-}" != "1" ]; then
  echo "Refusing to build on $platform: the manifest targets darwin (see packaging/README.md)." >&2
  exit 1
fi
version="$(node -p "require('$repo/package.json').version")"
out="${1:-$repo/shine-salary-mcp-$version-$platform.mcpb}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$repo"
npm run build --silent
mkdir "$work/bundle"
cp packaging/manifest.json package.json package-lock.json "$work/bundle/"
cp -R dist "$work/bundle/"
cd "$work/bundle"
rm -rf dist/dev
find dist -name '*.map' -delete
npm ci --omit=dev --ignore-scripts --silent --no-audit --no-fund
# Never ship local credentials or config.
if find . \( -name '.env*' -o -name '*.enc' -o -name 'state.json' -o -name 'wrapping-key.dpapi' \) -not -path './node_modules/*' | grep -q .; then
  echo "Refusing to pack: credential-like files found in the bundle." >&2
  exit 1
fi
npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json
npx -y @anthropic-ai/mcpb@2.1.2 pack . "$out"
echo "Built $out"
