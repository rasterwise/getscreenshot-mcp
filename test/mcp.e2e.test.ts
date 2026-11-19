/**
 * End to end: a real MCP Client talks to the server over the SDK's in-memory
 * transport. The server calls the fake API over real HTTP, downloads the PNGs
 * it serves, and returns sized JPEGs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MemoryHtmlStore } from "../src/html-store.js";
import { startHttpServer, type RunningHttpServer } from "../src/http.js";
import { ImageGate } from "../src/limits.js";
import { createServer, type ServerContext } from "../src/server.js";
import { RemoteHtmlHost } from "../src/stdio.js";
import { DETAIL_LIMITS, estimateTokens, type Detail } from "../src/vision.js";
import { VERSION } from "../src/version.js";
import {
  CHANGED_RECT,
  EXHAUSTED_KEY,
  GOOD_KEY,
  INVALID_KEY,
  startFakeUpstream,
  type FakeUpstream,
} from "./helpers/fake-upstream.js";

let fake: FakeUpstream;
/** Plays the hosted service: stores render_html documents and serves them at /h/<id>. */
let hosted: RunningHttpServer;
const open: Array<{ close(): Promise<void> }> = [];

beforeAll(async () => {
  fake = await startFakeUpstream();
  hosted = await startHttpServer({ port: 0, host: "127.0.0.1", apiBase: fake.url, log: () => undefined });
});
afterAll(async () => {
  await hosted.close();
  await fake.close();
});
beforeEach(() => fake.reset());
const hostedDocuments = () => (hosted.store as MemoryHtmlStore).size;
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

async function connect(context: Partial<ServerContext> = {}): Promise<Client> {
  const server = createServer({
    apiKey: GOOD_KEY,
    apiBase: fake.url,
    // The same code path as stdio mode: upload to the hosted service over HTTP.
    htmlHost: new RemoteHtmlHost(GOOD_KEY, hosted.url),
    retryBaseMs: 2,
    ...context,
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open.push(client, server);
  return client;
}

type Result = CallToolResult & { structuredContent?: Record<string, any> };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

function textOf(result: Result): string {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return first?.type === "text" ? first.text : "";
}

function imagesOf(result: Result): Array<{ data: string; mimeType: string }> {
  return result.content.filter((block) => block.type === "image") as Array<{ data: string; mimeType: string }>;
}

/** Every image block must be a real JPEG inside the sizing rules and match its structured entry. */
async function expectValidImages(result: Result, detail: Detail = "standard"): Promise<void> {
  const limits = DETAIL_LIMITS[detail];
  const blocks = imagesOf(result);
  const meta = result.structuredContent?.images as Array<{ index: number; y: number; width: number; height: number; estimated_tokens: number }>;
  expect(blocks.length).toBe(meta.length);
  // Text first, then only images.
  expect(result.content.map((b) => b.type)).toEqual(["text", ...blocks.map(() => "image")]);
  let total = 0;
  for (const [i, block] of blocks.entries()) {
    expect(block.mimeType).toBe("image/jpeg");
    const bytes = Buffer.from(block.data, "base64");
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const decoded = await sharp(bytes).metadata();
    expect(decoded.format).toBe("jpeg");
    const entry = meta[i]!;
    expect([decoded.width, decoded.height]).toEqual([entry.width, entry.height]);
    expect(entry.width).toBeLessThanOrEqual(limits.maxWidth);
    expect(Math.max(entry.width, entry.height)).toBeLessThanOrEqual(limits.maxLongEdge);
    expect(entry.estimated_tokens).toBe(estimateTokens(entry.width, entry.height));
    expect(entry.estimated_tokens).toBeLessThanOrEqual(limits.maxTokens);
    total += entry.estimated_tokens;
  }
  expect(result.structuredContent?.estimated_image_tokens).toBe(total);
}

describe("tool listing", () => {
  let tools: Tool[];
  let client: Client;
  beforeEach(async () => {
    client = await connect();
    tools = (await client.listTools()).tools;
  });

  it("identifies itself and gives instructions", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "getscreenshot", title: "GetScreenshot", version: VERSION });
    const instructions = client.getInstructions() ?? "";
    for (const name of ["capture_screenshot", "render_html", "compare_screenshots", "capture_pdf", "get_usage"]) {
      expect(instructions).toContain(name);
    }
    expect(instructions).toMatch(/localhost/);
  });

  it("exposes exactly the five tools with titles, schemas and annotations", () => {
    expect(tools.map((t) => t.name)).toEqual(["capture_screenshot", "render_html", "compare_screenshots", "capture_pdf", "get_usage"]);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description?.length, tool.name).toBeGreaterThan(80);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      });
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      // Every input field is described for the model.
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect((schema as { description?: string }).description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("declares the documented inputs for capture_screenshot", () => {
    const capture = tools.find((t) => t.name === "capture_screenshot")!;
    expect(Object.keys(capture.inputSchema.properties ?? {}).sort()).toEqual(
      [
        "url", "full_page", "element", "device", "width", "height", "scale", "format", "wait_until", "wait_ms",
        "hide_selectors", "hide_cookie_banners", "hide_chat_widgets", "click", "custom_css", "custom_js", "highlight",
        "cookie", "lang", "transparent_background", "full_page_strategy", "detail", "max_slices", "return",
      ].sort(),
    );
    expect(capture.inputSchema.required).toEqual(["url"]);
    const props = capture.inputSchema.properties as Record<string, any>;
    expect(props.device.enum).toHaveLength(18);
    expect(props.format).toMatchObject({ enum: ["png", "jpeg"], default: "png" });
    expect(props.detail).toMatchObject({ enum: ["standard", "high"], default: "standard" });
    expect(props.max_slices).toMatchObject({ minimum: 1, maximum: 10, default: 4 });
    expect(props.wait_ms).toMatchObject({ minimum: 0, maximum: 20000 });
    expect(props.scale).toMatchObject({ minimum: 1, maximum: 3 });
    expect(props.return).toMatchObject({ enum: ["image_and_url", "url_only"], default: "image_and_url" });
    expect(props.hide_cookie_banners.default).toBe(true);
    const descriptions = tools.map((t) => t.description).join(" ");
    expect(descriptions).toMatch(/localhost/);
    expect(descriptions).toMatch(/quota/);
  });

  it("declares the documented inputs for the other tools", () => {
    const keys = (name: string) => Object.keys(tools.find((t) => t.name === name)!.inputSchema.properties ?? {}).sort();
    expect(keys("render_html")).toEqual(
      ["html", "full_page", "element", "device", "width", "height", "scale", "wait_ms", "detail", "max_slices", "return"].sort(),
    );
    expect(keys("compare_screenshots")).toEqual(
      ["before", "after", "full_page", "width", "height", "device", "hide_selectors", "wait_until", "wait_ms", "threshold"].sort(),
    );
    expect(keys("capture_pdf")).toEqual(["url", "wait_until", "wait_ms", "hide_selectors", "custom_css"].sort());
    expect(keys("get_usage")).toEqual([]);
  });
});

