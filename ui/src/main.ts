import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { probeNestedFrames } from "./artifact.js";
import { createPage } from "./page.js";
import type { ToolOutcome } from "./screen.js";

const app = new App({ name: "Bellman", version: "0.1.0" });

/** The page, given the host's calls; page.ts holds every rule about when a read goes out and what its answer may do. */
const page = createPage({
  root: document.getElementById("root")!,
  callTool: (name, args) => app.callServerTool({ name, arguments: args }) as Promise<ToolOutcome>,
  sendMessage: (text) => app.sendMessage({ role: "user", content: [{ type: "text", text }] }),
  openLink: (url) => void app.openLink({ url }),
  // Asked once, now, before the first canvas draws (canvas spec D9).
  nestedFrames: probeNestedFrames(),
});

// Handlers before connect: the host may send the result straight after.
app.ontoolresult = (result) => page.render(result as ToolOutcome);
app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
};

void (async () => {
  await app.connect();
  const theme = app.getHostContext()?.theme;
  if (theme) applyDocumentTheme(theme);
})();
