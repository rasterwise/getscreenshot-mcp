/**
 * The five MCP tools. Each returns a short text summary, inline JPEG images
 * sized for vision models where relevant, and `structuredContent` matching the
 * declared `outputSchema`. Failures are `isError: true` results with a message
 * the model can act on; they are never thrown as protocol errors.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DEVICE_PRESETS,
  GetScreenshotClient,
  GetScreenshotError,
  IMAGE_FORMATS,
  SCREENSHOT_TTL_DAYS,
  WAIT_UNTIL_VALUES,
  noApiKeyError,
  validateTargetUrl,
  type CaptureInput,
  type CaptureResult,
  type GetScreenshotErrorCode,
} from "./api.js";
import { DEFAULT_DIFF_THRESHOLD, compareMaxHeight, cropRows, diffImages, focusRows } from "./diff.js";
import { allowedOriginsFor, assertResultUrl, downloadResult, type DownloadOptions } from "./download.js";
import { HTML_MAX_BYTES, htmlTooLargeError, type HtmlHost } from "./html-store.js";
import { defaultImageGate, serverBusyError, type ImageGate, type LimitResult } from "./limits.js";
import { PRICING_URL } from "./version.js";
import {
  DEFAULT_MAX_SLICES,
  DETAIL_LEVELS,
  MAX_SLICES_LIMIT,
  planSlices,
  probeDimensions,
  sizeForVision,
  type Detail,
  type VisionImage,
} from "./vision.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Keyless preview quota of the hosted server (off unless the operator enables it). */
export interface PreviewGate {
  /** Reserves one preview capture for the calling client. */
  tryConsume(): { ok: true } | { ok: false; scope: "ip" | "global" };
  readonly limitPerIp: number;
  /** Origins a preview capture may not target: the server's own, where anyone can host HTML. */
  readonly blockedOrigins?: readonly string[] | undefined;
}

/** What a keyless preview capture may ask for. Everything else needs a key. */
export const PREVIEW_LIMITS = { maxWidth: 1920, maxHeight: 1200, maxWaitMs: 5000 } as const;

export interface ToolCallEvent {
  tool: string;
  ok: boolean;
  /** Error code for failed calls. */
  code?: string | undefined;
  ms: number;
}

/** Everything a server instance needs to know about the request or process it serves. */
export interface ServerContext {
  /** The caller's API key. Absent means every tool answers with "how to get a key". */
  apiKey?: string | undefined;
  /** REST API base URL. Defaults to env GETSCREENSHOT_API_BASE, then the production API. */
  apiBase?: string | undefined;
  /** Where render_html can put HTML so the API can load it. Absent disables render_html. */
  htmlHost?: HtmlHost | undefined;
  /** Set when `apiKey` is the operator's preview key rather than the caller's own. */
  preview?: PreviewGate | undefined;
  /** Hosted mode: counts one tool call for this caller, or refuses it. Checked before anything else. */
  rateLimit?: (() => LimitResult) | undefined;
  /** Limits how much image work runs at once. Defaults to the process-wide gate. */
  imageGate?: ImageGate | undefined;
  /** Rows compared by compare_screenshots at most. Defaults to env COMPARE_MAX_HEIGHT, then 2400. */
  compareMaxHeight?: number | undefined;
  /** Origins that capture results may be downloaded from. Defaults to the storage host (plus an overridden API base). */
  allowedOrigins?: readonly string[] | undefined;
  /** How often to send progress notifications while waiting on the API. Default 5000 ms. */
  progressIntervalMs?: number | undefined;
  /** Base delay for the 429 backoff. Tests shorten it. */
  retryBaseMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Called once per tool call with the outcome. Never receives arguments or the key. */
  onToolCall?: ((event: ToolCallEvent) => void) | undefined;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

interface CallEnv {
  ctx: ServerContext;
  client: GetScreenshotClient;
  signal: AbortSignal;
  download: DownloadOptions;
  gate: ImageGate;
}

// ---------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------

const ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const fields = {
  url: z
    .string()
    .min(1)
    .max(8192)
    .describe(
      "Absolute http(s) URL of the page, reachable from the public internet. localhost and private-network addresses cannot be captured; use render_html for local HTML.",
    ),
  full_page: z
    .boolean()
    .default(false)
    .describe(
      "Capture the whole scrollable page instead of just the viewport. Tall pages are returned as several image slices and cost more tokens.",
    ),
  element: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      'CSS selector of one element to capture, for example "#pricing" or "main .hero". Cheapest way to look at one part of a page. A selector that matches nothing makes the capture fail (and still uses quota).',
    ),
  device: z
    .enum(DEVICE_PRESETS)
    .optional()
    .describe(
      "Device preset: sets the viewport and, for phones, a mobile user agent. Overrides width and height. iphone* and pixel* are phones, ipad* are tablets, the rest are fixed desktop sizes.",
    ),
  width: z.number().int().min(1).max(10000).optional().describe("Viewport width in CSS pixels. API default 1280. Ignored when device is set."),
  height: z.number().int().min(1).max(10000).optional().describe("Viewport height in CSS pixels. API default 800. Ignored when device is set."),
  scale: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe("Device pixel ratio of the stored image: 1 (default), 2 (retina) or 3. Affects the file at screenshot_url; inline images are downscaled either way."),
  wait_until: z
    .enum(WAIT_UNTIL_VALUES)
    .optional()
    .describe(
      'When the page counts as loaded. API default "networkidle2". Use "domcontentloaded" for heavy or slow sites (fastest, most reliable); "networkidle0" waits for all network activity to stop.',
    ),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(20000)
    .optional()
    .describe("Extra wait in milliseconds after load, before the capture. API default 2000. Raise it for late animations or client-side rendering."),
  hide_selectors: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('CSS selector(s) to hide (display:none) before capture, comma-separated, for example ".newsletter-popup, #ad-banner".'),
  detail: z
    .enum(DETAIL_LEVELS)
    .default("standard")
    .describe(
      'Size of the inline images. "standard": at most 1280 px wide, about 1,568 tokens per image. "high": at most 1920 px wide, about 4,784 tokens per image; use it only to read small text.',
    ),
  max_slices: z
    .number()
    .int()
    .min(1)
    .max(MAX_SLICES_LIMIT)
    .default(DEFAULT_MAX_SLICES)
    .describe(
      "Maximum number of inline images. A tall capture is cut into slices from the top; slices beyond this are left out and reported as truncated. Slices are also left out if the inline images would exceed about 1.5 MB in total (4 MB at high detail).",
    ),
  return: z
    .enum(["image_and_url", "url_only"])
    .default("image_and_url")
    .describe('"image_and_url" attaches the images. "url_only" returns just the link and sizes, for when you need the file but do not need to look at it (uses no image tokens).'),
};

