import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One HTML file with its script and styles inlined: the shape an MCP Apps host
// renders from a single resources/read (spec D12). `root` is this directory,
// so `index.html` here is the entry and `dist/` here is the output.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
