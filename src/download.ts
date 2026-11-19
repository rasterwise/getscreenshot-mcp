/**
 * Guarded downloads of capture results.
 *
 * This code also runs on the hosted server, where a caller controls the
 * `screenshot_url` input of compare_screenshots. Fetching an arbitrary URL from
 * there would be SSRF, so every download goes through an origin allow-list,
 * refuses redirects, and is capped in size.
 */
import { DEFAULT_API_BASE, GetScreenshotError, resolveApiBase } from "./api.js";
import { USER_AGENT } from "./version.js";

/** Where the API stores captures. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ["https://storage.googleapis.com"];
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * The default allow-list, plus the API base's own origin when the base has
 * been overridden (tests point the client at a local fake that also serves the
 * images).
 */
export function allowedOriginsFor(apiBase?: string | undefined): string[] {
  const origins = [...DEFAULT_ALLOWED_ORIGINS];
  const base = resolveApiBase(apiBase);
  if (base !== DEFAULT_API_BASE) {
    try {
      const origin = new URL(base).origin;
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      // an unparsable override simply adds nothing
    }
  }
  return origins;
}

/** Path prefix of the bucket the API stores captures in. */
export const RESULT_PATH_PREFIX = "/getscreenshot-storage/";

/**
 * Stricter check for a result URL supplied by the caller (compare_screenshots
 * `screenshot_url`): an allowed origin and the API's own bucket. The storage
 * host serves every public bucket, so the origin alone would let a caller of
 * the hosted server make it download and decode a file of their choosing.
 */
export function assertResultUrl(raw: string, allowedOrigins: readonly string[] = DEFAULT_ALLOWED_ORIGINS): URL {
  const url = assertAllowedUrl(raw, allowedOrigins);
  if (!url.pathname.startsWith(RESULT_PATH_PREFIX) || url.pathname.includes("..")) {
    throw new GetScreenshotError(
      "download_not_allowed",
      `Refusing to fetch ${url.origin}${url.pathname.slice(0, 80)}: only GetScreenshot result URLs are accepted here ` +
        `(https://storage.googleapis.com${RESULT_PATH_PREFIX}...). To use any other page or image, pass its page URL as \`url\` so it is captured through the API.`,
    );
  }
  return url;
}

/** Throws unless `raw` is a URL on one of the allowed origins. Never performs I/O. */
export function assertAllowedUrl(raw: string, allowedOrigins: readonly string[] = DEFAULT_ALLOWED_ORIGINS): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GetScreenshotError(
      "download_not_allowed",
      `Not a valid URL: ${JSON.stringify(raw.slice(0, 120))}. Expected a GetScreenshot result URL such as https://storage.googleapis.com/getscreenshot-storage/image....png.`,
    );
  }
  const allowed =
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    allowedOrigins.includes(url.origin);
  if (!allowed) {
    const hosts = allowedOrigins.map((o) => new URL(o).host).join(", ");
    throw new GetScreenshotError(
      "download_not_allowed",
      `Refusing to fetch ${url.origin}: only GetScreenshot result URLs are accepted here (allowed hosts: ${hosts}). ` +
        "To use any other page or image, pass its page URL as `url` so it is captured through the API.",
    );
  }
  return url;
}

/** Enough of a PNG or JPEG to read its dimensions. */
export const DIMENSION_PROBE_BYTES = 64 * 1024;

export interface DownloadOptions {
  allowedOrigins?: readonly string[] | undefined;
  maxBytes?: number | undefined;
  /**
   * Fetch only the first N bytes (HTTP Range, and the read stops there even if
   * the server ignores the header). The result is a prefix of the file.
   */
  prefixBytes?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface DownloadedFile {
  data: Buffer;
  contentType: string | null;
}

/** Downloads a capture result (image or PDF) from an allowed origin, with a size cap. */
export async function downloadResult(rawUrl: string, options: DownloadOptions = {}): Promise<DownloadedFile> {
  const url = assertAllowedUrl(rawUrl, options.allowedOrigins);
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const tooLarge = () =>
    new GetScreenshotError(
      "image_too_large",
      `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, so it was not downloaded. It is still available at its URL.`,
    );

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        ...(options.prefixBytes ? { Range: `bytes=0-${options.prefixBytes - 1}` } : {}),
      },
      // A redirect could lead off the allow-list.
      redirect: "error",
      signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new GetScreenshotError("download_failed", `Could not download ${url.href}: ${reason}.`, { cause: err });
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const hint =
      response.status === 404 || response.status === 403
        ? " The file may have expired (results are kept for 30 days) or the URL is wrong."
        : "";
    throw new GetScreenshotError("download_failed", `Could not download ${url.href}: HTTP ${response.status}.${hint}`, {
      httpStatus: response.status,
    });
  }

  const prefix = options.prefixBytes;
  const declared = Number(response.headers.get("content-length"));
  if (!prefix && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (prefix && received >= prefix) {
          chunks.push(value.subarray(0, value.byteLength - (received - prefix)));
          await reader.cancel().catch(() => undefined);
          break;
        }
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (err instanceof GetScreenshotError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new GetScreenshotError("download_failed", `Download of ${url.href} was interrupted: ${reason}.`, {
      cause: err,
    });
  }

  return { data: Buffer.concat(chunks), contentType: response.headers.get("content-type") };
}