/**
 * Integer in an output schema. Plain `number` on the wire: zod's integer type
 * adds safe-integer minimum/maximum bounds to the JSON Schema, which would
 * bloat every tools/list response for no benefit.
 */
const int = () => z.number();

const sliceSchema = z.object({
  index: int().describe("0-based position of the slice, top to bottom."),
  y: int().describe("Top offset of this image within the downscaled capture, in the same pixels as width/height."),
  width: int(),
  height: int(),
  estimated_tokens: int().describe("Approximate vision tokens: ceil(width/28) * ceil(height/28)."),
});

const visionOutputFields = {
  images: z.array(sliceSchema).describe("One entry per inline image, in the same order as the image blocks."),
  total_slices: int().describe(
    'How many slices the whole image needs at this detail level, whether or not they are attached. With return: "url_only" this is how many a normal call would produce.',
  ),
  truncated: z
    .boolean()
    .describe(
      'True when images were requested and some slices were left out, because of max_slices or the inline size limit. Always false with return: "url_only", where no image is attached by request.',
    ),
  estimated_image_tokens: int().describe("Approximate total vision tokens of the inline images."),
  expires_in_days: int().describe("Stored files are deleted after this many days."),
  warnings: z.array(z.string()).describe("Things worth knowing about this result, for example an error status from the page."),
};

const captureOutputSchema = z.object({
  screenshot_url: z.string().describe("Full-resolution image. Public to anyone who has the link."),
  origin_url: z.string(),
  page_status: int().nullable().describe("HTTP status the page answered with. 400 or above usually means an error page was captured."),
  captured_at: z.string().nullable().describe("ISO 8601 UTC time of the capture."),
  format: z.enum(IMAGE_FORMATS).describe("Format of the stored file at screenshot_url."),
  original: z
    .object({ width: int(), height: int() })
    .nullable()
    .describe("Pixel size of the stored image. Null if it could not be read."),
  ...visionOutputFields,
});
type CaptureOutput = z.infer<typeof captureOutputSchema>;

const compareSideSchema = z.object({
  screenshot_url: z.string(),
  origin_url: z.string().nullable().describe("Page that was captured; null when an existing screenshot was supplied."),
  page_status: int().nullable(),
  width: int(),
  height: int(),
});

const compareOutputSchema = z.object({
  changed_percent: z.number().describe("Share of compared pixels that differ, 0-100."),
  changed_pixels: int(),
  total_pixels: int(),
  identical: z.boolean().describe("True when no compared pixel differs and both images have exactly the same width and height."),
  threshold: z.number(),
  bounding_box: z
    .object({ x: int(), y: int(), width: int(), height: int() })
    .nullable()
    .describe("Smallest rectangle containing all changed pixels, in comparison-image pixels. Null when nothing changed."),
  size_changed: z.boolean().describe("True when the two images differ in size, for example the page got taller."),
  compared: z
    .object({ width: int(), height: int() })
    .describe("Size both images were normalised to before comparing."),
  before: compareSideSchema,
  after: compareSideSchema,
  ...visionOutputFields,
});
type CompareOutput = z.infer<typeof compareOutputSchema>;

const pdfOutputSchema = z.object({
  pdf_url: z.string().describe("The PDF file. Public to anyone who has the link."),
  origin_url: z.string(),
  page_status: int().nullable(),
  captured_at: z.string().nullable(),
  expires_in_days: int(),
  warnings: z.array(z.string()),
});

const usageOutputSchema = z.object({
  used: int().describe("Screenshots used in the current period."),
  limit: int().describe("Screenshots included per period on this plan."),
  remaining: int(),
  percent_used: z.number(),
  period: z.string(),
  quota_restart_date: z.string().nullable().describe("`quotaRestartDate` exactly as the API reports it."),
  resets_on: z.string().nullable().describe("Date (UTC) the monthly quota next resets."),
});

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

const nf = new Intl.NumberFormat("en-US");

function errorCode(err: unknown): string {
  return err instanceof GetScreenshotError ? err.code : "internal_error";
}

export function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof GetScreenshotError
      ? err.message
      : `Unexpected error in the GetScreenshot MCP server: ${err instanceof Error ? err.message : String(err)}. This is a bug in the server, not in your input.`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

function imageBlocks(images: readonly VisionImage[]): CallToolResult["content"] {
  return images.map((image) => ({
    type: "image" as const,
    data: image.data.toString("base64"),
    mimeType: "image/jpeg",
  }));
}

function sliceMeta(images: readonly VisionImage[]): CaptureOutput["images"] {
  return images.map(({ index, y, width, height, estimated_tokens }) => ({ index, y, width, height, estimated_tokens }));
}

function pageStatusWarning(status: number | null, what = "The page"): string | undefined {
  if (status !== null && status >= 400) {
    return `${what} answered with HTTP ${status}, so this is probably an error page and not the content you wanted. Check the URL.`;
  }
  return undefined;
}

function previewNote(gate: PreviewGate): string {
  return (
    `Preview capture: made without an API key (limit ${gate.limitPerIp} per day, viewport only). ` +
    `For full pages, the other tools and your own quota, get a key at ${PRICING_URL} (plans from $5/month for 2,500 screenshots; code FREE5 makes the first month of the $5 plan free) ` +
    "and send it as `Authorization: Bearer YOUR_API_KEY`."
  );
}