describe("capture_screenshot", () => {
  it("returns text, one JPEG and structured content for a viewport capture", async () => {
    const client = await connect();
    const result = await call(client, "capture_screenshot", { url: "https://example.com" });
    expect(result.isError).toBeFalsy();

    const structured = result.structuredContent!;
    const text = textOf(result);
    expect(text).toContain(structured.screenshot_url);
    expect(text).toMatch(/Page: https:\/\/example\.com \(HTTP 200\)/);
    expect(text).toMatch(/Original image: 1280x800 px \(png\)/);
    expect(text).toMatch(/Attached: 1 JPEG image, 1280x800 px, about 1,334 image tokens \(approximate\)/);
    expect(text).toMatch(/expires in 30 days/);
    expect(text).not.toMatch(/Warning/);

    expect(structured).toMatchObject({
      origin_url: "https://example.com",
      page_status: 200,
      format: "png",
      original: { width: 1280, height: 800 },
      images: [{ index: 0, y: 0, width: 1280, height: 800, estimated_tokens: 1334 }],
      total_slices: 1,
      truncated: false,
      estimated_image_tokens: 1334,
      expires_in_days: 30,
      warnings: [],
    });
    expect(structured.screenshot_url).toMatch(/\/getscreenshot-storage\/image[A-Za-z0-9]{10}\.png$/);
    expect(structured.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    await expectValidImages(result);

    // Schema defaults must not turn into query parameters.
    expect(fake.captures()).toHaveLength(1);
    expect(fake.captures()[0]!.params).toEqual({ apikey: GOOD_KEY, url: "https://example.com" });
  });

  it("validates structuredContent against the declared outputSchema for every tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const validator = new AjvJsonSchemaValidator();
    const results: Record<string, Result> = {
      capture_screenshot: await call(client, "capture_screenshot", { url: "https://example.com", full_page: true }),
      render_html: await call(client, "render_html", { html: "<h1>Hi</h1>" }),
      compare_screenshots: await call(client, "compare_screenshots", {
        before: { url: "https://example.com/" },
        after: { url: "https://example.com/changed" },
      }),
      capture_pdf: await call(client, "capture_pdf", { url: "https://example.com" }),
      get_usage: await call(client, "get_usage"),
    };
    for (const tool of tools) {
      const result = results[tool.name]!;
      expect(result.isError, tool.name).toBeFalsy();
      const check = validator.getValidator(tool.outputSchema as never)(result.structuredContent);
      expect(check.errorMessage, tool.name).toBeUndefined();
      expect(check.valid, tool.name).toBe(true);
    }
  });

  it("slices a full page and reports truncation", async () => {
    const client = await connect();
    const result = await call(client, "capture_screenshot", { url: "https://example.com", full_page: true });
    expect(fake.captures()[0]!.params).toEqual({ apikey: GOOD_KEY, url: "https://example.com", fullpage: "true" });
    expect(imagesOf(result)).toHaveLength(4);
    expect(result.structuredContent).toMatchObject({
      original: { width: 1280, height: 6000 },
      total_slices: 7,
      truncated: true,
      estimated_image_tokens: 4 * 1564,
    });
    expect(result.structuredContent!.images.map((i: { y: number }) => i.y)).toEqual([0, 952, 1904, 2856]);
    const text = textOf(result);
    expect(text).toMatch(/4 of 7 slices/);
    expect(text).toMatch(/Truncated: only the top 3808 px of 6000 px/);
    expect(text).toMatch(/max_slices/);
    await expectValidImages(result);
  });

  it("honours max_slices and detail", async () => {
    const client = await connect();
    const all = await call(client, "capture_screenshot", { url: "https://example.com", full_page: true, max_slices: 10 });
    expect(imagesOf(all)).toHaveLength(7);
    expect(all.structuredContent).toMatchObject({ truncated: false, total_slices: 7 });
    await expectValidImages(all);

    const high = await call(client, "capture_screenshot", {
      url: "https://example.com",
      width: 1920,
      height: 1080,
      scale: 2,
      detail: "high",
    });
    expect(fake.captures()[1]!.params).toMatchObject({ width: "1920", height: "1080", devicefactor: "2" });
    expect(high.structuredContent).toMatchObject({
      original: { width: 3840, height: 2160 },
      images: [{ width: 1920, height: 1080, estimated_tokens: 69 * 39 }],
    });
    await expectValidImages(high, "high");
  });

  it("maps a device preset with full_page to preset + noheight", async () => {
    const client = await connect();
    const result = await call(client, "capture_screenshot", { url: "https://example.com", device: "iphone12", full_page: true, max_slices: 2 });
    expect(fake.captures()[0]!.params).toEqual({ apikey: GOOD_KEY, url: "https://example.com", preset: "iphone12", noheight: "true" });
    expect(result.structuredContent).toMatchObject({ original: { width: 390, height: 6000 }, truncated: true });
    expect(imagesOf(result)).toHaveLength(2);
    await expectValidImages(result);
  });

  it("passes every option through to the API", async () => {
    const client = await connect();
    await call(client, "capture_screenshot", {
      url: "https://example.com/a?b=c",
      element: "#hero",
      format: "jpeg",
      wait_until: "networkidle0",
      wait_ms: 0,
      hide_selectors: ".ad",
      hide_cookie_banners: false,
      hide_chat_widgets: true,
      click: "#open",
      custom_css: "a{color:red}",
      custom_js: "window.x=1",
      highlight: "price",
      cookie: { name: "locale", value: "de" },
      lang: "de-DE",
      transparent_background: true,
      full_page_strategy: 3,
    });
    expect(fake.captures()[0]!.params).toEqual({
      apikey: GOOD_KEY,
      url: "https://example.com/a?b=c",
      element: "#hero",
      format: "jpeg",
      waituntil: "networkidle0",
      timewait: "1",
      hideelement: ".ad",
      hidecookie: "false",
      hidemsg: "true",
      click: "#open",
      customcss: "a{color:red}",
      customjs: "window.x=1",
      highlight: "price",
      cookie: "locale,de",
      lang: "de-DE",
      forcetr: "true",
      strategy: "3",
    });
  });

  it("url_only attaches no image", async () => {
    const client = await connect();
    const result = await call(client, "capture_screenshot", { url: "https://example.com", full_page: true, return: "url_only" });
    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toMatch(/No image attached/);
    // images is empty by request: total_slices says what a normal call would give, truncated stays false.
    expect(result.structuredContent).toMatchObject({
      original: { width: 1280, height: 6000 },
      images: [],
      total_slices: 7,
      truncated: false,
      estimated_image_tokens: 0,
      warnings: [],
    });
    // The dimensions come from a ranged read of the file's first 64 KB, not a full download.
    expect(fake.downloads()).toHaveLength(1);
    expect(fake.downloads()[0]!.headers.range).toBe("bytes=0-65535");
  });

  it("documents the url_only meaning of truncated and total_slices in the output schema", async () => {
    const client = await connect();
    const capture = (await client.listTools()).tools.find((t) => t.name === "capture_screenshot")!;
    const props = capture.outputSchema!.properties as Record<string, { description: string }>;
    expect(props.truncated!.description).toMatch(/Always false with return: "url_only"/);
    expect(props.total_slices!.description).toMatch(/whether or not they are attached/);
  });

  it("drops trailing slices of a page that does not compress, and says why", async () => {
    const client = await connect();
    const result = await call(client, "capture_screenshot", { url: "https://example.com/noise", width: 1280, height: 3808 });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent!;
    const bytes = imagesOf(result).reduce((sum, image) => sum + Buffer.from(image.data, "base64").byteLength, 0);
    expect(bytes).toBeLessThanOrEqual(1_500_000);
    expect(structured.total_slices).toBe(4);
    expect(structured.images.length).toBeLessThan(4);
    expect(structured.images.length).toBeGreaterThanOrEqual(1);
    expect(structured.truncated).toBe(true);
    expect(structured.warnings.join(" ")).toMatch(/left out to keep the inline images under 1\.5 MB/);
    expect(textOf(result)).toMatch(/because more would exceed the inline size limit/);
    expect(textOf(result)).not.toMatch(/raise max_slices/);
    await expectValidImages(result);
  });

  it("when the image gate is busy the capture still returns its URL, with a warning", async () => {
    const gate = new ImageGate({ concurrency: 1, maxQueue: 0 });
    let release!: () => void;
    const held = gate.run(() => new Promise<void>((resolve) => (release = resolve)));
    const client = await connect({ imageGate: gate });
    const result = await call(client, "capture_screenshot", { url: "https://example.com" });
    release();
    await held;
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent!.screenshot_url).toMatch(/\/getscreenshot-storage\/image/);
    expect(result.structuredContent).toMatchObject({ original: null, images: [] });
    expect(result.structuredContent!.warnings[0]).toMatch(/stored at the URL, but the image could not be attached inline/);
    expect(result.structuredContent!.warnings[0]).toMatch(/server is busy/);
    expect(textOf(result)).toContain(result.structuredContent!.screenshot_url);
    expect(fake.captures()).toHaveLength(1);
    expect(fake.downloads()).toHaveLength(0);
  });

  it("refuses a call when the caller's rate limit says no, before anything is spent", async () => {
    let calls = 0;
    const client = await connect({
      rateLimit: () => {
        calls += 1;
        return calls <= 2 ? { ok: true } : { ok: false, retryAfterSeconds: 17 };
      },
    });
    expect((await call(client, "capture_screenshot", { url: "https://example.com" })).isError).toBeFalsy();
    expect((await call(client, "get_usage")).isError).toBeFalsy();
    for (const [name, args] of [["capture_screenshot", { url: "https://example.com" }], ["render_html", { html: "<p>x</p>" }], ["get_usage", {}]] as const) {
      const refused = await call(client, name, args);
      expect(refused.isError, name).toBe(true);
      expect(textOf(refused)).toMatch(/Too many tool calls in the last minute/);
      expect(textOf(refused)).toMatch(/Wait about 17 seconds/);
      expect(textOf(refused)).toMatch(/no quota was used/);
    }
    expect(fake.captures()).toHaveLength(1);
    expect(hostedDocuments()).toBe(0);
  });

  it("warns when the page answered with an error status", async () => {
    const client = await connect();
    const result = await call(client, "capture_screenshot", { url: "https://example.com/status404" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.page_status).toBe(404);
    expect(result.structuredContent!.warnings[0]).toMatch(/HTTP 404/);
    expect(textOf(result)).toMatch(/Warning: The page answered with HTTP 404/);
  });

  it("keeps the URL when the image cannot be inlined (host off the allow-list)", async () => {
    const client = await connect();
    const result = await call(client, "capture_screenshot", { url: "https://offlist-image.example.com" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      screenshot_url: "http://169.254.169.254/latest/meta-data/image.png",
      original: null,
      images: [],
    });
    expect(result.structuredContent!.warnings[0]).toMatch(/could not be attached inline/);
    expect(result.structuredContent!.warnings[0]).toMatch(/Refusing to fetch/);
    expect(fake.downloads()).toHaveLength(0);
  });

  it("returns API failures as isError results with advice, not protocol errors", async () => {
    const client = await connect();
    const missing = await call(client, "capture_screenshot", { url: "https://example.com", element: "#missing" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toBeUndefined();
    expect(textOf(missing)).toMatch(/`element` selector "#missing" probably matched nothing/);

    const slow = await call(client, "capture_screenshot", { url: "https://slow.example.com" });
    expect(slow.isError).toBe(true);
    expect(textOf(slow)).toMatch(/wait_until: "domcontentloaded"/);
    // 5xx is never retried: one request per call.
    expect(fake.captures()).toHaveLength(2);
  });

  it("maps key and quota problems to their messages", async () => {
    const invalid = await call(await connect({ apiKey: INVALID_KEY }), "capture_screenshot", { url: "https://example.com" });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toMatch(/does not recognise this API key/);
    expect(textOf(invalid)).not.toContain(INVALID_KEY);

    const exhausted = await call(await connect({ apiKey: EXHAUSTED_KEY }), "capture_screenshot", { url: "https://example.com" });
    expect(exhausted.isError).toBe(true);
    expect(textOf(exhausted)).toMatch(/https:\/\/www\.getscreenshotapi\.com\/#pricing/);
  });

  it("refuses localhost before calling the API", async () => {
    const client = await connect();
    const result = await call(client, "capture_screenshot", { url: "http://localhost:3000/dashboard" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/render_html/);
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects unknown or invalid arguments with a readable validation error", async () => {
    const client = await connect();
    const unknown = await call(client, "capture_screenshot", { url: "https://example.com", fullPage: true });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/fullPage/);
    const badDevice = await call(client, "capture_screenshot", { url: "https://example.com", device: "iphone99" });
    expect(badDevice.isError).toBe(true);
    const badSlices = await call(client, "capture_screenshot", { url: "https://example.com", max_slices: 11 });
    expect(badSlices.isError).toBe(true);
    const badCookie = await call(client, "capture_screenshot", { url: "https://example.com", cookie: { name: "a,b", value: "x" } });
    expect(badCookie.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it("sends progress notifications while the API works", async () => {
    const client = await connect({ progressIntervalMs: 40 });
    fake.delayMs = 320;
    const updates: Array<{ progress: number; message?: string | undefined }> = [];
    const result = (await client.callTool({ name: "capture_screenshot", arguments: { url: "https://example.com" } }, undefined, {
      onprogress: (progress) => updates.push(progress),
    })) as Result;
    expect(result.isError).toBeFalsy();
    expect(updates.length).toBeGreaterThanOrEqual(3);
    const values = updates.map((u) => u.progress);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
    expect(updates[0]!.message).toMatch(/Capturing page: \d+s elapsed/);
  });
});

describe("render_html", () => {
  it("hosts the HTML, captures it through the API and returns an image", async () => {
    const client = await connect();
    const html = '<!doctype html><html><body style="margin:0"><h1 id="t">Hello café</h1><script>document.title="x"</script></body></html>';
    const result = await call(client, "render_html", { html, width: 800, height: 600, wait_ms: 250 });
    expect(result.isError).toBeFalsy();

    const params = fake.captures()[0]!.params;
    expect(Object.keys(params).sort()).toEqual(["apikey", "height", "hidecookie", "timewait", "url", "width"]);
    expect(params).toMatchObject({ apikey: GOOD_KEY, width: "800", height: "600", timewait: "250", hidecookie: "false" });
    expect(params.url).toMatch(new RegExp(`^${hosted.url}/h/[A-Za-z0-9_-]{43}$`));

    // The "browser" got exactly the HTML that was passed in, sandboxed.
    expect(fake.fetchedHtml).toHaveLength(1);
    expect(fake.fetchedHtml[0]!.status).toBe(200);
    expect(fake.fetchedHtml[0]!.body).toBe(html);
    expect(fake.fetchedHtml[0]!.headers["content-security-policy"]).toBe("sandbox allow-scripts");
    expect(fake.fetchedHtml[0]!.headers["content-type"]).toBe("text/html; charset=utf-8");

    expect(textOf(result)).toMatch(/Rendered HTML captured: http/);
    expect(textOf(result)).toMatch(/temporary URL that has already been deleted/);
    // The document is gone the moment the call returns: its URL no longer serves anything.
    expect(hostedDocuments()).toBe(0);
    expect((await fetch(params.url!)).status).toBe(404);
    expect(result.structuredContent).toMatchObject({ original: { width: 800, height: 600 }, page_status: 200, total_slices: 1 });
    await expectValidImages(result);
  });

  it("hosts and captures again when the first load of the temporary URL misses the document", async () => {
    // Seen on the live service: Cloud Run replaced an instance mid-call, the browser asked the new
    // instance for the document, got 404, and the tool returned a screenshot of that 404 as a success.
    fake.missHtmlLoads = 1;
    const client = await connect();
    const result = await call(client, "render_html", { html: "<h1>Hi</h1>" });
    expect(result.isError).toBeFalsy();
    expect(fake.captures()).toHaveLength(2);
    expect(fake.fetchedHtml.map((f) => f.status)).toEqual([404, 200]);
    expect(fake.captures()[1]!.params.url).not.toBe(fake.captures()[0]!.params.url);
    expect(result.structuredContent).toMatchObject({ page_status: 200 });
    expect(textOf(result)).toMatch(/This call used 2 screenshots of the quota/);
    expect(hostedDocuments()).toBe(0);
    await expectValidImages(result);
  });

  it("fails with an explanation, not a picture of a 404, when the document never loads", async () => {
    fake.missHtmlLoads = 5;
    const client = await connect();
    const result = await call(client, "render_html", { html: "<h1>Hi</h1>" });
    expect(result.isError).toBe(true);
    expect(fake.captures()).toHaveLength(2);
    const text = textOf(result);
    expect(text).toMatch(/temporary URL answered HTTP 404 on 2 attempts/);
    expect(text).toMatch(/2 screenshots of the quota were used/);
    expect(text).toMatch(/capture_screenshot/);
    expect(imagesOf(result)).toHaveLength(0);
    expect(hostedDocuments()).toBe(0);
  });

  it("passes viewport options with the same mapping as capture_screenshot", async () => {
    const client = await connect();
    await call(client, "render_html", { html: "<p>x</p>", device: "ipad", full_page: true, element: "p", scale: 2, return: "url_only" });
    const params = fake.captures()[0]!.params;
    expect(Object.keys(params).sort()).toEqual(["apikey", "devicefactor", "element", "hidecookie", "noheight", "preset", "url"]);
    expect(params).toMatchObject({ preset: "ipad", noheight: "true", element: "p", devicefactor: "2" });
  });

  it("rejects HTML over 2 MB without uploading or capturing", async () => {
    const client = await connect();
    const result = await call(client, "render_html", { html: "x".repeat(2 * 1024 * 1024 + 1) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/limit is 2\.00 MB/);
    expect(textOf(result)).toMatch(/no quota was used/);
    expect(fake.requests).toHaveLength(0);
  });

  it("explains a failed upload in stdio mode and spends no quota", async () => {
    const client = await connect({ htmlHost: new RemoteHtmlHost(GOOD_KEY, "http://127.0.0.1:9") });
    const result = await call(client, "render_html", { html: "<p>x</p>" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/could not upload the HTML to 127\.0\.0\.1:9/);
    expect(text).toMatch(/no quota was used/);
    expect(text).not.toContain(GOOD_KEY);
    expect(fake.requests).toHaveLength(0);
  });

  it("deletes the hosted document when the capture fails too", async () => {
    // An unrecognised key: the upload is accepted (it cannot be verified), the API then rejects the capture.
    const client = await connect({ apiKey: INVALID_KEY, htmlHost: new RemoteHtmlHost(INVALID_KEY, hosted.url) });
    for (let i = 0; i < 8; i++) {
      const result = await call(client, "render_html", { html: `<p>${i}</p>` });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/does not recognise this API key/);
      expect(hostedDocuments()).toBe(0);
    }
    // Eight failed calls left nothing behind, so the per-caller cap of 5 was never reached.
    expect(fake.captures()).toHaveLength(8);
  });

  it("tells the model about the sandbox in the tool description", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "render_html")!;
    expect(tool.description).toMatch(/runs in a sandbox without cookies or localStorage, so code that depends on them may render blank/);
    expect(tool.description).toMatch(/deleted as soon as the capture returns/);
  });

  it("says so when the server has no HTML host", async () => {
    const client = await connect({ htmlHost: undefined });
    const result = await call(client, "render_html", { html: "<p>x</p>" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not available on this server/);
  });
});

describe("compare_screenshots", () => {
  it("captures both pages and reports the changed area with a diff image", async () => {
    const client = await connect();
    const result = await call(client, "compare_screenshots", {
      before: { url: "https://example.com/" },
      after: { url: "https://example.com/changed" },
      hide_selectors: ".ad",
      wait_until: "load",
    });
    expect(result.isError).toBeFalsy();
    expect(fake.captures()).toHaveLength(2);
    for (const request of fake.captures()) {
      expect(Object.keys(request.params).sort()).toEqual(["apikey", "hideelement", "url", "waituntil"]);
    }

    const area = CHANGED_RECT.width * CHANGED_RECT.height;
    const structured = result.structuredContent!;
    expect(structured).toMatchObject({
      changed_pixels: area,
      total_pixels: 1280 * 800,
      identical: false,
      threshold: 0.1,
      bounding_box: CHANGED_RECT,
      size_changed: false,
      compared: { width: 1280, height: 800 },
      before: { origin_url: "https://example.com/", page_status: 200, width: 1280, height: 800 },
      after: { origin_url: "https://example.com/changed", page_status: 200, width: 1280, height: 800 },
      truncated: false,
      expires_in_days: 30,
    });
    expect(structured.changed_percent).toBeCloseTo((area / (1280 * 800)) * 100, 2);
    expect(structured.before.screenshot_url).not.toBe(structured.after.screenshot_url);

    // The diff image is cropped to the changed rows plus a margin.
    expect(imagesOf(result)).toHaveLength(1);
    expect(structured.images[0]).toMatchObject({ y: CHANGED_RECT.y - 120, width: 1280, height: CHANGED_RECT.height + 240 });
    await expectValidImages(result);

    const text = textOf(result);
    expect(text).toMatch(/Changed: 4\.395% of pixels \(45,000 of 1,024,000\)/);
    expect(text).toMatch(/Changed area: x=200, y=300, 300x150 px/);
    expect(text).toContain(`Before: ${structured.before.screenshot_url}`);
    expect(text).toContain(`After: ${structured.after.screenshot_url}`);
  });

  it("reuses earlier screenshots without spending quota, and attaches nothing when identical", async () => {
    const client = await connect();
    const first = await call(client, "capture_screenshot", { url: "https://example.com", return: "url_only" });
    const url = first.structuredContent!.screenshot_url as string;
    fake.reset();

    const result = await call(client, "compare_screenshots", { before: { screenshot_url: url }, after: { screenshot_url: url } });
    expect(result.isError).toBeFalsy();
    expect(fake.captures()).toHaveLength(0);
    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toMatch(/No visual difference/);
    expect(result.structuredContent).toMatchObject({
      identical: true,
      changed_pixels: 0,
      changed_percent: 0,
      bounding_box: null,
      images: [],
      before: { screenshot_url: url, origin_url: null, page_status: null },
    });
  });

  it("mixes an earlier screenshot with a fresh capture and notices a taller page", async () => {
    const client = await connect();
    const first = await call(client, "capture_screenshot", { url: "https://example.com", return: "url_only" });
    fake.reset();
    const result = await call(client, "compare_screenshots", {
      before: { screenshot_url: first.structuredContent!.screenshot_url },
      after: { url: "https://example.com/taller" },
    });
    expect(fake.captures()).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      size_changed: true,
      identical: false,
      compared: { width: 1280, height: 960 },
      bounding_box: { x: 0, y: 800, width: 1280, height: 160 },
    });
    expect(textOf(result)).toMatch(/the size changed/);
    await expectValidImages(result);
  });

  it("refuses screenshot_url values off the allow-list before doing anything", async () => {
    const client = await connect();
    for (const bad of [
      "http://169.254.169.254/latest/meta-data/",
      "https://example.com/image.png",
      `${hosted.url}/healthz`,
      "file:///etc/passwd",
      // Right host, but not the API's bucket: any public bucket lives on this host.
      "https://storage.googleapis.com/someone-elses-bucket/huge.png",
      `${fake.url}/big`,
    ]) {
      const result = await call(client, "compare_screenshots", { before: { url: "https://example.com" }, after: { screenshot_url: bad } });
      expect(result.isError, bad).toBe(true);
      expect(textOf(result)).toMatch(/only GetScreenshot result URLs are accepted|Not a valid URL/);
    }
    // Not even the valid `before` side was captured.
    expect(fake.requests).toHaveLength(0);
  });

  it("checks a screenshot_url side first, so a dead link costs no capture", async () => {
    const client = await connect();
    const dead = `${fake.url}/getscreenshot-storage/imageEXPIRED000.png`;
    for (const args of [
      { before: { url: "https://example.com" }, after: { screenshot_url: dead } },
      { before: { screenshot_url: dead }, after: { url: "https://example.com" } },
    ]) {
      const result = await call(client, "compare_screenshots", args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/screenshot_url could not be used/);
      expect(textOf(result)).toMatch(/HTTP 404/);
      expect(textOf(result)).toMatch(/Nothing was captured and no quota was used/);
    }
    // The `url` side was never captured.
    expect(fake.captures()).toHaveLength(0);
  });

  it("checks that a screenshot_url is an image before capturing the other side", async () => {
    const client = await connect();
    const pdf = await call(client, "capture_pdf", { url: "https://example.com" });
    fake.reset();
    const result = await call(client, "compare_screenshots", {
      before: { screenshot_url: pdf.structuredContent!.pdf_url },
      after: { url: "https://example.com" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/`before` screenshot_url could not be used/);
    expect(fake.captures()).toHaveLength(0);
  });

  it("compares at most the top 2400 px and says how to compare the rest", async () => {
    const client = await connect();
    const result = await call(client, "compare_screenshots", {
      before: { url: "https://example.com/" },
      after: { url: "https://example.com/changed" },
      full_page: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      compared: { width: 1280, height: 2400 },
      total_pixels: 1280 * 2400,
      before: { height: 6000 },
      after: { height: 6000 },
      bounding_box: CHANGED_RECT,
    });
    expect(result.structuredContent!.warnings.join(" ")).toMatch(/Only the top 2400 px \(at 1280 px wide\) were compared/);
    expect(result.structuredContent!.warnings.join(" ")).toMatch(/`element`/);
    const tool = (await client.listTools()).tools.find((t) => t.name === "compare_screenshots")!;
    expect(tool.description).toMatch(/At most the top 2,400 px are compared/);
    expect(tool.description).toMatch(/checked before any capture is spent/);
  });

  it("refuses up front, at no cost, when the image gate is saturated", async () => {
    const gate = new ImageGate({ concurrency: 1, maxQueue: 0 });
    let release!: () => void;
    const held = gate.run(() => new Promise<void>((resolve) => (release = resolve)));
    const client = await connect({ imageGate: gate });
    const result = await call(client, "compare_screenshots", { before: { url: "https://example.com" }, after: { url: "https://example.com/changed" } });
    release();
    await held;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/server is busy/);
    expect(textOf(result)).toMatch(/Nothing was captured and no quota was used/);
    expect(fake.requests).toHaveLength(0);
  });

  it("if the gate times out after the captures, the paid screenshots are handed back", async () => {
    // One slot, taken; room in the queue, so the call starts, captures, then waits too long for the slot.
    const gate = new ImageGate({ concurrency: 1, maxQueue: 2, maxWaitMs: 60 });
    let release!: () => void;
    const held = gate.run(() => new Promise<void>((resolve) => (release = resolve)));
    const client = await connect({ imageGate: gate });
    const result = await call(client, "compare_screenshots", { before: { url: "https://example.com" }, after: { url: "https://example.com/changed" } });
    release();
    await held;
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/The comparison could not be completed: The server is busy/);
    expect(text).toMatch(/The `before` capture succeeded and is already paid for: http\S+\/getscreenshot-storage\/image/);
    expect(text).toMatch(/The `after` capture succeeded and is already paid for: http\S+\/getscreenshot-storage\/image/);
    expect(fake.captures()).toHaveLength(2);
    expect(fake.downloads()).toHaveLength(0);

    // The handed-back URLs work as screenshot_url inputs, at no further cost.
    const urls = [...text.matchAll(/already paid for: (\S+?)\. Pass/g)].map((m) => m[1]);
    fake.reset();
    const retry = await call(client, "compare_screenshots", { before: { screenshot_url: urls[0] }, after: { screenshot_url: urls[1] } });
    expect(retry.isError).toBeFalsy();
    expect(retry.structuredContent!.bounding_box).toEqual(CHANGED_RECT);
    expect(fake.captures()).toHaveLength(0);
  });

  it("runs image work through the gate one job at a time when concurrency is 1", async () => {
    const gate = new ImageGate({ concurrency: 1, maxQueue: 50, maxWaitMs: 20_000 });
    const client = await connect({ imageGate: gate });
    const first = await call(client, "capture_screenshot", { url: "https://example.com", return: "url_only" });
    const changed = await call(client, "capture_screenshot", { url: "https://example.com/changed", return: "url_only" });
    const args = {
      before: { screenshot_url: first.structuredContent!.screenshot_url },
      after: { screenshot_url: changed.structuredContent!.screenshot_url },
    };
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, gate.running)), 1);
    const results = await Promise.all(Array.from({ length: 12 }, () => call(client, "compare_screenshots", args)));
    clearInterval(watch);
    expect(results.every((r) => !r.isError && r.structuredContent!.changed_pixels === 45000)).toBe(true);
    expect(peak).toBe(1);
    expect(gate.running).toBe(0);
  });

  it("requires exactly one of url / screenshot_url per side", async () => {
    const client = await connect();
    const both = await call(client, "compare_screenshots", {
      before: { url: "https://example.com", screenshot_url: "https://storage.googleapis.com/getscreenshot-storage/imageAAAAAAAAAA.png" },
      after: { url: "https://example.com" },
    });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toMatch(/`before` must contain exactly one/);
    const neither = await call(client, "compare_screenshots", { before: { url: "https://example.com" }, after: {} });
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toMatch(/`after` must contain exactly one/);
    expect(fake.requests).toHaveLength(0);
  });

  it("when one side fails, hands back the side that was already paid for", async () => {
    const client = await connect();
    const result = await call(client, "compare_screenshots", {
      before: { url: "https://example.com" },
      after: { url: "https://slow.example.com" },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/The `after` side failed/);
    expect(text).toMatch(/The `before` capture succeeded and is already paid for: http\S+\/getscreenshot-storage\/image/);
    expect(text).toMatch(/screenshot_url/);
  });
});

describe("capture_pdf and get_usage", () => {
  it("returns a pdf_url and no image", async () => {
    const client = await connect();
    const result = await call(client, "capture_pdf", { url: "https://example.com/report", wait_until: "load", custom_css: "nav{display:none}" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(fake.captures()[0]!.params).toEqual({
      apikey: GOOD_KEY,
      url: "https://example.com/report",
      pdf: "true",
      waituntil: "load",
      customcss: "nav{display:none}",
    });
    expect(result.structuredContent).toMatchObject({ origin_url: "https://example.com/report", page_status: 200, expires_in_days: 30, warnings: [] });
    expect(result.structuredContent!.pdf_url).toMatch(/\/getscreenshot-storage\/pdf[A-Za-z0-9]{10}\.pdf$/);
    expect(textOf(result)).toContain(result.structuredContent!.pdf_url);
    expect(textOf(result)).toMatch(/30 days/);
  });

  it("reports usage with the remaining count derived from limit - used", async () => {
    const client = await connect();
    const result = await call(client, "get_usage");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      used: 123,
      limit: 6000,
      remaining: 5877,
      percent_used: 2.1,
      period: "MONTH",
      quota_restart_date: "2026-12-01",
    });
    expect(result.structuredContent!.resets_on).toMatch(/^\d{4}-\d{2}-01$/);
    expect(textOf(result)).toMatch(/Used 123 of 6,000 screenshots this month \(2\.1%\)\. 5,877 left\./);
    expect(textOf(result)).toMatch(/used 1 screenshot of the quota/);
  });
});

describe("without an API key", () => {
  it("every tool explains how to get and set a key, and nothing is called", async () => {
    const client = await connect({ apiKey: undefined, htmlHost: undefined });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["capture_screenshot", { url: "https://example.com" }],
      ["render_html", { html: "<p>x</p>" }],
      ["compare_screenshots", { before: { url: "https://a.example" }, after: { url: "https://b.example" } }],
      ["capture_pdf", { url: "https://example.com" }],
      ["get_usage", {}],
    ];
    for (const [name, args] of calls) {
      const result = await call(client, name, args);
      expect(result.isError, name).toBe(true);
      const text = textOf(result);
      expect(text, name).toMatch(/No GetScreenshot API key is configured/);
      expect(text, name).toMatch(/https:\/\/www\.getscreenshotapi\.com\/#pricing/);
      expect(text, name).toMatch(/from \$5\/month/);
      expect(text, name).toMatch(/FREE5/);
      expect(text, name).toMatch(/GETSCREENSHOT_API_KEY/);
      expect(text, name).toMatch(/Authorization: Bearer/);
      expect(text, name).not.toMatch(/free tier|free plan|free trial|try free|no credit card/i);
    }
    expect(fake.requests).toHaveLength(0);
    // Tools are still listed, so the client can show them and the model can ask the user for a key.
    expect((await client.listTools()).tools).toHaveLength(5);
  });

  it("treats a blank key as no key", async () => {
    const client = await connect({ apiKey: "   " });
    const result = await call(client, "get_usage");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No GetScreenshot API key is configured/);
  });
});
