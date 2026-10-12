/**
 * src/channel.ts and src/stop-hook.ts → plugin/bridge/channel.mjs and plugin/bridge/stop-hook.mjs,
 * the files the Claude Code plugin runs. Claude Code copies plugin/ into its cache and installs
 * nothing beside it (plugin/ holds no package.json, on purpose), so each entry carries every
 * dependency it imports. The output is committed, and rebuilt in release PRs.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

const { metafile } = await build({
  entryPoints: { channel: "src/channel.ts", "stop-hook": "src/stop-hook.ts" },
  outdir: "plugin/bridge",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  // Bundled CommonJS dependencies require() Node's built-ins, and an ES module has no require.
  // Without this line the bridge dies at load: Dynamic require of "process" is not supported.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  // src/version.ts reads ../package.json, and the bundle has none to read.
  define: { BELLMAN_BUNDLE_VERSION: JSON.stringify(version) },
});

// The bundles carry MIT, ISC and BSD-3-Clause code, whose licenses travel with every copy. Minified,
// the notices are gone from the code, so they go beside it: one entry per bundled package, sorted
// by code point so two builds of one tree write the same bytes.
const notices = new Map<string, string>();
for (const output of Object.values(metafile.outputs)) {
  for (const input of Object.keys(output.inputs)) {
    const dir = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
    if (!dir) continue;
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { name: string; version: string; license?: string };
    const file = readdirSync(dir).sort().find((name) => /^licen[cs]e/i.test(name));
    const text = file ? readFileSync(`${dir}/${file}`, "utf8").trim() : `${pkg.license ?? "UNLICENSED"} (no license file)`;
    notices.set(`${pkg.name}@${pkg.version}`, text);
  }
}
const entries = [...notices].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
writeFileSync(
  "plugin/bridge/THIRD-PARTY-NOTICES.txt",
  entries.map(([id, text]) => `${id}\n\n${text}`).join("\n\n----\n\n") + "\n"
);
