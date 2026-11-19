/**
 * A local stand-in for the GetScreenshot REST API and its image storage.
 *
 * It answers exactly as the API contract describes: the success JSON points at
 * a real PNG this server generates and serves, and every row of the error table
 * can be triggered by a magic API key, hostname or selector. No test talks to
 * the real API.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

export const GOOD_KEY = "good-key-0123456789";
export const INVALID_KEY = "invalid-key-0123456789";
export const DISABLED_KEY = "disabled-key-0123456789";
export const EXHAUSTED_KEY = "exhausted-key-0123456789";
export const RATE_LIMITED_KEY = "ratelimited-key-0123456789";
/** Answers 429 "Too Many Requests" twice, then succeeds. */
export const FLAKY_KEY = "flaky-key-0123456789";
export const TRIAL_KEY = "trial-key-0123456789";
/** Known to the gateway, but the usage Lambda cannot find it. */
export const USAGE_UNKNOWN_KEY = "unknown-to-usage-0123456789";

/**
 * Keys the fake gateway accepts. Like the real one, it rejects every other key
 * (500 + x-amzn-errortype: AuthorizerConfigurationException). Tests that need
 * another valid key add it with `fake.allowKey()`.
 */
const DEFAULT_VALID_KEYS: readonly string[] = [GOOD_KEY, FLAKY_KEY, TRIAL_KEY, USAGE_UNKNOWN_KEY];

export const PAGE_LOAD_MESSAGE =
  "Could not load the target page within the time limit. The page may be slow to load, offline, or blocking automated browsers. Try using waituntil=domcontentloaded or reducing timewait for faster results.";

const PRESETS: Record<string, [number, number]> = {
  iphone5: [320, 568],
  iphone678: [375, 667],
  iphone678_plus: [414, 736],
  iphonex: [375, 812],
  iphone12: [390, 844],
  pixel2: [411, 731],
  pixel2_xl: [411, 823],
  ipad: [768, 1024],
  ipadpro: [1024, 1366],
  hvga: [320, 480],
  wvga: [480, 800],
  dvga: [640, 960],
  wxga_v: [768, 1280],
  xga: [1024, 768],
  wxga_s: [1280, 720],
  wxga_l: [1280, 800],
  sxga: [1280, 1024],
  wsxga_plus: [1680, 1050],
};

export const FULL_PAGE_HEIGHT = 6000;
/** The rectangle painted differently on pages whose path contains "/changed". */
export const CHANGED_RECT = { x: 200, y: 300, width: 300, height: 150 };

export interface RecordedRequest {
  method: string;
  path: string;
  /** Query parameters exactly as received (decoded once). */
  params: Record<string, string>;
  rawQuery: string;
  headers: IncomingMessage["headers"];
}

export interface FetchedHtml {
  url: string;
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface FakeUpstream {
  /** Base URL to use as GETSCREENSHOT_API_BASE. */
  url: string;
  origin: string;
  requests: RecordedRequest[];
  /** Requests to /v1/get-screenshot only. */
  captures(): RecordedRequest[];
  /** Requests for stored images or PDFs. */
  downloads(): RecordedRequest[];
  /** What the fake "browser" got when the captured URL was one of our own hosted HTML documents. */
  fetchedHtml: FetchedHtml[];
  /** Artificial delay before every API answer. */
  delayMs: number;
  /** How many of the next hosted-HTML loads miss the document, as when another instance answers. */
  missHtmlLoads: number;
  /** Makes the gateway accept one more key until the next reset(). */
  allowKey(key: string): void;
  reset(): void;
  close(): Promise<void>;
}

function bandColour(index: number): [number, number, number] {
  // Distinct, saturated enough to survive JPEG, and not white.
  return [(index * 53 + 40) % 200, (index * 97 + 80) % 200, (index * 151 + 120) % 200];
}

interface ImageSpec {
  width: number;
  height: number;
  changed: boolean;
  transparent: boolean;
}

const imageCache = new Map<string, Promise<Buffer>>();

/** A page-like picture: 100 px horizontal bands of different colours, so every slice is identifiable. */
export function makePng(spec: ImageSpec): Promise<Buffer> {
  const key = JSON.stringify(spec);
  let cached = imageCache.get(key);
  if (!cached) {
    const { width, height } = spec;
    const channels = spec.transparent ? 4 : 3;
    const data = Buffer.alloc(width * height * channels);
    for (let y = 0; y < height; y++) {
      const [r, g, b] = bandColour(Math.floor(y / 100));
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * channels;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        if (channels === 4) data[o + 3] = x < width / 2 ? 0 : 255;
      }
    }
    if (spec.changed) {
      const rect = CHANGED_RECT;
      for (let y = rect.y; y < Math.min(height, rect.y + rect.height); y++) {
        for (let x = rect.x; x < Math.min(width, rect.x + rect.width); x++) {
          const o = (y * width + x) * channels;
          data[o] = 250;
          data[o + 1] = 250;
          data[o + 2] = 20;
        }
      }
    }
    cached = sharp(data, { raw: { width, height, channels } }).png({ compressionLevel: 1 }).toBuffer();
    imageCache.set(key, cached);
  }
  return cached;
}

