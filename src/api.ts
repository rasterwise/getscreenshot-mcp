/**
 * Typed client for the GetScreenshot REST API.
 *
 * Ground rules that shape this file:
 * - The API is GET only and authenticates with the `apikey` query parameter.
 * - Every authenticated call costs the customer one quota unit, including failed
 *   captures. So nothing here retries on 5xx. The only automatic retry is for
 *   429 "Too Many Requests", which the gateway rejects before it is counted.
 * - Errors are mapped to messages a model can act on without reading docs.
 */
import { isIPv4, isIPv6 } from "node:net";
import { ACCOUNT_URL, API_KEY_ENV, PRICING_URL, USER_AGENT } from "./version.js";

export const DEFAULT_API_BASE = "https://api.rasterwise.com";
export const API_TIMEOUT_MS = 95_000;
export const RATE_LIMIT_RETRIES = 2;
export const SCREENSHOT_TTL_DAYS = 30;

export const DEVICE_PRESETS = [
  "iphone5",
  "iphone678",
  "iphone678_plus",
  "iphonex",
  "iphone12",
  "pixel2",
  "pixel2_xl",
  "ipad",
  "ipadpro",
  "hvga",
  "wvga",
  "dvga",
  "wxga_v",
  "xga",
  "wxga_s",
  "wxga_l",
  "sxga",
  "wsxga_plus",
] as const;
export type DevicePreset = (typeof DEVICE_PRESETS)[number];

export const WAIT_UNTIL_VALUES = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;
export type WaitUntil = (typeof WAIT_UNTIL_VALUES)[number];