function previewLimitError(gate: PreviewGate, scope: "ip" | "global"): GetScreenshotError {
  const which =
    scope === "ip"
      ? `You have used all ${gate.limitPerIp} keyless preview captures for today.`
      : "The shared keyless preview allowance for today is used up.";
  return new GetScreenshotError(
    "preview_limit_reached",
    `${which} To keep capturing, get an API key at ${PRICING_URL} (plans from $5/month for 2,500 screenshots; code FREE5 makes the first month of the $5 plan free) ` +
      "and add it to the MCP server config as the header `Authorization: Bearer YOUR_API_KEY`. Retrying without a key will not work until tomorrow (UTC).",
  );
}

function previewNotAllowed(what: string): GetScreenshotError {
  return new GetScreenshotError(
    "preview_not_allowed",
    `${what} needs an API key. Without a key this server only does plain viewport captures of public pages with capture_screenshot. ` +
      `Get a key at ${PRICING_URL} (plans from $5/month for 2,500 screenshots; code FREE5 makes the first month of the $5 plan free) and send it as \`Authorization: Bearer YOUR_API_KEY\`.`,
  );
}

function rateLimitError(retryAfterSeconds: number): GetScreenshotError {
  return new GetScreenshotError(
    "server_rate_limited",
    `Too many tool calls in the last minute, so this one was refused by the MCP server. Wait about ${retryAfterSeconds} seconds, then retry. ` +
      "Nothing was captured and no quota was used.",
  );
}

/** Sends a progress notification every few seconds while `work` runs, if the client asked for progress. */
async function withProgress<T>(extra: Extra, intervalMs: number, label: string, work: () => Promise<T>): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return work();
  const started = Date.now();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    const seconds = Math.round((Date.now() - started) / 1000);
    extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: ticks,
          message: `${label}: ${seconds}s elapsed (captures usually take 9-25 s)`,
        },
      })
      .catch(() => undefined);
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** What the report needs to know about the inline images of a capture. */
interface Sized {
  original: { width: number; height: number };
  images: VisionImage[];
  total_slices: number;
  truncated: boolean;
  byte_limited: boolean;
  estimated_image_tokens: number;
  /** Height of the whole downscaled image. */
  scaledHeight: number;
}

interface SizedCapture {
  vision: Sized | undefined;
  warnings: string[];
}

/**
 * Downloads and sizes a successful capture. Never throws: the capture is paid
 * for, so its URL must survive a failed download, a busy server or a bad image.
 */
