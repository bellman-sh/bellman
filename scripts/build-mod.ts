/**
 * mod/src/register.tsx → mod/hooks/register.mjs, the hooks module the bellman-mod plugin runs.
 *
 * A hooks module runs in an environment of its own, with no Node and no node_modules: the engine
 * hands it `claude-code` and nothing else, so everything else it imports (mod/src, and the
 * runtime-free modules under src/ it shares with the bridge) is bundled in. The output is
 * committed, unminified so a person can read what the mod runs, and rebuilt by `npm run build:mod`
 * and, in release PRs, by `npm run build:plugin`. `npm run test:mod` builds its own copy.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export async function buildMod(outfile = "mod/hooks/register.mjs"): Promise<void> {
  await build({
    entryPoints: ["mod/src/register.tsx"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["claude-code"],
    // JSX compiles against the global `h` a hooks module has.
    jsx: "transform",
    jsxFactory: "h",
    // Everything the build needs is above. mod/tsconfig.json is for an editor, and extends types the
    // engine lays only beside a mod it hot-reloads, so it is not read.
    tsconfigRaw: {},
    legalComments: "none",
    logLevel: "warning",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildMod();
