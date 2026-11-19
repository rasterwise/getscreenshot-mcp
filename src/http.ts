/**
 * Hosted entry: `getscreenshot-mcp --http`.
 *
 * Stateless Streamable HTTP: every `POST /mcp` carries exactly one JSON-RPC
 * message and gets a fresh server and transport. There are no sessions, and
 * the caller's API key travels with each request in a header. The same process
 * hosts the short-lived HTML documents that render_html captures, which is why
 * it must run as a single instance until a shared HtmlStore exists.
 *
 * This server is reachable by anyone, and a key cannot be verified without
 * spending the caller's quota. So every expensive path is bounded on its own:
 * request targets and bodies are validated, bodies have a deadline, tool calls
 * are rate limited per caller and per address, image work goes through a
 * global gate, and the HTML store has per-caller and global caps.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GetScreenshotError } from "./api.js";
import {
  HTML_ID_PATTERN,
  HTML_MAX_BYTES,
  HTML_MAX_DOCS_PER_CALLER,
  LocalHtmlHost,
  MemoryHtmlStore,
  type HtmlOwner,
  type HtmlStore,
} from "./html-store.js";
import {
  DEFAULT_IMAGE_CONCURRENCY,
  DEFAULT_IMAGE_QUEUE,
  DEFAULT_IMAGE_WAIT_MS,
  DailyLimiter,
  ImageGate,
  MinuteLimiter,
  ipId,
  keyId,
} from "./limits.js";
import { createServer, type PreviewGate, type ServerContext, type ToolCallEvent } from "./server.js";
import { AGENTS_URL, VERSION } from "./version.js";
import { setImageThreads } from "./vision.js";

export { DailyLimiter } from "./limits.js";

/** JSON-RPC bodies: a 2 MB HTML document can grow when JSON-escaped, so allow headroom. */
export const MCP_MAX_BODY_BYTES = 6 * 1024 * 1024;
export const HTML_UPLOADS_PER_MINUTE_PER_IP = 60;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
export const DEFAULT_RATE_LIMIT_PER_IP_PER_MINUTE = 120;
/** A request must deliver its headers and body within this long. */
export const DEFAULT_BODY_TIMEOUT_MS = 15_000;
export const SHUTDOWN_GRACE_MS = 9_000;
/** How many more live HTML documents one address may hold than one key. */
const IP_DOCUMENT_FACTOR = 4;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export interface HttpServerOptions {
  /** Port to listen on. 0 picks a free port. Default: env PORT, then 8080. */
  port?: number | undefined;
  host?: string | undefined;
  apiBase?: string | undefined;
  /** Public origin of the MCP endpoint. Default: env PUBLIC_BASE_URL, then http://127.0.0.1:<port>. */
  publicBaseUrl?: string | undefined;
  /**
   * Public origin used in `/h/<id>` links. Default: env HTML_PUBLIC_BASE_URL,
   * then `publicBaseUrl`. Point it at a throwaway domain so a hosted page that
   * gets flagged cannot damage the MCP hostname.
   */
  htmlPublicBaseUrl?: string | undefined;
  /** Enables keyless preview mode when set. Off by default. */
  trialApiKey?: string | undefined;
  trialDailyLimitPerIp?: number | undefined;
  trialDailyLimitGlobal?: number | undefined;
  /**
   * Number of proxies between Google's front end and this container that append
   * to X-Forwarded-For. 0 for Cloud Run reached directly or through a domain
   * mapping; 1 when an external Application Load Balancer sits in front. A
   * value above 0 is only safe when the service cannot be reached around the
   * load balancer (`--ingress internal-and-cloud-load-balancing`): otherwise a
   * direct caller chooses the entry that is trusted.
   */
  trustedProxyHops?: number | undefined;
  /** Tool calls per caller (API key, else address) per minute. */
  rateLimitPerMinute?: number | undefined;
  /** Tool calls per client address per minute, whatever keys it sends. */
  rateLimitPerIpPerMinute?: number | undefined;
  /** Image jobs (download + resize, or compare) that may run at once. */
  imageConcurrency?: number | undefined;
  imageQueueMax?: number | undefined;
  imageQueueWaitMs?: number | undefined;
  /** Live render_html documents one caller may hold. */
  htmlMaxDocsPerCaller?: number | undefined;
  /** HTML documents one address may upload per minute (POST /v1/html and render_html together). */
  htmlUploadsPerMinutePerIp?: number | undefined;
  /** Deadline for receiving a request's headers and body. */
  bodyTimeoutMs?: number | undefined;
  store?: HtmlStore | undefined;
  /** Receives one JSON line per request. Default: stdout. */
  log?: ((line: string) => void) | undefined;
  now?: (() => number) | undefined;
  /** Passed through to the tools (tests shorten these). */
  progressIntervalMs?: number | undefined;
  retryBaseMs?: number | undefined;
  compareMaxHeight?: number | undefined;
}

