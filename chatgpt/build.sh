#!/bin/sh
# Pack the ChatGPT plugin for OpenAI's plugin directory.
#
#   ./chatgpt/build.sh
#
# Produces chatgpt/dist/bellman-chatgpt.zip: plugin.json, mcp.json and assets/ at the
# archive root, which is what the portal at platform.openai.com/plugins uploads.
# The package holds no code: the plugin is Bellman's hosted MCP server, which OpenAI
# connects to and rescans on its own. tests/chatgpt-plugin.test.ts checks the package.

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=$here/dist
zipfile=$out/bellman-chatgpt.zip

mkdir -p "$out"
rm -f "$zipfile"
cd "$here"
zip -q -X -r "$zipfile" plugin.json mcp.json assets
echo "$zipfile"
unzip -l "$zipfile"