export const IMAGE_FORMATS = ["png", "jpeg"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GetScreenshotErrorCode =
  | "no_api_key"
  | "missing_api_key"
  | "invalid_api_key"
  | "key_disabled"
  | "quota_exhausted"
  | "rate_limited"
  | "invalid_url"
  | "private_url"
  | "url_blocked"
  | "page_load_failed"
  | "capture_crashed"
  | "capture_failed"
  | "gateway_timeout"
  | "client_timeout"
  | "cancelled"
  | "network_error"
  | "unexpected_response"
  | "invalid_input"
  | "download_not_allowed"
  | "download_failed"
  | "image_too_large"
  | "image_processing_failed"
  | "html_too_large"
  | "html_host_unavailable"
  | "html_store_full"
  | "too_many_documents"
  | "server_busy"
  | "server_rate_limited"
  | "preview_limit_reached"
  | "preview_not_allowed";

export interface GetScreenshotErrorOptions {
  httpStatus?: number;
  /** True when the failed request was still counted against the monthly quota. */
  countedAgainstQuota?: boolean;
  cause?: unknown;
}

export class GetScreenshotError extends Error {
  readonly code: GetScreenshotErrorCode;
  readonly httpStatus: number | undefined;
  readonly countedAgainstQuota: boolean;

  constructor(code: GetScreenshotErrorCode, message: string, options: GetScreenshotErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GetScreenshotError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.countedAgainstQuota = options.countedAgainstQuota ?? false;
  }
}

const QUOTA_NOTE = " This failed attempt still counted as 1 screenshot against the monthly quota.";

export function noApiKeyMessage(): string {
  return (
    "No GetScreenshot API key is configured, so nothing was captured. " +
    `Get a key at ${PRICING_URL} (plans from $5/month for 2,500 screenshots; code FREE5 makes the first month of the $5 plan free). ` +
    "The key is emailed after checkout. " +
    `Then set it: for the local server put it in the ${API_KEY_ENV} environment variable of the MCP server config ` +
    '(for example `"env": { "GETSCREENSHOT_API_KEY": "YOUR_API_KEY" }`); ' +
    "for the hosted server send the header `Authorization: Bearer YOUR_API_KEY`. " +
    `Lost your key? Recover it at ${ACCOUNT_URL}.`
  );
}

export function noApiKeyError(): GetScreenshotError {
  return new GetScreenshotError("no_api_key", noApiKeyMessage());
}

/** What the caller asked for; used only to make error messages specific. */
export interface ErrorContext {
  endpoint: "capture" | "usage";
  element?: string | undefined;
  click?: string | undefined;
  waitUntil?: string | undefined;
  fullPage?: boolean | undefined;
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return undefined;
}

function snippet(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function crashMessage(ctx: ErrorContext): string {
  const causes: string[] = [];
  if (ctx.element) {
    causes.push(
      `the \`element\` selector ${JSON.stringify(ctx.element)} probably matched nothing on the page. ` +
        "Check the selector against the page's real markup, or capture without `element` first to see what is there",
    );
  }
  if (ctx.click) {
    causes.push(
      `the \`click\` selector ${JSON.stringify(ctx.click)} probably matched nothing, or the element was not clickable`,
    );
  }
  if (causes.length === 0) {
    return (
      "The capture crashed inside the browser (the API answered with a bare Internal Server Error). " +
      'No `element` or `click` selector was set, so the cause is the page itself. Try once more with wait_until: "domcontentloaded"' +
      (ctx.fullPage ? ", or a different full_page_strategy (0-3)" : "") +
      ". Do not retry in a loop: each attempt uses quota."
    );
  }
  return (
    "The capture crashed (the API answered with a bare Internal Server Error). Most likely cause: " +
    causes.join("; also possible: ") +
    ". Fix the input before retrying: each attempt uses quota."
  );
}

function pageLoadMessage(ctx: ErrorContext): string {
  const base =
    "The target page did not finish loading within the time limit. It may be slow, offline, or blocking automated browsers. ";
  if (ctx.waitUntil === "domcontentloaded") {
    return (
      base +
      'You already used wait_until: "domcontentloaded", so the site is probably unreachable from the public internet or refuses headless browsers. ' +
      "Check the URL in a normal browser. A hosted API cannot reach localhost or private networks."
    );
  }
  return (
    base +
    'Retry once with wait_until: "domcontentloaded" (fastest and most reliable on heavy sites) and a small wait_ms. ' +
    "If it still fails the site is likely blocking headless browsers and more retries will not help."
  );
}

/**
 * Turns a non-success HTTP response from the API into a typed, actionable error.
 * Covers every row of the API's error table plus a generic fallback.
 */
export function mapApiError(
  status: number,
  headers: { get(name: string): string | null },
  bodyText: string,
  ctx: ErrorContext,
): GetScreenshotError {
  const body = tryParseJson(bodyText);
  const message = typeof body?.message === "string" ? body.message : "";
  const bodyStatus = typeof body?.status === "string" ? body.status : "";
  const amznError = headers.get("x-amzn-errortype") ?? "";

  // 500 + AuthorizerConfigurationException: the gateway's legacy answer for an unknown key.
  if (/AuthorizerConfigurationException/i.test(amznError)) {
    return invalidKeyError(status);
  }

  if (status === 401) {
    return new GetScreenshotError(
      "missing_api_key",
      "The GetScreenshot API did not receive an API key. " + noApiKeyMessage(),
      { httpStatus: status },
    );
  }

  if (status === 403 && bodyStatus === "denied") {
    return new GetScreenshotError(
      "url_blocked",
      "The API refused this URL: URL shorteners and some blocked domains are not allowed. " +
        "Pass the final destination URL instead of a shortened or redirecting link." +
        QUOTA_NOTE,
      { httpStatus: status, countedAgainstQuota: true },
    );
  }

  if (status === 403) {
    return new GetScreenshotError(
      "key_disabled",
      // The gateway answers 403 "Forbidden" for a disabled key and, for some key shapes,
      // for a key it does not recognise at all, so the message has to cover both.
      "The GetScreenshot API rejected this API key (HTTP 403). Either the key is disabled, usually because the " +
        "subscription was cancelled or a payment failed, or it is not a valid key (check for typos, quotes or stray whitespace). " +
        `Check the subscription or recover the key at ${ACCOUNT_URL}, or start a new plan at ${PRICING_URL}. ` +
        "Retrying will not help until the key is active. Tell the user.",
      { httpStatus: status },
    );
  }

  if (status === 429 && /limit exceeded/i.test(message)) {
    return new GetScreenshotError(
      "quota_exhausted",
      "The monthly screenshot quota for this API key is used up. Retrying will not help until the quota resets at the start of the next billing month. " +
        `To continue now, upgrade the plan at ${PRICING_URL} (Lincoln 2,500/month for $5, Hamilton 6,000/month for $10, Jackson 15,000/month for $20). ` +
        "Tell the user.",
      { httpStatus: status },
    );
  }

  if (status === 429) {
    return new GetScreenshotError(
      "rate_limited",
      `The GetScreenshot API is rate limiting this key (still limited after ${RATE_LIMIT_RETRIES + 1} attempts). ` +
        "Wait a few seconds, then try again, and send fewer captures in parallel. Rate-limited attempts are not counted against the quota.",
      { httpStatus: status },
    );
  }

  if (status === 400 && /invalid api key/i.test(message)) {
    return invalidKeyError(status);
  }

  if (status === 400 && (bodyStatus === "denied" || /bad posture/i.test(message))) {
    return new GetScreenshotError(
      "invalid_url",
      "The API rejected the `url`: it is missing or not a valid absolute http:// or https:// URL. " +
        "Pass the full URL including the protocol, for example https://example.com/pricing." +
        QUOTA_NOTE,
      { httpStatus: status, countedAgainstQuota: true },
    );
  }

  if (bodyStatus === "failed" && /could not load/i.test(message)) {
    return new GetScreenshotError("page_load_failed", pageLoadMessage(ctx) + QUOTA_NOTE, {
      httpStatus: status,
      countedAgainstQuota: true,
    });
  }

  if (bodyStatus === "failed" && message) {
    return new GetScreenshotError(
      "capture_failed",
      `The capture failed. The API said: "${snippet(message, 400)}"` + QUOTA_NOTE,
      { httpStatus: status, countedAgainstQuota: true },
    );
  }

  if (status === 504) {
    return new GetScreenshotError(
      "gateway_timeout",
      "The capture took longer than the API's 90 second limit and was abandoned. " +
        'Try wait_until: "domcontentloaded", a smaller wait_ms, or capture the viewport or one `element` instead of the full page.' +
        QUOTA_NOTE,
      { httpStatus: status, countedAgainstQuota: true },
    );
  }

  // 500 with a non-JSON body ("Internal Server Error"): the capture function crashed.
  if (status === 500 && body === undefined) {
    return new GetScreenshotError("capture_crashed", crashMessage(ctx) + QUOTA_NOTE, {
      httpStatus: status,
      countedAgainstQuota: true,
    });
  }

  return new GetScreenshotError(
    "unexpected_response",
    `Unexpected response from the GetScreenshot API (HTTP ${status}): ${snippet(bodyText) || "(empty body)"}. ` +
      "Do not retry in a loop: an authenticated attempt may have used quota. If this keeps happening contact support@rasterwise.com.",
    { httpStatus: status, countedAgainstQuota: status >= 500 },
  );
}

function invalidKeyError(status: number): GetScreenshotError {
  // The gateway's 500 + AuthorizerConfigurationException is its answer for an
  // unknown key, but the same error type can also be a transient authorizer
  // failure, so one retry is reasonable when the key is known to be good.
  const retry =
    status >= 500
      ? "If you are sure the key is correct, retry once: this error can also be a temporary gateway fault. Otherwise fix the key before retrying, and tell the user."
      : "Retrying with the same key will not help. Tell the user.";
  return new GetScreenshotError(
    "invalid_api_key",
    "The GetScreenshot API does not recognise this API key. " +
      `Check ${API_KEY_ENV} (or the Authorization header) for typos, quotes or stray whitespace; the key is the exact string emailed after checkout. ` +
      `Recover a lost key at ${ACCOUNT_URL}, or get a new one at ${PRICING_URL}. ` +
      retry,
    { httpStatus: status },
  );
}

// ---------------------------------------------------------------------------
// Inputs and query-string mapping
// ---------------------------------------------------------------------------

export interface CookieInput {
  name: string;
  value: string;
}

/** Tool-level capture options (snake_case, as the MCP tools expose them). */
export interface CaptureInput {
  url: string;
  full_page?: boolean | undefined;
  element?: string | undefined;
  device?: DevicePreset | undefined;
  width?: number | undefined;
  height?: number | undefined;
  scale?: number | undefined;
  format?: ImageFormat | undefined;
  wait_until?: WaitUntil | undefined;
  wait_ms?: number | undefined;
  hide_selectors?: string | undefined;
  hide_cookie_banners?: boolean | undefined;
  hide_chat_widgets?: boolean | undefined;
  click?: string | undefined;
  custom_css?: string | undefined;
  custom_js?: string | undefined;
  highlight?: string | undefined;
  cookie?: CookieInput | undefined;
  lang?: string | undefined;
  transparent_background?: boolean | undefined;
  full_page_strategy?: number | undefined;
}

export interface PdfInput {
  url: string;
  wait_until?: WaitUntil | undefined;
  wait_ms?: number | undefined;
  hide_selectors?: string | undefined;
  custom_css?: string | undefined;
}

export type QueryParams = Array<[name: string, value: string]>;

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function pushNumber(out: QueryParams, name: string, value: number | undefined): void {
  if (typeof value === "number" && Number.isFinite(value)) out.push([name, String(Math.trunc(value))]);
}

function pushString(out: QueryParams, name: string, value: string | undefined): void {
  if (present(value)) out.push([name, value]);
}

/**
 * `timewait=0` is read by the API as "not set" and falls back to its 2000 ms
 * default, so an explicit zero is sent as 1 ms.
 */
function timewaitValue(waitMs: number): number {
  return waitMs <= 0 ? 1 : Math.trunc(waitMs);
}

/**
 * Maps tool input to the API's query parameters (without `apikey`).
 *
 * Rules: nothing undefined or empty is ever sent; booleans are sent only when
 * they differ from the API default (so `hidecookie` only ever appears as
 * `false`); with a `device` preset a full-page capture is `noheight=true`,
 * never `fullpage`, and `width`/`height` are dropped because the preset wins.
 */
export function buildCaptureParams(input: CaptureInput): QueryParams {
  const out: QueryParams = [["url", input.url]];

  if (input.device) {
    out.push(["preset", input.device]);
    if (input.full_page) out.push(["noheight", "true"]);
  } else {
    pushNumber(out, "width", input.width);
    pushNumber(out, "height", input.height);
    if (input.full_page) out.push(["fullpage", "true"]);
  }

  if (typeof input.scale === "number" && Math.trunc(input.scale) !== 1) pushNumber(out, "devicefactor", input.scale);
  pushString(out, "element", input.element);
  if (input.format && input.format !== "png") out.push(["format", input.format]);
  if (input.wait_until) out.push(["waituntil", input.wait_until]);
  if (typeof input.wait_ms === "number") out.push(["timewait", String(timewaitValue(input.wait_ms))]);
  pushString(out, "hideelement", input.hide_selectors);
  if (input.hide_cookie_banners === false) out.push(["hidecookie", "false"]);
  if (input.hide_chat_widgets === true) out.push(["hidemsg", "true"]);
  pushString(out, "click", input.click);
  pushString(out, "customcss", input.custom_css);
  pushString(out, "customjs", input.custom_js);
  pushString(out, "highlight", input.highlight);
  if (input.cookie && present(input.cookie.name)) {
    out.push(["cookie", `${input.cookie.name},${input.cookie.value}`]);
  }
  pushString(out, "lang", input.lang);
  if (input.transparent_background === true) out.push(["forcetr", "true"]);
  if (typeof input.full_page_strategy === "number" && Math.trunc(input.full_page_strategy) !== 0) {
    pushNumber(out, "strategy", input.full_page_strategy);
  }
  return out;
}

export function buildPdfParams(input: PdfInput): QueryParams {
  const out: QueryParams = [
    ["url", input.url],
    ["pdf", "true"],
  ];
  if (input.wait_until) out.push(["waituntil", input.wait_until]);
  if (typeof input.wait_ms === "number") out.push(["timewait", String(timewaitValue(input.wait_ms))]);
  pushString(out, "hideelement", input.hide_selectors);
  pushString(out, "customcss", input.custom_css);
  return out;
}

const PRIVATE_NAME_PATTERNS: RegExp[] = [/^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/];

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // "this network", including 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
  );
}

