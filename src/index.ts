/**
 * Library entry. The package is primarily a bin (`getscreenshot-mcp`); these
 * exports let other Node programs embed the server or reuse the API client.
 */
export * from "./api.js";
export * from "./download.js";
export {
  DETAIL_LEVELS,
  DETAIL_LIMITS,
  DEFAULT_MAX_SLICES,
  JPEG_QUALITY,
  MAX_SLICES_LIMIT,
  INLINE_BYTE_BUDGET,
  estimateTokens,
  fetchAndSize,
  inlineByteBudget,
  maxSliceHeight,
  planSlices,
  probeDimensions,
  readDimensions,
  setImageThreads,
  sizeForVision,
  type Detail,
  type DetailLimits,
  type SlicePlan,
  type SliceRect,
  type VisionImage,
  type VisionResult,
} from "./vision.js";
export * from "./diff.js";
export * from "./html-store.js";
export * from "./limits.js";
export { SERVER_INSTRUCTIONS, TOOL_NAMES, registerTools, type ServerContext, type PreviewGate, type ToolCallEvent, type ToolName } from "./tools.js";
export { SERVER_NAME, SERVER_TITLE, createServer } from "./server.js";
export { RemoteHtmlHost, runStdio } from "./stdio.js";
export { startHttpServer, runHttp, httpOptionsFromEnv, type HttpServerOptions, type RunningHttpServer } from "./http.js";
export { runCli } from "./cli.js";
export { VERSION } from "./version.js";