const noiseCache = new Map<string, Promise<Buffer>>();

/** Incompressible content: the worst case for inline image size. */
export function makeNoise(width: number, height: number): Promise<Buffer> {
  const key = `${width}x${height}`;
  let cached = noiseCache.get(key);
  if (!cached) {
    const data = randomBytes(width * height * 3);
    cached = sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
    noiseCache.set(key, cached);
  }
  return cached;
}

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

function randomId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 10; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const stored = new Map<string, { data: Buffer; type: string }>();
  const validKeys = new Set<string>(DEFAULT_VALID_KEYS);
  let flakyCalls = 0;
  let origin = "";

  const state: FakeUpstream = {
    url: "",
    origin: "",
    requests: [],
    captures: () => state.requests.filter((r) => r.path === "/v1/get-screenshot"),
    downloads: () => state.requests.filter((r) => r.path.startsWith("/getscreenshot-storage/")),
    fetchedHtml: [],
    delayMs: 0,
    missHtmlLoads: 0,
    allowKey(key: string) {
      validKeys.add(key);
    },
    reset() {
      state.requests.length = 0;
      state.fetchedHtml.length = 0;
      state.delayMs = 0;
      state.missHtmlLoads = 0;
      flakyCalls = 0;
      validKeys.clear();
      for (const key of DEFAULT_VALID_KEYS) validKeys.add(key);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  /** Gateway behaviour shared by both endpoints. Returns true when it answered. */
  function gateway(res: ServerResponse, apikey: string | undefined): boolean {
    if (!apikey) {
      json(res, 401, { message: "Unauthorized" });
      return true;
    }
    if (apikey === DISABLED_KEY) {
      json(res, 403, { message: "Forbidden" });
      return true;
    }
    if (apikey === EXHAUSTED_KEY) {
      json(res, 429, { message: "Limit Exceeded" });
      return true;
    }
    if (apikey === RATE_LIMITED_KEY) {
      json(res, 429, { message: "Too Many Requests" });
      return true;
    }
    if (!validKeys.has(apikey)) {
      // Legacy behaviour: any key the gateway does not know is a 500 with this header.
      json(res, 500, { message: "error" }, { "x-amzn-errortype": "AuthorizerConfigurationException" });
      return true;
    }
    if (apikey === FLAKY_KEY) {
      flakyCalls += 1;
      if (flakyCalls <= 2) {
        json(res, 429, { message: "Too Many Requests" });
        return true;
      }
    }
    return false;
  }

  async function handleCapture(res: ServerResponse, params: Record<string, string>): Promise<void> {
    if (gateway(res, params.apikey)) return;

    let target: URL;
    try {
      target = new URL(params.url ?? "");
      if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("scheme");
    } catch {
      json(res, 400, { status: "denied", message: "Bad posture." });
      return;
    }
    if (target.hostname === "bit.ly") {
      json(res, 403, { status: "denied", message: "Access denied - URL not allowed (shortener or blocked domain)" });
      return;
    }
    if (target.hostname === "slow.example.com") {
      json(res, 500, { status: "failed", message: PAGE_LOAD_MESSAGE });
      return;
    }
    if (target.hostname === "timeout.example.com") {
      json(res, 504, { message: "error" });
      return;
    }
    if (target.hostname === "weird.example.com") {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html><body>Bad Gateway</body></html>");
      return;
    }
    if (
      params.element === "#missing" ||
      params.click === "#missing" ||
      (params.preset !== undefined && !(params.preset in PRESETS)) ||
      target.hostname === "crash.example.com"
    ) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }

    // Our own hosted HTML: behave like the browser and load it. As with the real
    // API, a page that answers 404 is still captured and reported as pageStatus 404.
    let htmlStatus: number | undefined;
    if (target.pathname.startsWith("/h/")) {
      const miss = state.missHtmlLoads > 0;
      if (miss) state.missHtmlLoads -= 1;
      const response = await fetch(miss ? new URL("/h/" + "A".repeat(43), target) : target);
      const body = await response.text();
      state.fetchedHtml.push({
        url: target.href,
        status: response.status,
        body,
        headers: Object.fromEntries(response.headers.entries()),
      });
      htmlStatus = response.status;
    }

    const now = new Date();
    const base = {
      status: "success",
      originUrl: params.url,
      pageStatus: htmlStatus ?? (target.pathname.includes("status404") ? 404 : 200),
      captureDate: `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}`,
      captureHour: now.toISOString().slice(11, 19),
      aiAnalysis: null,
    };

    if (params.pdf === "true") {
      const name = `pdf${randomId()}.pdf`;
      stored.set(name, { data: PDF_BYTES, type: "application/pdf" });
      json(res, 200, { ...base, pdfFile: `${origin}/getscreenshot-storage/${name}` });
      return;
    }

    if (target.hostname === "offlist-image.example.com") {
      json(res, 200, { ...base, screenshotImage: "http://169.254.169.254/latest/meta-data/image.png" });
      return;
    }

    const factor = Number.parseInt(params.devicefactor ?? "", 10) || 1;
    let width = Number.parseInt(params.width ?? "", 10) || 1280;
    let height = Number.parseInt(params.height ?? "", 10) || 800;
    let full = params.fullpage === "true";
    if (params.preset) {
      [width, height] = PRESETS[params.preset] as [number, number];
      full = params.noheight === "true";
    }
    if (full) height = FULL_PAGE_HEIGHT;
    if (params.element) {
      width = 400;
      height = 300;
    }
    if (target.pathname.includes("taller")) height += 160;
    const format = params.format === "jpeg" ? "jpeg" : "png";
    if (target.pathname.includes("noise")) {
      // A page that does not compress: random pixels, stored as a high-quality JPEG.
      const name = `image${randomId()}.jpeg`;
      stored.set(name, { data: await makeNoise(width, height), type: "image/jpeg" });
      json(res, 200, { ...base, screenshotImage: `${origin}/getscreenshot-storage/${name}` });
      return;
    }
    const png = await makePng({
      width: width * factor,
      height: height * factor,
      changed: target.pathname.includes("changed"),
      transparent: params.forcetr === "true",
    });
    const data = format === "jpeg" ? await sharp(png).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer() : png;
    const name = `image${randomId()}.${format}`;
    stored.set(name, { data, type: `image/${format}` });
    json(res, 200, { ...base, screenshotImage: `${origin}/getscreenshot-storage/${name}` });
  }

  function handleUsage(res: ServerResponse, params: Record<string, string>): void {
    if (gateway(res, params.apikey)) return;
    if (!params.email) {
      json(res, 400, { message: "Email parameter is required" });
      return;
    }
    if (params.apikey === USAGE_UNKNOWN_KEY) {
      json(res, 400, { message: "Invalid API key" });
      return;
    }
    json(res, 200, {
      usedQuota: 123,
      remainingQuota: { limit: 6000, offset: 0, period: "MONTH" },
      quotaRestartDate: "2026-12-01",
    });
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const params = Object.fromEntries(url.searchParams.entries());
    state.requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      params,
      rawQuery: url.search.slice(1),
      headers: req.headers,
    });

    const answer = async () => {
      if (url.pathname.startsWith("/getscreenshot-storage/")) {
        const file = stored.get(url.pathname.slice("/getscreenshot-storage/".length));
        if (!file) {
          res.writeHead(404).end("Not found");
          return;
        }
        // Like Cloud Storage, honour a simple "bytes=0-N" range.
        const range = /^bytes=0-(\d+)$/.exec(String(req.headers.range ?? ""));
        if (range) {
          const part = file.data.subarray(0, Number(range[1]) + 1);
          res.writeHead(206, {
            "Content-Type": file.type,
            "Content-Length": part.byteLength,
            "Content-Range": `bytes 0-${part.byteLength - 1}/${file.data.byteLength}`,
          });
          res.end(part);
          return;
        }
        res.writeHead(200, { "Content-Type": file.type, "Content-Length": file.data.byteLength });
        res.end(file.data);
        return;
      }
      if (url.pathname === "/redirect") {
        // Redirects to a file that exists, so only refusing redirects makes the download fail.
        res.writeHead(302, { Location: `${origin}/big` }).end();
        return;
      }
      if (url.pathname === "/big-declared") {
        // 64 KB announced up front.
        const data = Buffer.alloc(64 * 1024, 7);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.byteLength });
        res.end(data);
        return;
      }
      if (url.pathname === "/big") {
        // 64 KB streamed without a Content-Length.
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        for (let i = 0; i < 64; i++) res.write(Buffer.alloc(1024, 7));
        res.end();
        return;
      }
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (req.method !== "GET") {
        json(res, 403, { message: "Missing Authentication Token" });
        return;
      }
      if (url.pathname === "/v1/get-screenshot") return handleCapture(res, params);
      if (url.pathname === "/v1/usage") return handleUsage(res, params);
      json(res, 403, { message: "Missing Authentication Token" });
    };
    answer().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`fake upstream crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.url = origin;
  state.origin = origin;
  return state;
}

/** Colour of the band at row `y` in pictures made by `makePng`. */
export function expectedBandColour(y: number): [number, number, number] {
  return bandColour(Math.floor(y / 100));
}
