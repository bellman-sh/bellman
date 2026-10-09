#!/bin/sh
# Pack the Bellman Claude Desktop extension (.mcpb).
#
#   ./extension/build.sh                    # latest published release
#   ./extension/build.sh --version 0.2.0    # a specific release
#   ./extension/build.sh --from .           # this checkout, unreleased
#
# Produces extension/dist/bellman.mcpb — drag it onto Claude Desktop.
#
# A bundle is a zip of a manifest, a built stdio server, and the server's
# runtime dependencies. By default the server comes from npm — the released
# code, packed without compiling this checkout. --from . packs this one.

set -eu

PKG="${BELLMAN_PKG:-@bellman-sh/mcp-server}"
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stage=$here/build
out=$here/dist
from=""
version=""

while [ $# -gt 0 ]; do
  case "$1" in
    --from)    from=${2:?--from needs a path}; shift 2 ;;
    --version) version=${2:?--version needs a version}; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         echo "unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

command -v npm >/dev/null 2>&1 || { echo "error: npm is required" >&2; exit 2; }

rm -rf "$stage" "$out"
mkdir -p "$stage/server" "$out"

# ------------------------------------------------------- get the server ----

if [ -n "$from" ]; then
  # Unreleased code: build the checkout and take its dist/. This is the
  # contributor path — testing a bundle before the package is published.
  [ -d "$from" ] || { echo "error: no checkout at $from" >&2; exit 1; }
  from=$(CDPATH= cd -- "$from" && pwd)
  echo "==> Building $from"
  npm --prefix "$from" install --silent --no-fund --no-audit
  npm --prefix "$from" run build --silent
  [ -f "$from/dist/channel.js" ] || { echo "error: $from/dist/channel.js missing" >&2; exit 3; }
  cp -R "$from/dist/." "$stage/server/"
  pkg_json=$from/package.json
  source_desc="local checkout $from"
else
  spec=$PKG${version:+@$version}
  echo "==> Fetching $spec from npm"
  tgz_dir=$stage/.npm
  mkdir -p "$tgz_dir"
  npm pack "$spec" --silent --pack-destination "$tgz_dir" >/dev/null
  tgz=$(ls "$tgz_dir"/*.tgz | head -1)
  [ -n "$tgz" ] || { echo "error: npm pack produced nothing" >&2; exit 3; }
  tar xzf "$tgz" -C "$tgz_dir"
  [ -f "$tgz_dir/package/dist/channel.js" ] || { echo "error: no dist/channel.js in the package" >&2; exit 3; }
  cp -R "$tgz_dir/package/dist/." "$stage/server/"
  pkg_json=$tgz_dir/package/package.json
  source_desc="npm $spec"
fi

pkg_version=$(node -p "require('$pkg_json').version")

echo "==> Staging bundle ($source_desc, v$pkg_version)"

# The manifest beside this script is the template; the bundle always reports the
# version of the code actually inside it, so the two cannot drift. Its tool list
# is held to the bridge's real surface by tests/extension.test.ts.
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  m.version = process.argv[2];
  fs.writeFileSync(process.argv[3], JSON.stringify(m, null, 2) + "\n");
' "$here/manifest.json" "$pkg_version" "$stage/manifest.json"

[ -f "$here/icon.png" ] && cp "$here/icon.png" "$stage/icon.png"

# The staging package.json carries the package's dependency list, copied whole.
# It used to pin the SDK alone, on the reading that the bridge reached nothing
# else — true until src/bridge.ts imported yaml, after which every bundle died
# at its first import and Claude Desktop said only "Server disconnected"
# (v0.3.0 shipped that way). Copying costs nothing: the SDK already depends on
# express and zod, so the only package this adds is yaml.
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], JSON.stringify({
    name: "bellman-desktop-extension",
    version: pkg.version,
    private: true,
    type: "module",
    dependencies: pkg.dependencies,
  }, null, 2) + "\n");
' "$pkg_json" "$stage/package.json"

npm --prefix "$stage" install --silent --omit=dev --no-fund --no-audit --no-package-lock
rm -rf "$stage/.npm"

# And the proof, on the artifact: every package the staged server imports,
# transitively from server/channel.js, resolves beside it. A list copied from
# package.json can still be wrong — a package the code imports but only
# devDependencies declares — and this is the one step that would notice.
echo "==> Checking imports"
node "$here/check-deps.mjs" "$stage"

echo "==> Packing"
# Pinned to the major the manifest targets (manifest_version 0.3).
npx --yes @anthropic-ai/mcpb@2 pack "$stage" "$out/bellman.mcpb"

echo ""
echo "  $out/bellman.mcpb"
echo "  $(du -h "$out/bellman.mcpb" | cut -f1) · v$pkg_version · from $source_desc"
echo ""
echo "  Install it by dragging the file onto Claude Desktop, or"
echo "  Settings > Extensions > Advanced settings > Install extension."