function isPrivateIPv6(address: string): boolean {
  const text = address.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d, which URL parsing prints as ::ffff:hhhh:hhhh).
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) return isPrivateIPv4(dotted[1] as string);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
  if (hex) {
    const hi = Number.parseInt(hex[1] as string, 16);
    const lo = Number.parseInt(hex[2] as string, 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (text === "::1" || text === "::") return true; // loopback, unspecified
  const first = Number.parseInt(text.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
  );
}

/**
 * True for hosts a hosted API can never reach: localhost and private names,
 * and IP literals in loopback, private, link-local or unique-local ranges.
 * The numeric ranges apply only to IP literals, so public names that merely
 * start with digits (10.com, 127.news, 169.254.co) are not caught.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIPv4(bare)) return isPrivateIPv4(bare);
  if (isIPv6(bare)) return isPrivateIPv6(bare);
  return PRIVATE_NAME_PATTERNS.some((re) => re.test(host));
}

/**
 * Rejects URLs the hosted API can never capture, before spending a quota unit:
 * non-http(s) schemes and localhost / private-network hosts.
 */
export function validateTargetUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GetScreenshotError(
      "invalid_url",
      `\`url\` must be an absolute http:// or https:// URL, for example https://example.com. Got ${JSON.stringify(snippet(raw, 120))}. Nothing was captured and no quota was used.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GetScreenshotError(
      "invalid_url",
      `\`url\` must use http:// or https:// (got ${parsed.protocol}). To capture HTML you have as a string or a local file, pass its contents to render_html. Nothing was captured and no quota was used.`,
    );
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new GetScreenshotError(
      "private_url",
      `${parsed.hostname} is a localhost or private-network address. GetScreenshot is a hosted API and can only load pages reachable from the public internet. ` +
        "Options: pass the page's HTML to render_html, or expose the dev server through a public preview URL or tunnel and capture that URL. Nothing was captured and no quota was used.",
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface CaptureResult {
  screenshotUrl: string;
  originUrl: string;
  pageStatus: number | null;
  /** ISO 8601 UTC timestamp, or null when the API's date fields could not be parsed. */
  capturedAt: string | null;
  format: ImageFormat;
}

export interface PdfResult {
  pdfUrl: string;
  originUrl: string;
  pageStatus: number | null;
  capturedAt: string | null;
}

export interface UsageResult {
  used: number;
  limit: number;
  remaining: number;
  period: string;
  /** As reported by the API (`quotaRestartDate`). */
  quotaRestartDate: string | null;
}

/** `captureDate` "2026/11/18" + `captureHour` "14:03:22" (UTC) to ISO 8601. */
export function parseCapturedAt(date: unknown, hour: unknown): string | null {
  if (typeof date !== "string" || typeof hour !== "string") return null;
  const d = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(date.trim());
  const h = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hour.trim());
  if (!d || !h) return null;
  const pad = (s: string | undefined) => (s ?? "00").padStart(2, "0");
  const iso = `${d[1]}-${pad(d[2])}-${pad(d[3])}T${pad(h[1])}:${pad(h[2])}:${pad(h[3])}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function toPageStatus(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  apiKey: string;
  /** Defaults to env GETSCREENSHOT_API_BASE, then https://api.rasterwise.com. */
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Base delay for the 429 backoff. Tests set this to a few ms. */
  retryBaseMs?: number | undefined;
  random?: (() => number) | undefined;
}

export interface CallOptions {
  signal?: AbortSignal | undefined;
  /** Skip the localhost / private-network pre-check (used for URLs this server hosts itself). */
  skipUrlCheck?: boolean | undefined;
}

export function resolveApiBase(explicit?: string | undefined): string {
  const raw = explicit ?? process.env.GETSCREENSHOT_API_BASE ?? DEFAULT_API_BASE;
  return raw.trim().replace(/\/+$/, "") || DEFAULT_API_BASE;
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GetScreenshotError("cancelled", "The request was cancelled."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GetScreenshotError("cancelled", "The request was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class GetScreenshotClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBaseMs: number;
  private readonly random: () => number;

  constructor(options: ApiClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = resolveApiBase(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.random = options.random ?? Math.random;
  }

  async capture(input: CaptureInput, options: CallOptions = {}): Promise<CaptureResult> {
    if (!options.skipUrlCheck) validateTargetUrl(input.url);
    const body = await this.request("/v1/get-screenshot", buildCaptureParams(input), options.signal, {
      endpoint: "capture",
      element: input.element,
      click: input.click,
      waitUntil: input.wait_until,
      fullPage: input.full_page,
    });
    const url = body.screenshotImage;
    if (body.status !== "success" || typeof url !== "string" || url === "") {
      throw unexpectedSuccessBody(body, "screenshotImage");
    }
    return {
      screenshotUrl: url,
      originUrl: typeof body.originUrl === "string" ? body.originUrl : input.url,
      pageStatus: toPageStatus(body.pageStatus),
      capturedAt: parseCapturedAt(body.captureDate, body.captureHour),
      format: /\.jpe?g(\?|$)/i.test(url) ? "jpeg" : /\.png(\?|$)/i.test(url) ? "png" : (input.format ?? "png"),
    };
  }

  async capturePdf(input: PdfInput, options: CallOptions = {}): Promise<PdfResult> {
    if (!options.skipUrlCheck) validateTargetUrl(input.url);
    const body = await this.request("/v1/get-screenshot", buildPdfParams(input), options.signal, {
      endpoint: "capture",
      waitUntil: input.wait_until,
    });
    const url = body.pdfFile;
    if (body.status !== "success" || typeof url !== "string" || url === "") {
      throw unexpectedSuccessBody(body, "pdfFile");
    }
    return {
      pdfUrl: url,
      originUrl: typeof body.originUrl === "string" ? body.originUrl : input.url,
      pageStatus: toPageStatus(body.pageStatus),
      capturedAt: parseCapturedAt(body.captureDate, body.captureHour),
    };
  }

  async usage(options: CallOptions = {}): Promise<UsageResult> {
    // `email` must be present (any non-empty value) or the endpoint answers 400.
    const body = await this.request("/v1/usage", [["email", "getscreenshot-mcp"]], options.signal, {
      endpoint: "usage",
    });
    const used = typeof body.usedQuota === "number" ? body.usedQuota : Number.NaN;
    const quota = body.remainingQuota as Record<string, unknown> | null | undefined;
    const limit = quota && typeof quota.limit === "number" ? quota.limit : Number.NaN;
    if (!Number.isFinite(used) || !Number.isFinite(limit)) {
      throw new GetScreenshotError(
        "unexpected_response",
        `The usage endpoint answered in an unexpected shape: ${snippet(JSON.stringify(body))}. See ${ACCOUNT_URL} for usage instead.`,
      );
    }
    return {
      used,
      limit,
      // `remainingQuota` is the plan's quota object, not a remaining count.
      remaining: Math.max(0, limit - used),
      period: quota && typeof quota.period === "string" ? quota.period : "MONTH",
      quotaRestartDate: typeof body.quotaRestartDate === "string" ? body.quotaRestartDate : null,
    };
  }

  private redact(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join("***") : text;
  }

  private async request(
    path: string,
    params: QueryParams,
    signal: AbortSignal | undefined,
    ctx: ErrorContext,
  ): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw noApiKeyError();

    const query = new URLSearchParams();
    query.set("apikey", this.apiKey);
    for (const [name, value] of params) query.set(name, value);
    const url = `${this.baseUrl}${path}?${query.toString()}`;

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let response: Response;
      let text: string;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          redirect: "error",
          signal: combined,
        });
        text = await response.text();
      } catch (err) {
        if (signal?.aborted) {
          throw new GetScreenshotError(
            "cancelled",
            "The request was cancelled before the API answered. The capture may still have run and used quota.",
            { cause: err },
          );
        }
        if (timeout.aborted) {
          throw new GetScreenshotError(
            "client_timeout",
            `The API did not answer within ${Math.round(this.timeoutMs / 1000)} seconds, so the request was abandoned. ` +
              'Try wait_until: "domcontentloaded", a smaller wait_ms, or capture the viewport instead of the full page.' +
              QUOTA_NOTE,
            { countedAgainstQuota: true, cause: err },
          );
        }
        const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
        throw new GetScreenshotError(
          "network_error",
          `Could not reach the GetScreenshot API at ${new URL(this.baseUrl).host}: ${this.redact(cause)}. ` +
            "Check that this environment has outbound HTTPS access. Nothing was captured.",
          { cause: err },
        );
      }

      if (response.ok) {
        const body = tryParseJson(text);
        if (!body) {
          throw new GetScreenshotError(
            "unexpected_response",
            `The API answered HTTP ${response.status} with a body that is not JSON: ${snippet(this.redact(text)) || "(empty)"}.`,
            { httpStatus: response.status, countedAgainstQuota: true },
          );
        }
        return body;
      }

      const isTooManyRequests = response.status === 429 && /too many requests/i.test(text);
      if (isTooManyRequests && attempt < RATE_LIMIT_RETRIES) {
        // Jittered exponential backoff: base * 2^attempt * [0.5, 1.5).
        const delay = this.retryBaseMs * 2 ** attempt * (0.5 + this.random());
        await abortableSleep(delay, signal);
        continue;
      }

      const mapped = mapApiError(response.status, response.headers, text, ctx);
      // Belt and braces: an error message must never carry the key.
      if (this.apiKey && mapped.message.includes(this.apiKey)) {
        throw new GetScreenshotError(mapped.code, this.redact(mapped.message), {
          httpStatus: mapped.httpStatus,
          countedAgainstQuota: mapped.countedAgainstQuota,
        });
      }
      throw mapped;
    }
  }
}

function unexpectedSuccessBody(body: Record<string, unknown>, field: string): GetScreenshotError {
  const apiMessage = typeof body.message === "string" ? ` The API said: "${snippet(body.message, 300)}".` : "";
  return new GetScreenshotError(
    "unexpected_response",
    `The API answered HTTP 200 but without a \`${field}\` URL.${apiMessage} The attempt probably used quota; do not retry in a loop.`,
    { httpStatus: 200, countedAgainstQuota: true },
  );
}
