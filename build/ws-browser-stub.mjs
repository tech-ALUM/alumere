// Browser stub for the Node-only `ws` package.
//
// @hocuspocus/provider lists `ws` as a dependency (for Node usage) and has no
// "browser" field, so a browser bundle would otherwise try to pull `ws` and its
// Node built-ins (net/tls/http/...). In the browser the provider must use the
// native WebSocket instead. build/build-client.mjs aliases `ws` to this file, which
// (a) stops esbuild from bundling Node built-ins and (b) hands back the global
// WebSocket — covering both `import WS from "ws"` and `import { WebSocket } from "ws"`.
const NativeWebSocket = globalThis.WebSocket;
export default NativeWebSocket;
export { NativeWebSocket as WebSocket };