async function sizeCapture(
  url: string,
  options: { detail: Detail; maxSlices: number; urlOnly: boolean },
  env: CallEnv,
): Promise<SizedCapture> {
  try {
    if (options.urlOnly) {
      // Only the dimensions are needed: read the first 64 KB instead of the whole file.
      const original = await probeDimensions(url, env.download);
      const plan = planSlices(original.width, original.height, options.detail, options.maxSlices);
      return {
        vision: {
          original,
          images: [],
          total_slices: plan.totalSlices,
          truncated: false,
          byte_limited: false,
          estimated_image_tokens: 0,
          scaledHeight: plan.scaledHeight,
        },
        warnings: [],
      };
    }
    const vision = await env.gate.run(async () => {
      const file = await downloadResult(url, env.download);
      return sizeForVision(file.data, { detail: options.detail, maxSlices: options.maxSlices });
    }, env.signal);
    return { vision: { ...vision, scaledHeight: vision.plan.scaledHeight }, warnings: [...vision.warnings] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const busy = err instanceof GetScreenshotError && err.code === "server_busy";
    return {
      vision: undefined,
      warnings: [
        options.urlOnly
          ? `The capture succeeded, but its dimensions could not be read: ${reason}`
          : busy
            ? `The capture succeeded and is stored at the URL, but the image could not be attached inline: ${reason} Open the URL instead. Do not capture again just for this.`
            : `The capture succeeded, but the image could not be attached inline: ${reason} Use the URL instead. Do not capture again just for this.`,
      ],
    };
  }
}

/** How many times render_html hosts and captures a document before giving up. */
const HTML_HOST_ATTEMPTS = 2;

/**
 * Hosts the HTML, captures it and removes it again.
 *
 * The temporary URL only ever answers 404 when the document was not there at
 * the moment the browser asked for it, which happens when the hosted service
 * is replacing an instance. A screenshot of that 404 is useless to the caller,
 * so the document is hosted and captured once more, and after that the call
 * fails with an explanation.
 */
async function captureHostedHtml(
  host: HtmlHost,
  html: string,
  params: Omit<CaptureInput, "url">,
  env: CallEnv,
): Promise<{ capture: CaptureResult; attempts: number }> {
  for (let attempt = 1; ; attempt += 1) {
    const hosted = await host.publish(html, env.signal);
    let capture: CaptureResult;
    try {
      capture = await env.client.capture(
        { url: hosted.url, ...params, hide_cookie_banners: false },
        // The temporary URL is ours; in development it can be a local address.
        { signal: env.signal, skipUrlCheck: true },
      );
    } finally {
      // Whether the capture worked or not, the document has served its purpose.
      await hosted.dispose();
    }
    if (capture.pageStatus !== 404) return { capture, attempts: attempt };
    if (attempt >= HTML_HOST_ATTEMPTS) {
      throw new GetScreenshotError(
        "html_host_unavailable",
        `render_html could not get the HTML to the capture service: the temporary URL answered HTTP 404 on ${attempt} attempts, so there is no useful image. ` +
          `${attempt} screenshots of the quota were used. This is a problem on the hosting side, not in your HTML. ` +
          "Wait a minute and try again, or publish the page at a public URL and use capture_screenshot.",
        { countedAgainstQuota: true },
      );
    }
  }
}

interface CaptureReportOptions {
  detail: Detail;
  maxSlices: number;
  urlOnly: boolean;
  headline: string;
  sourceLine: string;
  extraNotes?: string[];
}

async function captureReport(capture: CaptureResult, options: CaptureReportOptions, env: CallEnv): Promise<CallToolResult> {
  const sized = await sizeCapture(capture.screenshotUrl, options, env);
  const vision = sized.vision;
  const images = vision?.images ?? [];
  const warnings = [...sized.warnings];
  const statusWarning = pageStatusWarning(capture.pageStatus);
  if (statusWarning) warnings.push(statusWarning);

  const structured: CaptureOutput = {
    screenshot_url: capture.screenshotUrl,
    origin_url: capture.originUrl,
    page_status: capture.pageStatus,
    captured_at: capture.capturedAt,
    format: capture.format,
    original: vision ? vision.original : null,
    images: sliceMeta(images),
    total_slices: vision?.total_slices ?? 0,
    truncated: vision?.truncated ?? false,
    estimated_image_tokens: vision?.estimated_image_tokens ?? 0,
    expires_in_days: SCREENSHOT_TTL_DAYS,
    warnings,
  };

  const lines: string[] = [`${options.headline}: ${capture.screenshotUrl}`, options.sourceLine];
  if (vision) {
    lines.push(`Original image: ${vision.original.width}x${vision.original.height} px (${capture.format}).`);
  }
  if (options.urlOnly) {
    lines.push('No image attached (return: "url_only").');
  } else if (vision && images.length > 0) {
    const first = images[0] as VisionImage;
    const count =
      vision.total_slices === 1
        ? `1 JPEG image, ${first.width}x${first.height} px`
        : `${images.length} of ${vision.total_slices} slices as JPEG images, ${first.width} px wide, top to bottom`;
    lines.push(`Attached: ${count}, about ${nf.format(vision.estimated_image_tokens)} image tokens (approximate).`);
    if (vision.truncated) {
      const shownTo = first.y + images.reduce((sum, image) => sum + image.height, 0);
      lines.push(
        `Truncated: only the top ${shownTo} px of ${vision.scaledHeight} px (after downscaling) are attached` +
          (vision.byte_limited
            ? ", because more would exceed the inline size limit. To see the rest, capture one part with `element`."
            : `. To see the rest, raise max_slices (up to ${MAX_SLICES_LIMIT}) or capture one part with \`element\`.`),
      );
    }
  }
  lines.push(`The link is public to anyone who has it and expires in ${SCREENSHOT_TTL_DAYS} days.`);
  for (const note of options.extraNotes ?? []) lines.push(note);
  for (const warning of warnings) lines.push(`Warning: ${warning}`);

  return {
    content: [{ type: "text", text: lines.join("\n") }, ...imageBlocks(images)],
    structuredContent: structured,
  };
}

function statusText(status: number | null): string {
  return status === null ? "status unknown" : `HTTP ${status}`;
}

// ---------------------------------------------------------------------------
// Server instructions
// ---------------------------------------------------------------------------

export const SERVER_INSTRUCTIONS = [
  "GetScreenshot captures public web pages with a hosted headless browser and returns images sized for vision models.",
  "Use capture_screenshot to look at a live URL; pass `element` to look at one part of a page cheaply, and `full_page` only when you need the whole page.",
  "Use render_html to see HTML you have as a string (a component or page you just wrote); this is also the way to check local work, because the service cannot reach localhost or private networks.",
  "Use compare_screenshots to verify a visual change (before/after, staging vs production), capture_pdf for an A4 PDF link, and get_usage to check the remaining quota.",
  "Every capture uses one screenshot of the monthly quota, failed captures included, and takes about 9-25 seconds, so fix the input instead of retrying a failure unchanged.",
  'If a page fails to load, retry once with wait_until: "domcontentloaded".',
  "Captures are single shots of a page: there is no session, login flow or multi-step interaction.",
].join(" ");

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const TOOL_NAMES = ["capture_screenshot", "render_html", "compare_screenshots", "capture_pdf", "get_usage"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function registerTools(server: McpServer, ctx: ServerContext): void {
  const progressIntervalMs = ctx.progressIntervalMs ?? 5000;
  const compareHeight = ctx.compareMaxHeight ?? compareMaxHeight();

  /** Wraps a handler with the key check, preview rules, progress, logging and error mapping. */
  function run<I>(
    tool: ToolName,
    label: string,
    handler: (input: I, env: CallEnv) => Promise<CallToolResult>,
    previewCheck?: (input: I) => void,
  ): (input: I, extra: Extra) => Promise<CallToolResult> {
    return async (input, extra) => {
      const started = Date.now();
      try {
        const allowed = ctx.rateLimit?.();
        if (allowed && !allowed.ok) throw rateLimitError(allowed.retryAfterSeconds);
        if (!ctx.apiKey) throw noApiKeyError();
        if (ctx.preview) {
          if (!previewCheck) throw previewNotAllowed(`The ${tool} tool`);
          previewCheck(input);
          const reserved = ctx.preview.tryConsume();
          if (!reserved.ok) throw previewLimitError(ctx.preview, reserved.scope);
        }
        const env: CallEnv = {
          ctx,
          client: new GetScreenshotClient({
            apiKey: ctx.apiKey,
            baseUrl: ctx.apiBase,
            fetchImpl: ctx.fetchImpl,
            retryBaseMs: ctx.retryBaseMs,
          }),
          signal: extra.signal,
          download: {
            allowedOrigins: ctx.allowedOrigins ?? allowedOriginsFor(ctx.apiBase),
            signal: extra.signal,
            fetchImpl: ctx.fetchImpl,
          },
          gate: ctx.imageGate ?? defaultImageGate(),
        };
        const result = await withProgress(extra, progressIntervalMs, label, () => handler(input, env));
        ctx.onToolCall?.({ tool, ok: true, ms: Date.now() - started });
        return result;
      } catch (err) {
        ctx.onToolCall?.({ tool, ok: false, code: errorCode(err), ms: Date.now() - started });
        return errorResult(err);
      }
    };
  }

  // -- capture_screenshot ---------------------------------------------------

  const captureInput = z.strictObject({
    url: fields.url,
    full_page: fields.full_page,
    element: fields.element,
    device: fields.device,
    width: fields.width,
    height: fields.height,
    scale: fields.scale,
    format: z
      .enum(IMAGE_FORMATS)
      .default("png")
      .describe("Format of the stored file at screenshot_url. Inline images are always JPEG."),
    wait_until: fields.wait_until,
    wait_ms: fields.wait_ms,
    hide_selectors: fields.hide_selectors,
    hide_cookie_banners: z.boolean().default(true).describe("Hide common cookie-consent banners. Set false to keep them in the picture."),
    hide_chat_widgets: z.boolean().default(false).describe("Hide common chat widgets (Intercom, Drift and similar)."),
    click: z.string().min(1).max(2000).optional().describe("CSS selector of an element to click once before the capture, for example to open a menu or dismiss a dialog. A selector that matches nothing makes the capture fail."),
    custom_css: z.string().min(1).max(20000).optional().describe("CSS injected into the page before capture."),
    custom_js: z.string().min(1).max(20000).optional().describe("JavaScript run in the page before capture."),
    highlight: z.string().min(1).max(500).optional().describe("Keyword(s) to highlight on the page."),
    cookie: z
      .strictObject({
        name: z.string().min(1).max(256).regex(/^[^,;=\s]+$/, "must not contain commas, semicolons, equals signs or whitespace"),
        value: z.string().max(4096).regex(/^[^,;\s]*$/, "must not contain commas, semicolons or whitespace"),
      })
      .optional()
      .describe("One cookie to set for the target host before loading, for example a feature flag or locale. Do not pass credentials or session tokens."),
    lang: z.string().min(2).max(35).optional().describe('Browser language / Accept-Language, for example "de-DE". API default "en-US".'),
    transparent_background: z.boolean().default(false).describe("Keep the background transparent where the page sets none (PNG only). Inline images are flattened onto white."),
    full_page_strategy: z
      .number()
      .int()
      .min(0)
      .max(3)
      .optional()
      .describe("Full-page capture strategy 0-3 (default 0). Try another value if a full_page capture renders badly (missing sections, repeated headers)."),
    detail: fields.detail,
    max_slices: fields.max_slices,
    return: fields.return,
  });

  server.registerTool(
    "capture_screenshot",
    {
      title: "Capture screenshot",
      description: [
        "Capture a public web page as an image you can see. Renders the URL in a hosted headless Chromium and returns a link to the full-resolution image plus inline JPEG images sized for vision models.",
        "Use it to look at a live page, verify a deployed change, check a design on a phone preset, or read content that needs JavaScript to render.",
        "By default it captures the 1280x800 viewport (one image, about 1,300 image tokens). Pass `element` to capture one part of the page, or `full_page: true` for the whole page; tall captures come back as up to `max_slices` slices from the top.",
        "Costs 1 screenshot of the monthly quota per call, failed captures included. Takes about 9-25 seconds.",
        "Limits: the page must be reachable from the public internet (no localhost or private networks: use render_html for local HTML). One shot per call, no login flows or multi-step interaction. Sites with aggressive bot protection may refuse headless browsers.",
      ].join(" "),
      inputSchema: captureInput,
      outputSchema: captureOutputSchema,
      annotations: { title: "Capture screenshot", ...ANNOTATIONS },
    },
    run<z.infer<typeof captureInput>>(
      "capture_screenshot",
      "Capturing page",
      async (input, env) => {
        const { detail, max_slices, return: returnMode, ...captureFields } = input;
        const capture = await env.client.capture(captureFields satisfies CaptureInput, { signal: env.signal });
        return captureReport(
          capture,
          {
            detail,
            maxSlices: max_slices,
            urlOnly: returnMode === "url_only",
            headline: "Screenshot captured",
            sourceLine: `Page: ${capture.originUrl} (${statusText(capture.pageStatus)}).`,
            extraNotes: env.ctx.preview ? [previewNote(env.ctx.preview)] : [],
          },
          env,
        );
      },
      (input) => {
        // Checked first so a URL that can never work does not use up a preview capture.
        const target = validateTargetUrl(input.url);
        if (ctx.preview?.blockedOrigins?.includes(target.origin)) {
          throw previewNotAllowed("Capturing a page hosted on this server");
        }
        if (input.full_page) throw previewNotAllowed("A full-page capture (`full_page: true`)");
        if (input.element !== undefined) throw previewNotAllowed("An `element` capture");
        if (input.scale !== undefined && input.scale > 1) throw previewNotAllowed("A `scale` above 1");
        if (input.click !== undefined) throw previewNotAllowed("Clicking with `click`");
        if (input.custom_js !== undefined) throw previewNotAllowed("Running `custom_js`");
        if (input.custom_css !== undefined) throw previewNotAllowed("Injecting `custom_css`");
        if (input.cookie !== undefined) throw previewNotAllowed("Setting a `cookie`");
        if (input.wait_ms !== undefined && input.wait_ms > PREVIEW_LIMITS.maxWaitMs) {
          throw previewNotAllowed(`A \`wait_ms\` above ${PREVIEW_LIMITS.maxWaitMs}`);
        }
        if ((input.width ?? 0) > PREVIEW_LIMITS.maxWidth || (input.height ?? 0) > PREVIEW_LIMITS.maxHeight) {
          throw previewNotAllowed(`A viewport larger than ${PREVIEW_LIMITS.maxWidth}x${PREVIEW_LIMITS.maxHeight}`);
        }
      },
    ),
  );

  // -- render_html ----------------------------------------------------------

  const renderInput = z.strictObject({
    html: z
      .string()
      .min(1)
      .describe(
        "The HTML document or fragment to render, at most 2 MB. Inline the CSS and JS it needs, or load them from absolute public URLs. Relative asset URLs only resolve if the HTML sets <base href>.",
      ),
    full_page: fields.full_page,
    element: fields.element,
    device: fields.device,
    width: fields.width,
    height: fields.height,
    scale: fields.scale,
    wait_ms: fields.wait_ms,
    detail: fields.detail,
    max_slices: fields.max_slices,
    return: fields.return,
  });

  server.registerTool(
    "render_html",
    {
      title: "Render HTML",
      description: [
        "Render an HTML string in a real browser and return a screenshot you can see. Use it to check a component, email or page you just wrote without deploying it, and to look at local work, since the capture service cannot reach localhost.",
        "The HTML is hosted at an unguessable temporary URL, captured like any page, deleted as soon as the capture returns, and the result has the same shape as capture_screenshot.",
        "Assets must be inlined or use absolute public URLs: relative paths and localhost URLs inside the HTML will not load unless the HTML sets <base href> to a public origin.",
        "The page runs in a sandbox without cookies or localStorage, so code that depends on them may render blank.",
        "Cookie-banner hiding is off for this tool, so the page renders exactly as written.",
        "Costs 1 screenshot of the monthly quota per call. Takes about 9-25 seconds. Do not put secrets in the HTML: the resulting image link is public to anyone who has it.",
      ].join(" "),
      inputSchema: renderInput,
      outputSchema: captureOutputSchema,
      annotations: { title: "Render HTML", ...ANNOTATIONS },
    },
    run<z.infer<typeof renderInput>>("render_html", "Rendering HTML", async (input, env) => {
      const { html, detail, max_slices, return: returnMode, ...viewport } = input;
      const bytes = Buffer.byteLength(html, "utf8");
      if (bytes > HTML_MAX_BYTES) throw htmlTooLargeError(HTML_MAX_BYTES, bytes);
      if (!env.ctx.htmlHost) {
        throw new GetScreenshotError(
          "html_host_unavailable",
          "render_html is not available on this server because it has nowhere to host the HTML. Publish the page at a public URL and use capture_screenshot instead. No quota was used.",
        );
      }
      const { capture, attempts } = await captureHostedHtml(env.ctx.htmlHost, html, viewport, env);
      return captureReport(
        capture,
        {
          detail,
          maxSlices: max_slices,
          urlOnly: returnMode === "url_only",
          headline: "Rendered HTML captured",
          sourceLine: `Source: the HTML you supplied (${nf.format(Math.ceil(bytes / 1024))} KB), served from a temporary URL that has already been deleted (${statusText(capture.pageStatus)}).`,
          extraNotes:
            attempts > 1
              ? [`The capture service could not load the temporary URL on the first attempt, so it was hosted and captured again. This call used ${attempts} screenshots of the quota.`]
              : [],
        },
        env,
      );
    }),
  );

  // -- compare_screenshots --------------------------------------------------

  const sideSchema = (which: string) =>
    z
      .strictObject({
        url: z.string().min(1).max(8192).optional().describe("A public page URL to capture now (uses 1 screenshot of quota)."),
        screenshot_url: z
          .string()
          .min(1)
          .max(2048)
          .optional()
          .describe("The screenshot_url of an earlier GetScreenshot capture (uses no quota). Only GetScreenshot storage URLs are accepted."),
      })
      .describe(`The "${which}" image. Provide exactly one of url or screenshot_url.`);

  const compareInput = z.strictObject({
    before: sideSchema("before"),
    after: sideSchema("after"),
    full_page: fields.full_page.describe("Capture whole pages instead of the viewport. Applies to sides given as url."),
    width: fields.width,
    height: fields.height,
    device: fields.device,
    hide_selectors: fields.hide_selectors.describe(
      "CSS selector(s) to hide in both captures. Use it to remove things that change on every load (ads, carousels, timestamps) so they do not show up as differences.",
    ),
    wait_until: fields.wait_until,
    wait_ms: fields.wait_ms,
    threshold: z
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_DIFF_THRESHOLD)
      .describe("Per-pixel colour tolerance from 0 (any difference counts) to 1 (nothing counts). Default 0.1 ignores anti-aliasing noise."),
  });

  server.registerTool(
    "compare_screenshots",
    {
      title: "Compare screenshots",
      description: [
        "Visual diff of two pages or two existing screenshots. Use it to verify a change did what you intended and nothing else moved: before/after a deploy, staging vs production, or one page at two points in time.",
        "Each side is either `{url}` (captured now) or `{screenshot_url}` (an earlier GetScreenshot result, reused at no cost; it is checked before any capture is spent). To compare a page across a change, capture it first, make the change, then pass the earlier screenshot_url as `before` and the page url as `after`.",
        "Returns the percentage of changed pixels, the bounding box of the changed area, and a diff image: the after image dimmed, changed pixels in magenta, a red rectangle around the changed area. When nothing changed no image is attached.",
        "Costs 1 screenshot of the monthly quota per side given as `url` (0 to 2 per call). Both sides are captured with the same viewport options. Takes about 9-25 seconds when it captures.",
        `Limits: pages must be publicly reachable. At most the top ${nf.format(compareHeight)} px are compared (at up to 1280 px wide); for a lower part of a long page, capture that part of both versions with capture_screenshot and \`element\`, then compare the two screenshot_url values. Animations, ads and rotating content show up as differences; hide them with hide_selectors.`,
      ].join(" "),
      inputSchema: compareInput,
      outputSchema: compareOutputSchema,
      annotations: { title: "Compare screenshots", ...ANNOTATIONS },
    },
    run<z.infer<typeof compareInput>>("compare_screenshots", "Comparing", async (input, env) => {
      type Side = { kind: "url"; value: string } | { kind: "screenshot_url"; value: string };
      const parseSide = (name: "before" | "after"): Side => {
        const side = input[name];
        const hasUrl = side.url !== undefined;
        const hasShot = side.screenshot_url !== undefined;
        if (hasUrl === hasShot) {
          throw new GetScreenshotError(
            "invalid_input",
            `\`${name}\` must contain exactly one of \`url\` (a page to capture) or \`screenshot_url\` (an earlier GetScreenshot result). Nothing was captured and no quota was used.`,
          );
        }
        if (hasShot) {
          // Checked before any capture so a bad URL costs nothing.
          assertResultUrl(side.screenshot_url as string, env.download.allowedOrigins);
          return { kind: "screenshot_url", value: side.screenshot_url as string };
        }
        return { kind: "url", value: side.url as string };
      };
      const sides = { before: parseSide("before"), after: parseSide("after") };

      const shared = {
        full_page: input.full_page,
        width: input.width,
        height: input.height,
        device: input.device,
        hide_selectors: input.hide_selectors,
        wait_until: input.wait_until,
        wait_ms: input.wait_ms,
      };

      // Refuse while it is still free if the image work could not even queue.
      if (env.gate.saturated) {
        const busy = serverBusyError("too many requests are already waiting");
        throw new GetScreenshotError(busy.code, `${busy.message} Nothing was captured and no quota was used.`);
      }

      const names = ["before", "after"] as const;
      type Name = (typeof names)[number];

      // Free checks first: an existing screenshot must be there and be an image
      // before a capture is spent on the other side.
      for (const name of names) {
        const side = sides[name];
        if (side.kind !== "screenshot_url") continue;
        try {
          await probeDimensions(side.value, env.download);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new GetScreenshotError(
            err instanceof GetScreenshotError ? err.code : "download_failed",
            `The \`${name}\` screenshot_url could not be used: ${reason} Nothing was captured and no quota was used.`,
          );
        }
      }

      interface Source {
        name: Name;
        screenshot_url: string;
        origin_url: string | null;
        page_status: number | null;
        /** True when this call spent a capture on it. */
        paid: boolean;
      }
      const resolve = async (name: Name): Promise<Source> => {
        const side = sides[name];
        if (side.kind === "screenshot_url") {
          return { name, screenshot_url: side.value, origin_url: null, page_status: null, paid: false };
        }
        const capture = await env.client.capture({ url: side.value, ...shared }, { signal: env.signal });
        return {
          name,
          screenshot_url: capture.screenshotUrl,
          origin_url: capture.originUrl,
          page_status: capture.pageStatus,
          paid: true,
        };
      };
      const paidNote = (source: Source) =>
        `The \`${source.name}\` capture succeeded and is already paid for: ${source.screenshot_url}. ` +
        `Pass it as \`${source.name}: { "screenshot_url": "..." }\` on the next attempt instead of capturing it again.`;

      const settled = await Promise.allSettled(names.map(resolve));
      const resolved = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      if (resolved.length < 2) {
        const notes: string[] = [];
        let code: GetScreenshotErrorCode = "capture_failed";
        settled.forEach((result, index) => {
          if (result.status !== "rejected") return;
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          if (notes.length === 0 && result.reason instanceof GetScreenshotError) code = result.reason.code;
          notes.push(`The \`${names[index]}\` side failed: ${reason}`);
        });
        for (const source of resolved) if (source.paid) notes.push(paidNote(source));
        throw new GetScreenshotError(code, notes.join("\n"));
      }
      const [before, after] = resolved as [Source, Source];

      // Download, diff and encode inside the image gate; only small results leave it.
      const maxHeight = env.ctx.compareMaxHeight ?? compareMaxHeight();
      const work = await env.gate
        .run(async () => {
          const beforeFile = await downloadResult(before.screenshot_url, env.download);
          const afterFile = await downloadResult(after.screenshot_url, env.download);
          const { diffImage, ...summary } = await diffImages(beforeFile.data, afterFile.data, {
            threshold: input.threshold,
            maxHeight,
          });
          if (summary.changedPixels === 0) return { diff: summary, vision: undefined, focusTop: 0 };
          const focus = focusRows(summary);
          const vision = await sizeForVision(cropRows(diffImage, focus.top, focus.height), {
            detail: "standard",
            maxSlices: DEFAULT_MAX_SLICES,
          });
          return { diff: summary, vision, focusTop: focus.top };
        }, env.signal)
        .catch((err: unknown) => {
          const paid = resolved.filter((source) => source.paid);
          if (paid.length === 0) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          throw new GetScreenshotError(
            err instanceof GetScreenshotError ? err.code : "image_processing_failed",
            [`The comparison could not be completed: ${reason}`, ...paid.map(paidNote)].join("\n"),
          );
        });
      const diff = work.diff;

      const warnings: string[] = [];
      for (const source of [before, after]) {
        const warning = pageStatusWarning(source.page_status, `The \`${source.name}\` page`);
        if (warning) warnings.push(warning);
      }
      if (diff.cropped) {
        warnings.push(
          `Only the top ${diff.compared.height} px (at ${diff.compared.width} px wide) were compared; the images are taller than that. ` +
            "To compare a lower part of a page, capture that part of both versions with capture_screenshot and `element`, then compare the two screenshot_url values.",
        );
      }

      let images: VisionImage[] = [];
      let totalSlices = 0;
      let truncated = false;
      let tokens = 0;
      let shownRows: { top: number; bottom: number } | undefined;
      if (work.vision) {
        const vision = work.vision;
        // Report offsets relative to the whole comparison image, not the crop.
        images = vision.images.map((image) => ({ ...image, y: image.y + work.focusTop }));
        totalSlices = vision.total_slices;
        truncated = vision.truncated;
        tokens = vision.estimated_image_tokens;
        warnings.push(...vision.warnings);
        const last = images[images.length - 1];
        if (last) shownRows = { top: work.focusTop, bottom: last.y + last.height };
        if (truncated && !vision.byte_limited) {
          warnings.push(
            "The changed area is taller than the attached images show. Compare a smaller region (viewport instead of full_page, or hide unrelated changing content with hide_selectors).",
          );
        }
      }

      const structured: CompareOutput = {
        changed_percent: diff.changedPercent,
        changed_pixels: diff.changedPixels,
        total_pixels: diff.totalPixels,
        identical: diff.identical,
        threshold: diff.threshold,
        bounding_box: diff.boundingBox,
        size_changed: diff.sizeChanged,
        compared: diff.compared,
        before: {
          screenshot_url: before.screenshot_url,
          origin_url: before.origin_url,
          page_status: before.page_status,
          ...diff.before,
        },
        after: {
          screenshot_url: after.screenshot_url,
          origin_url: after.origin_url,
          page_status: after.page_status,
          ...diff.after,
        },
        images: sliceMeta(images),
        total_slices: totalSlices,
        truncated,
        estimated_image_tokens: tokens,
        expires_in_days: SCREENSHOT_TTL_DAYS,
        warnings,
      };

      const lines: string[] = [];
      if (diff.identical) {
        lines.push(`No visual difference: the two images are identical at threshold ${diff.threshold}.`);
      } else if (diff.changedPixels === 0) {
        lines.push(`No pixel differs at threshold ${diff.threshold}, but the image sizes are different.`);
      } else {
        lines.push(
          `Changed: ${diff.changedPercent}% of pixels (${nf.format(diff.changedPixels)} of ${nf.format(diff.totalPixels)}), threshold ${diff.threshold}.`,
        );
      }
      if (diff.boundingBox) {
        const box = diff.boundingBox;
        lines.push(
          `Changed area: x=${box.x}, y=${box.y}, ${box.width}x${box.height} px, in the ${diff.compared.width}x${diff.compared.height} comparison image.`,
        );
      }
      lines.push(
        `Sizes: before ${diff.before.width}x${diff.before.height} px, after ${diff.after.width}x${diff.after.height} px` +
          (diff.sizeChanged ? " (the size changed)." : "."),
      );
      if (images.length > 0 && shownRows) {
        lines.push(
          `Attached diff: the after image dimmed, changed pixels in magenta, a red rectangle around the changed area. ` +
            `${images.length} image${images.length === 1 ? "" : "s"} covering rows ${shownRows.top}-${shownRows.bottom}, about ${nf.format(tokens)} image tokens (approximate).`,
        );
      }
      lines.push(`Before: ${before.screenshot_url}`);
      lines.push(`After: ${after.screenshot_url}`);
      lines.push(`Both links are public to anyone who has them and expire ${SCREENSHOT_TTL_DAYS} days after capture.`);
      for (const warning of warnings) lines.push(`Warning: ${warning}`);

      return {
        content: [{ type: "text", text: lines.join("\n") }, ...imageBlocks(images)],
        structuredContent: structured,
      };
    }),
  );

  // -- capture_pdf ----------------------------------------------------------

  const pdfInput = z.strictObject({
    url: fields.url,
    wait_until: fields.wait_until,
    wait_ms: fields.wait_ms,
    hide_selectors: fields.hide_selectors,
    custom_css: z.string().min(1).max(20000).optional().describe("CSS injected before the PDF is made, for example print tweaks."),
  });

  server.registerTool(
    "capture_pdf",
    {
      title: "Capture PDF",
      description: [
        "Save a public web page as an A4 PDF and return a link to the file. Use it when the user wants a document to keep, share or archive. The PDF is not shown to you; to look at a page use capture_screenshot.",
        "Costs 1 screenshot of the monthly quota per call, failed captures included. Takes about 9-25 seconds. The link is public to anyone who has it and expires in 30 days.",
        "Limits: the page must be reachable from the public internet (no localhost or private networks).",
      ].join(" "),
      inputSchema: pdfInput,
      outputSchema: pdfOutputSchema,
      annotations: { title: "Capture PDF", ...ANNOTATIONS },
    },
    run<z.infer<typeof pdfInput>>("capture_pdf", "Creating PDF", async (input, env) => {
      const pdf = await env.client.capturePdf(input, { signal: env.signal });
      const warnings: string[] = [];
      const statusWarning = pageStatusWarning(pdf.pageStatus);
      if (statusWarning) warnings.push(statusWarning);
      const lines = [
        `PDF created: ${pdf.pdfUrl}`,
        `Page: ${pdf.originUrl} (${statusText(pdf.pageStatus)}). A4 format.`,
        `The link is public to anyone who has it and expires in ${SCREENSHOT_TTL_DAYS} days.`,
        ...warnings.map((w) => `Warning: ${w}`),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          pdf_url: pdf.pdfUrl,
          origin_url: pdf.originUrl,
          page_status: pdf.pageStatus,
          captured_at: pdf.capturedAt,
          expires_in_days: SCREENSHOT_TTL_DAYS,
          warnings,
        },
      };
    }),
  );

  // -- get_usage ------------------------------------------------------------

  server.registerTool(
    "get_usage",
    {
      title: "Get usage",
      description:
        "Report how many screenshots the configured API key has used this month, the plan's monthly limit, how many are left and when the quota resets. Use it before a large batch of captures or when a capture fails with a quota error. This check itself costs 1 screenshot of the quota, so do not call it routinely.",
      inputSchema: z.strictObject({}),
      outputSchema: usageOutputSchema,
      annotations: { title: "Get usage", ...ANNOTATIONS },
    },
    run<Record<string, never>>("get_usage", "Checking usage", async (_input, env) => {
      const usage = await env.client.usage({ signal: env.signal });
      const resetsOn = nextReset(usage.quotaRestartDate, usage.period);
      const percent = usage.limit > 0 ? Math.round((usage.used / usage.limit) * 1000) / 10 : 0;
      const lines = [
        `Used ${nf.format(usage.used)} of ${nf.format(usage.limit)} screenshots this ${usage.period.toLowerCase()} (${percent}%). ${nf.format(usage.remaining)} left.`,
      ];
      if (resetsOn) lines.push(`The quota resets on ${resetsOn} (UTC).`);
      lines.push("This check used 1 screenshot of the quota.");
      if (usage.remaining === 0) lines.push(`The quota is used up. Upgrade at ${PRICING_URL}.`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          used: usage.used,
          limit: usage.limit,
          remaining: usage.remaining,
          percent_used: percent,
          period: usage.period,
          quota_restart_date: usage.quotaRestartDate,
          resets_on: resetsOn,
        },
      };
    }),
  );
}

/**
 * The API reports `quotaRestartDate`. When that date is still ahead it is the
 * reset date; when it is today or past (the API has been seen to report the
 * first day of the current month) the next reset is the first day of the next
 * UTC month. Only meaningful for monthly plans.
 */
export function nextReset(quotaRestartDate: string | null, period: string, now: Date = new Date()): string | null {
  if (period.toUpperCase() !== "MONTH") return null;
  const today = now.toISOString().slice(0, 10);
  if (quotaRestartDate && /^\d{4}-\d{2}-\d{2}$/.test(quotaRestartDate) && quotaRestartDate > today) {
    return quotaRestartDate;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}
