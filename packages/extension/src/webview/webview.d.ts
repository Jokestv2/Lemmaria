declare module "*.css";

/** `acquireVsCodeApi` is injected by the webview runtime, not a global type. */
declare function acquireVsCodeApi(): import("../webview-protocol.js").VsCodeApi;
