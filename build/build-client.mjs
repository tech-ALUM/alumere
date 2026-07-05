// Builds the browser bundle public/vendor/codemirror.js from build/cm-entry.mjs.
// The bundle exposes window.CM6 (the editor toolkit) and window.YCOLLAB (the Yjs
// real-time pieces). Run it with:  npm run build:client
//
// Node isn't installed on the host, so in practice this runs inside a throwaway
// Node container (see the build instructions / README).
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

await esbuild.build({
  entryPoints: [path.join(here, "cm-entry.mjs")],
  outfile: path.join(root, "public", "vendor", "codemirror.js"),
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: ["es2020"],
  // `ws` is a Node-only dependency of @hocuspocus/provider; in the browser the
  // provider must use the native WebSocket. Alias it to a stub that re-exports the
  // global WebSocket, so esbuild never bundles Node built-ins for the browser.
  alias: { ws: path.join(here, "ws-browser-stub.mjs") },
  logLevel: "info",
});

console.log("[alumere] client bundle written → public/vendor/codemirror.js");