export interface RunningHttpServer {
  server: Server;
  port: number;
  /** http://127.0.0.1:<port> */
  url: string;
  publicBaseUrl: string;
  htmlPublicBaseUrl: string;
  store: HtmlStore;
  imageGate: ImageGate;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type KeySource = "bearer" | "x-api-key";

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads the caller's API key from `Authorization: Bearer` or `x-api-key`.
 * Headers only: a key in the URL would be written to the platform's request
 * logs, so the query string is never consulted.
 */
export function extractApiKey(headers: IncomingMessage["headers"]): { key: string; source: KeySource } | undefined {
  const auth = headerValue(headers.authorization);
  const bearer = auth ? /^Bearer\s+(\S.*)$/i.exec(auth.trim()) : null;
  if (bearer?.[1]?.trim()) return { key: bearer[1].trim(), source: "bearer" };

  const xApiKey = headerValue(headers["x-api-key"])?.trim();
  if (xApiKey) return { key: xApiKey, source: "x-api-key" };
  return undefined;
}

/**
 * The client address for rate limiting.
 *
 * Assumption (Cloud Run): Google's front end appends the address it accepted
 * the connection from to X-Forwarded-For, so the right-most entry is the only
 * one the client cannot forge. Everything to its left was supplied by the
 * client. With `trustedHops` extra proxies of our own in front (for example an
 * external load balancer, which appends one more entry), the client is that
 * many entries further left; this is only sound when every request really
 * passes through those proxies. Without the header the socket address is used.
 */
export function clientIp(xForwardedFor: string | undefined, remoteAddress: string | undefined, trustedHops = 0): string {
  const hops = (xForwardedFor ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const index = hops.length - 1 - Math.max(0, trustedHops);
  const picked = hops.length === 0 ? remoteAddress : hops[Math.max(0, index)];
  return (picked ?? "unknown").replace(/^::ffff:/i, "").toLowerCase();
}

/**
 * Parses a request target. Only origin-form targets are served (`/path?query`);
 * absolute-form, `*`, and anything `URL` cannot parse are rejected. Returns
 * undefined instead of throwing: a request line is attacker-controlled input.
 */
export function parseRequestTarget(target: string | undefined): URL | undefined {
  if (!target || target[0] !== "/" || target.startsWith("//")) return undefined;
  try {
    return new URL(target, "http://localhost");
  } catch {
    return undefined;
  }
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

export function httpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpServerOptions {
  return {
    port: nonNegativeInt(env.PORT, 8080),
    apiBase: env.GETSCREENSHOT_API_BASE?.trim() || undefined,
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim() || undefined,
    htmlPublicBaseUrl: env.HTML_PUBLIC_BASE_URL?.trim() || undefined,
    trialApiKey: env.TRIAL_API_KEY?.trim() || undefined,
    trialDailyLimitPerIp: nonNegativeInt(env.TRIAL_DAILY_LIMIT_PER_IP, 5),
    trialDailyLimitGlobal: nonNegativeInt(env.TRIAL_DAILY_LIMIT_GLOBAL, 200),
    trustedProxyHops: nonNegativeInt(env.TRUSTED_PROXY_HOPS, 0),
    rateLimitPerMinute: positiveInt(env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE),
    rateLimitPerIpPerMinute: positiveInt(env.RATE_LIMIT_PER_IP_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_IP_PER_MINUTE),
    imageConcurrency: positiveInt(env.IMAGE_CONCURRENCY, DEFAULT_IMAGE_CONCURRENCY),
    imageQueueMax: nonNegativeInt(env.IMAGE_QUEUE_MAX, DEFAULT_IMAGE_QUEUE),
    imageQueueWaitMs: nonNegativeInt(env.IMAGE_QUEUE_WAIT_MS, DEFAULT_IMAGE_WAIT_MS),
    htmlMaxDocsPerCaller: positiveInt(env.HTML_MAX_DOCS_PER_CALLER, HTML_MAX_DOCS_PER_CALLER),
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

interface RequestLog {
  auth: "key" | "preview" | "none" | undefined;
  keySource: KeySource | undefined;
  tool: ToolCallEvent | undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

type Body = { ok: true; data: Buffer } | { ok: false; reason: "too_large" | "timeout" | "aborted" };

/**
 * Reads a request body with a size limit and a deadline. Never rejects.
 * A slightly oversized body is drained so the client can read the 413; a body
 * far past the limit, or one that misses the deadline, stops being read.
 */
function readBody(req: IncomingMessage, limit: number, timeoutMs: number): Promise<Body> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit * 8) {
      resolve({ ok: false, reason: "too_large" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    let settled = false;
    const finish = (body: Body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(body);
    };
    const timer = setTimeout(() => {
      req.pause();
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        if (size > limit * 8) {
          req.pause();
          finish({ ok: false, reason: "too_large" });
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(over ? { ok: false, reason: "too_large" } : { ok: true, data: Buffer.concat(chunks) }));
    req.on("error", () => finish({ ok: false, reason: "aborted" }));
    req.on("close", () => finish({ ok: false, reason: "aborted" }));
  });
}

/** Answers a request whose body could not be read. Returns true when it did. */
function rejectBody(res: ServerResponse, body: Body, limit: number, asJsonRpc: boolean): body is Exclude<Body, { ok: true }> {
  if (body.ok) return false;
  if (body.reason === "aborted") {
    res.destroy();
    return true;
  }
  const status = body.reason === "timeout" ? 408 : 413;
  const message =
    body.reason === "timeout"
      ? "The request body did not arrive in time."
      : `The request body is larger than ${limit} bytes.`;
  if (asJsonRpc) jsonRpcError(res, status, -32600, message, { Connection: "close" });
  else sendJson(res, status, { error: message }, { Connection: "close" });
  // The rest of the body is not wanted: end the connection once the answer is out.
  res.once("finish", () => res.socket?.destroy());
  return true;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

export async function startHttpServer(options: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const store = options.store ?? new MemoryHtmlStore({ now });
  const trustedHops = options.trustedProxyHops ?? 0;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const docsPerCaller = options.htmlMaxDocsPerCaller ?? HTML_MAX_DOCS_PER_CALLER;
  const trialKey = options.trialApiKey?.trim() || undefined;
  const previewLimiter = trialKey
    ? new DailyLimiter(options.trialDailyLimitPerIp ?? 5, options.trialDailyLimitGlobal ?? 200, now)
    : undefined;
  const uploadLimiter = new MinuteLimiter(options.htmlUploadsPerMinutePerIp ?? HTML_UPLOADS_PER_MINUTE_PER_IP, now);
  const callerLimiter = new MinuteLimiter(options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE, now);
  const addressLimiter = new MinuteLimiter(options.rateLimitPerIpPerMinute ?? DEFAULT_RATE_LIMIT_PER_IP_PER_MINUTE, now);
  const imageGate = new ImageGate({
    concurrency: options.imageConcurrency,
    maxQueue: options.imageQueueMax,
    maxWaitMs: options.imageQueueWaitMs,
  });

  let publicBaseUrl = (options.publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  let htmlPublicBaseUrl = (options.htmlPublicBaseUrl ?? "").trim().replace(/\/+$/, "");

  /** The address a request came from, normalised for limiting (IPv6 as its /64). */
  const addressOf = (req: IncomingMessage) =>
    ipId(clientIp(headerValue(req.headers["x-forwarded-for"]), req.socket.remoteAddress, trustedHops));

  /** Who HTML documents are charged to: the key (if any) and, more loosely, the address. */
  const ownersOf = (callerId: string, address: string): HtmlOwner[] =>
    callerId === address
      ? [{ id: address, limit: docsPerCaller }]
      : [
          { id: callerId, limit: docsPerCaller },
          { id: address, limit: docsPerCaller * IP_DOCUMENT_FACTOR },
        ];

  const uploadRateError = (retryAfterSeconds: number) =>
    new GetScreenshotError(
      "server_rate_limited",
      `Too many HTML uploads from this address in the last minute. Wait about ${retryAfterSeconds} seconds and try again. No quota was used.`,
    );

  /**
   * When HTML is served from its own hostname, that hostname serves nothing
   * else, and the MCP hostname serves no HTML. Requests that name neither
   * (health checks, the run.app URL, local use) are served everything.
   */
  function hostAllows(req: IncomingMessage, wantsHtml: boolean): boolean {
    const mcpHost = hostOf(publicBaseUrl);
    const htmlHost = hostOf(htmlPublicBaseUrl);
    if (!mcpHost || !htmlHost || mcpHost === htmlHost) return true;
    const host = (headerValue(req.headers.host) ?? "").toLowerCase();
    if (host === htmlHost) return wantsHtml;
    if (host === mcpHost) return !wantsHtml;
    return true;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, entry: RequestLog): Promise<void> {
    for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no SSE stream to open (GET) and no session to end (DELETE).
      jsonRpcError(res, 405, -32000, "Method not allowed. This server is stateless: use POST.", { Allow: "POST, OPTIONS" });
      return;
    }

    const body = await readBody(req, MCP_MAX_BODY_BYTES, bodyTimeoutMs);
    if (rejectBody(res, body, MCP_MAX_BODY_BYTES, true)) return;
    let message: unknown;
    try {
      message = JSON.parse(body.data.toString("utf8"));
    } catch {
      jsonRpcError(res, 400, -32700, "Parse error: the request body is not valid JSON.");
      return;
    }
    if (Array.isArray(message)) {
      // A batch would run its calls concurrently inside one request, around every per-request limit.
      jsonRpcError(res, 400, -32600, "JSON-RPC batches are not supported. Send one request per POST.");
      return;
    }

    const address = addressOf(req);
    const supplied = extractApiKey(req.headers);
    const callerId = supplied ? keyId(supplied.key) : address;

    const context: ServerContext = {
      apiBase: options.apiBase,
      imageGate,
      compareMaxHeight: options.compareMaxHeight,
      progressIntervalMs: options.progressIntervalMs,
      retryBaseMs: options.retryBaseMs,
      htmlHost: new LocalHtmlHost(store, () => htmlPublicBaseUrl, {
        owners: ownersOf(callerId, address),
        admit: () => {
          const allowed = uploadLimiter.take(address);
          if (!allowed.ok) throw uploadRateError(allowed.retryAfterSeconds);
        },
      }),
      rateLimit: () => {
        // Per key (or address when there is no key), and per address across keys:
        // the second stops a caller from getting a fresh allowance by inventing keys.
        const address_ = addressLimiter.peek(address);
        if (!address_.ok) return address_;
        const caller = callerLimiter.take(callerId);
        if (caller.ok) addressLimiter.take(address);
        return caller;
      },
      onToolCall: (event) => {
        entry.tool = event;
      },
    };
    if (supplied) {
      context.apiKey = supplied.key;
      entry.auth = "key";
      entry.keySource = supplied.source;
    } else if (trialKey && previewLimiter) {
      const gate: PreviewGate = {
        limitPerIp: previewLimiter.limitPerIp,
        tryConsume: () => previewLimiter.tryConsume(address),
        // Anyone can put HTML on this server, so a keyless capture of our own
        // pages would be an anonymous render_html on the operator's key.
        blockedOrigins: [originOf(publicBaseUrl), originOf(htmlPublicBaseUrl)].filter((o): o is string => Boolean(o)),
      };
      context.apiKey = trialKey;
      context.preview = gate;
      entry.auth = "preview";
    } else {
      // No 401: the tools themselves explain how to get and set a key.
      entry.auth = "none";
    }

    const mcp = createServer(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void mcp.close().catch(() => undefined);
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, message);
  }

  async function handleHtmlUpload(req: IncomingMessage, res: ServerResponse, entry: RequestLog): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed. Use POST." }, { Allow: "POST" });
      return;
    }
    const supplied = extractApiKey(req.headers);
    // The key cannot be verified here without spending the caller's quota, so
    // this only checks that something key-shaped was sent. The capture that
    // follows is what the API authenticates; the limits below do not depend on it.
    if (!supplied || supplied.key.length < 8 || supplied.key.length > 256) {
      sendJson(
        res,
        401,
        { error: "Send your GetScreenshot API key as `Authorization: Bearer <API key>` or `x-api-key`." },
        { "WWW-Authenticate": 'Bearer realm="getscreenshot"' },
      );
      return;
    }
    entry.auth = "key";
    entry.keySource = supplied.source;

    const address = addressOf(req);
    // Refuse early when already over the limit, but only count the upload once its body is in.
    const pre = uploadLimiter.peek(address);
    if (!pre.ok) {
      sendJson(res, 429, { error: uploadRateError(pre.retryAfterSeconds).message }, { "Retry-After": String(pre.retryAfterSeconds) });
      return;
    }

    const body = await readBody(req, HTML_MAX_BYTES, bodyTimeoutMs);
    if (rejectBody(res, body, HTML_MAX_BYTES, false)) return;
    if (body.data.byteLength === 0) {
      sendJson(res, 400, { error: "The request body must be the HTML document." });
      return;
    }
    const host = new LocalHtmlHost(store, () => htmlPublicBaseUrl, {
      owners: ownersOf(keyId(supplied.key), address),
      admit: () => {
        const allowed = uploadLimiter.take(address);
        if (!allowed.ok) throw uploadRateError(allowed.retryAfterSeconds);
      },
    });
    try {
      const hosted = await host.publish(body.data.toString("utf8"));
      sendJson(res, 200, { url: hosted.url, expires_in_seconds: hosted.expiresInSeconds });
    } catch (err) {
      const code = err instanceof GetScreenshotError ? err.code : undefined;
      const status =
        code === "html_too_large" ? 413 : code === "too_many_documents" || code === "server_rate_limited" ? 429 : code === "html_store_full" ? 503 : 500;
      sendJson(
        res,
        status,
        { error: err instanceof GetScreenshotError ? err.message : "Could not store the HTML." },
        status === 429 || status === 503 ? { "Retry-After": "60" } : {},
      );
    }
  }

  async function handleHtmlDocument(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const known = HTML_ID_PATTERN.test(id);
    if (req.method === "DELETE") {
      // Lets the local server remove its document as soon as the capture is done.
      const supplied = extractApiKey(req.headers);
      const removed = known && supplied ? await store.delete(id, keyId(supplied.key)) : false;
      if (removed) res.writeHead(204, { "Cache-Control": "no-store" }).end();
      else sendJson(res, 404, { error: "Not found." });
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed. Use GET." }, { Allow: "GET, DELETE" });
      return;
    }
    const html = known ? await store.read(id) : undefined;
    if (!html) {
      sendJson(res, 404, { error: "Not found. HTML documents are deleted when their capture finishes." }, {
        "X-Robots-Tag": "noindex",
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": html.byteLength,
      // The document is untrusted input: an opaque origin, with scripts so that
      // components render, and nothing else.
      "Content-Security-Policy": "sandbox allow-scripts",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(html);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, entry: RequestLog): Promise<void> {
    const path = url.pathname;
    const isRead = req.method === "GET" || req.method === "HEAD";
    const isHtml = path.startsWith("/h/");

    if (!hostAllows(req, isHtml)) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }
    if (path === "/mcp" || path === "/mcp/") return handleMcp(req, res, entry);
    if (path === "/v1/html") return handleHtmlUpload(req, res, entry);
    if (isHtml) return handleHtmlDocument(req, res, path.slice(3));
    // Cloud Run answers /healthz itself and never forwards it, so /health is the one to use there.
    if ((path === "/health" || path === "/healthz") && isRead) {
      sendJson(res, 200, { status: "ok", version: VERSION });
      return;
    }
    if (path === "/" && isRead) {
      res.writeHead(302, { Location: AGENTS_URL, "Cache-Control": "no-store" }).end();
      return;
    }
    sendJson(res, 404, { error: "Not found. The MCP endpoint is POST /mcp." });
  }

  const logPath = (url: URL | undefined) =>
    !url ? "(malformed)" : url.pathname.startsWith("/h/") ? "/h/:id" : url.pathname;

  function listener(req: IncomingMessage, res: ServerResponse): void {
    const started = now();
    // The request line is attacker-controlled: parse it without throwing.
    const url = parseRequestTarget(req.url);
    const entry: RequestLog = { auth: undefined, keySource: undefined, tool: undefined };

    let logged = false;
    const writeLog = () => {
      if (logged) return;
      logged = true;
      // Never the query string, never headers, never bodies, and not the id of
      // a hosted document (it is a capability).
      log(
        JSON.stringify({
          ts: new Date(now()).toISOString(),
          severity: res.statusCode >= 500 ? "ERROR" : "INFO",
          msg: "request",
          method: req.method,
          path: logPath(url),
          status: res.statusCode,
          ms: now() - started,
          ...(entry.auth ? { auth: entry.auth } : {}),
          ...(entry.keySource ? { key_source: entry.keySource } : {}),
          ...(entry.tool
            ? {
                tool: entry.tool.tool,
                tool_ok: entry.tool.ok,
                tool_ms: entry.tool.ms,
                ...(entry.tool.code ? { tool_error: entry.tool.code } : {}),
              }
            : {}),
        }),
      );
    };
    res.on("finish", writeLog);
    res.on("close", writeLog);

    if (!url) {
      sendJson(res, 400, { error: "Bad request target." }, { Connection: "close" });
      return;
    }

    route(req, res, url, entry).catch((err: unknown) => {
      log(
        JSON.stringify({
          ts: new Date(now()).toISOString(),
          severity: "ERROR",
          msg: "unhandled",
          path: logPath(url),
          error: err instanceof Error ? err.name : "Error",
        }),
      );
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
      else res.end();
    });
  }

  const server = createHttpServer(
    {
      // Slow or stalled requests: Node closes a connection whose headers or
      // whole request have not arrived in time. The check runs on an interval,
      // so keep it short; body reads also carry their own timer (readBody).
      headersTimeout: Math.min(10_000, bodyTimeoutMs),
      requestTimeout: bodyTimeoutMs,
      connectionsCheckingInterval: Math.max(250, Math.min(5_000, Math.floor(bodyTimeoutMs / 3))),
    },
    (req, res) => {
      // Nothing thrown while handling a request may reach the process.
      try {
        listener(req, res);
      } catch (err) {
        try {
          log(
            JSON.stringify({
              ts: new Date(now()).toISOString(),
              severity: "ERROR",
              msg: "listener_error",
              error: err instanceof Error ? err.name : "Error",
            }),
          );
          if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" }, { Connection: "close" });
          else res.destroy();
        } catch {
          res.destroy();
        }
      }
    },
  );
  // A request line or header block Node itself cannot parse.
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const localUrl = `http://127.0.0.1:${port}`;
  if (!publicBaseUrl) publicBaseUrl = localUrl;
  if (!htmlPublicBaseUrl) htmlPublicBaseUrl = publicBaseUrl;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      // Captures can take 25 s; do not hold the process past the platform's grace period.
      const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
      force.unref();
    }).finally(() => store.close());
    return closing;
  };

  return { server, port, url: localUrl, publicBaseUrl, htmlPublicBaseUrl, store, imageGate, close };
}

/** Starts the hosted server from environment variables and wires up signals. */
export async function runHttp(): Promise<void> {
  const options = httpOptionsFromEnv();
  const write = (severity: string, msg: string, extra: Record<string, unknown> = {}) =>
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), severity, msg, ...extra })}\n`);

  // Backstop: a bug in one request must not take the service down for everyone.
  process.on("uncaughtException", (err) => {
    write("ERROR", "uncaughtException", { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  });
  process.on("unhandledRejection", (reason) => {
    write("ERROR", "unhandledRejection", { error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason) });
  });

  // One libvips thread per image job: parallelism comes from the image gate,
  // and memory per job stays predictable.
  setImageThreads(positiveInt(process.env.SHARP_CONCURRENCY, 1));

  const running = await startHttpServer(options);
  write("INFO", "listening", {
    version: VERSION,
    port: running.port,
    public_base_url: running.publicBaseUrl,
    html_public_base_url: running.htmlPublicBaseUrl,
    preview_mode: Boolean(options.trialApiKey),
    image_concurrency: running.imageGate.concurrency,
    rate_limit_per_minute: options.rateLimitPerMinute,
  });
  if (!options.publicBaseUrl) {
    write("WARNING", "PUBLIC_BASE_URL is not set: render_html links point at this machine and only work in local testing");
  }
  if (options.trialApiKey) {
    write(
      "WARNING",
      "TRIAL_API_KEY is set: keyless preview mode is ON. Its daily counters live in this process's memory and reset on every restart, new revision and scale-to-zero, so the limits are not reliable. Do not enable this in production until a persistent counter exists.",
    );
  }

  const shutdown = (signal: string) => {
    write("INFO", "shutting down", { signal });
    void running.close().then(() => process.exit(0));
    // In case a connection refuses to end.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS + 500).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
