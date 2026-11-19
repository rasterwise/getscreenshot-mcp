/**
 * Vision sizing pipeline: turn a full-resolution capture into JPEG images that
 * fit a vision model's input budget.
 *
 * The slice math (`estimateTokens`, `maxSliceHeight`, `planSlices`) is pure and
 * has no sharp dependency in its logic, so it is unit-tested with tables.
 */
import sharp, { type Sharp } from "sharp";
import { GetScreenshotError } from "./api.js";
import { DIMENSION_PROBE_BYTES, downloadResult, type DownloadOptions } from "./download.js";

export {
  allowedOriginsFor,
  assertAllowedUrl,
  assertResultUrl,
  downloadResult,
  DEFAULT_ALLOWED_ORIGINS,
  MAX_DOWNLOAD_BYTES,
  RESULT_PATH_PREFIX,
} from "./download.js";

export const DETAIL_LEVELS = ["standard", "high"] as const;
export type Detail = (typeof DETAIL_LEVELS)[number];

export interface DetailLimits {
  /** Images wider than this are downscaled to it. */
  maxWidth: number;
  /** Neither side of an inline image may exceed this. */
  maxLongEdge: number;
  /** Upper bound on the estimated tokens of one inline image. */
  maxTokens: number;
}

export const DETAIL_LIMITS: Record<Detail, DetailLimits> = {
  standard: { maxWidth: 1280, maxLongEdge: 1568, maxTokens: 1568 },
  high: { maxWidth: 1920, maxLongEdge: 2576, maxTokens: 4784 },
};

export const TOKEN_PATCH_PX = 28;
export const JPEG_QUALITY = 80;
export const DEFAULT_MAX_SLICES = 4;
export const MAX_SLICES_LIMIT = 10;
/** A last slice shorter than this is balanced with the one before it, to avoid slivers. */
export const MIN_TAIL_SLICE_PX = 200;

/** Approximate vision-token cost of one image (Claude-style 28 px patches). */
export function estimateTokens(width: number, height: number): number {
  return Math.ceil(width / TOKEN_PATCH_PX) * Math.ceil(height / TOKEN_PATCH_PX);
}

/** Tallest slice of the given width that stays within the long-edge and token limits. */
export function maxSliceHeight(width: number, limits: DetailLimits): number {
  const columns = Math.max(1, Math.ceil(width / TOKEN_PATCH_PX));
  const rows = Math.max(1, Math.floor(limits.maxTokens / columns));
  return Math.min(limits.maxLongEdge, rows * TOKEN_PATCH_PX);
}

export interface SliceRect {
  /** 0-based position of the slice, top to bottom. */
  index: number;
  /** Top offset of the slice within the downscaled image, in inline-image pixels. */
  y: number;
  width: number;
  height: number;
  estimated_tokens: number;
}

export interface SlicePlan {
  /** Inline pixels per original pixel (<= 1). */
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
  maxSliceHeight: number;
  /** Every slice needed to cover the whole image. */
  slices: SliceRect[];
  /** The first `maxSlices` slices: what is actually returned inline. */
  shown: SliceRect[];
  totalSlices: number;
  truncated: boolean;
  /** Sum of `estimated_tokens` over `shown`. */
  estimatedTokens: number;
}

/**
 * Decides how an image of `width` x `height` is downscaled and cut.
 *
 * 1. Downscale (never upscale) so the width is at most `maxWidth`.
 * 2. Cut top to bottom into slices of `maxSliceHeight`. If the last slice would
 *    be a sliver, the last two slices are balanced instead.
 * 3. Keep the first `maxSlices` slices; report the rest as truncated.
 */
export function planSlices(width: number, height: number, detail: Detail = "standard", maxSlices = DEFAULT_MAX_SLICES): SlicePlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new RangeError(`Invalid image size ${width}x${height}`);
  }
  const limits = DETAIL_LIMITS[detail];
  const cap = Math.max(1, Math.min(MAX_SLICES_LIMIT, Math.trunc(maxSlices) || DEFAULT_MAX_SLICES));

  const scale = Math.min(1, limits.maxWidth / width);
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  const sliceMax = maxSliceHeight(scaledWidth, limits);

  const heights: number[] = [];
  let remaining = scaledHeight;
  while (remaining > sliceMax) {
    heights.push(sliceMax);
    remaining -= sliceMax;
  }
  heights.push(remaining);
  if (heights.length >= 2 && remaining < MIN_TAIL_SLICE_PX) {
    const pooled = sliceMax + remaining;
    const first = Math.ceil(pooled / 2);
    heights[heights.length - 2] = first;
    heights[heights.length - 1] = pooled - first;
  }

  const slices: SliceRect[] = [];
  let y = 0;
  heights.forEach((h, index) => {
    slices.push({ index, y, width: scaledWidth, height: h, estimated_tokens: estimateTokens(scaledWidth, h) });
    y += h;
  });

  const shown = slices.slice(0, cap);
  return {
    scale,
    scaledWidth,
    scaledHeight,
    maxSliceHeight: sliceMax,
    slices,
    shown,
    totalSlices: slices.length,
    truncated: slices.length > shown.length,
    estimatedTokens: shown.reduce((sum, s) => sum + s.estimated_tokens, 0),
  };
}

// ---------------------------------------------------------------------------
// Image processing
// ---------------------------------------------------------------------------

export interface RawImage {
  data: Buffer;
  raw: { width: number; height: number; channels: 3 | 4 };
}

/** An encoded image (PNG, JPEG, ...) or raw pixels. */
export type ImageSource = Buffer | RawImage;

export interface SizeOptions {
  detail?: Detail | undefined;
  maxSlices?: number | undefined;
  /** Only read the dimensions and compute the plan; produce no JPEGs. */
  planOnly?: boolean | undefined;
  /** Cap on the total JPEG bytes returned. Defaults to `inlineByteBudget(detail)`. */
  maxInlineBytes?: number | undefined;
}

export interface VisionImage extends SliceRect {
  /** JPEG bytes. */
  data: Buffer;
  /** JPEG quality this slice was encoded at. */
  quality: number;
}

export interface VisionResult {
  original: { width: number; height: number };
  images: VisionImage[];
  /** Slices the whole image needs at this detail level, whether or not they were produced. */
  total_slices: number;
  /** True when images were produced and some slices were left out (max_slices or the byte budget). */
  truncated: boolean;
  /** True when the byte budget, not max_slices, removed slices. */
  byte_limited: boolean;
  estimated_image_tokens: number;
  /** Total JPEG bytes of `images`. */
  inline_bytes: number;
  warnings: string[];
  plan: SlicePlan;
}

/** Default caps on the total inline JPEG bytes of one result. */
export const INLINE_BYTE_BUDGET: Record<Detail, number> = { standard: 1_500_000, high: 4_000_000 };
/** Qualities tried, in order, to fit the byte budget. */
export const JPEG_QUALITY_STEPS: readonly number[] = [JPEG_QUALITY, 70, 60];

/** The byte budget for a detail level: env INLINE_MAX_BYTES_STANDARD / INLINE_MAX_BYTES_HIGH, else the default. */
export function inlineByteBudget(detail: Detail): number {
  const name = detail === "high" ? "INLINE_MAX_BYTES_HIGH" : "INLINE_MAX_BYTES_STANDARD";
  const fromEnv = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : INLINE_BYTE_BUDGET[detail];
}

/**
 * Sets how many threads libvips uses per image operation. The hosted server
 * uses 1: jobs already run in parallel through the image gate, and one thread
 * per job keeps its memory use small and predictable.
 */
export function setImageThreads(threads: number): void {
  sharp.concurrency(Math.max(1, Math.trunc(threads)));
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes < 1_000_000 ? 2 : 1)} MB`;
}

function openImage(source: ImageSource): Sharp {
  // Sequential access lets libvips stream a tall page top-down (skip, crop,
  // resize) instead of decoding all of it into memory first.
  return Buffer.isBuffer(source) ? sharp(source, { sequentialRead: true }) : sharp(source.data, { raw: source.raw });
}

function processingError(err: unknown): GetScreenshotError {
  if (err instanceof GetScreenshotError) return err;
  const reason = err instanceof Error ? err.message : String(err);
  return new GetScreenshotError("image_processing_failed", `The image could not be decoded or resized: ${reason}.`, {
    cause: err,
  });
}

/** Reads width and height without decoding the pixels. Works on a prefix of a PNG or JPEG file. */
export async function readDimensions(source: ImageSource): Promise<{ width: number; height: number }> {
  if (!Buffer.isBuffer(source)) return { width: source.raw.width, height: source.raw.height };
  try {
    const meta = await sharp(source).metadata();
    if (!meta.width || !meta.height) throw new Error("the file has no readable dimensions");
    return { width: meta.width, height: meta.height };
  } catch (err) {
    throw processingError(err);
  }
}

/**
 * Reads the dimensions of a stored capture by fetching only its first 64 KB.
 * Falls back to the whole file when the header is not within that prefix.
 */
export async function probeDimensions(url: string, download: DownloadOptions = {}): Promise<{ width: number; height: number }> {
  const head = await downloadResult(url, { ...download, prefixBytes: DIMENSION_PROBE_BYTES });
  try {
    return await readDimensions(head.data);
  } catch (err) {
    if (head.data.byteLength < DIMENSION_PROBE_BYTES) throw err; // that was the whole file
    return readDimensions((await downloadResult(url, download)).data);
  }
}

/**
 * Encodes one slice as JPEG straight from the source: skip to its rows, crop,
 * downscale, encode. No raw pixel buffer reaches JavaScript, so the cost in
 * memory is libvips' streaming window, not the size of the page.
 */
async function encodeSlice(
  source: ImageSource,
  original: { width: number; height: number },
  plan: SlicePlan,
  slice: SliceRect,
  quality: number,
): Promise<Buffer> {
  const isLast = slice.y + slice.height >= plan.scaledHeight;
  const top = Math.min(original.height - 1, Math.round(slice.y / plan.scale));
  const bottom = isLast ? original.height : Math.min(original.height, Math.round((slice.y + slice.height) / plan.scale));
  const rows = Math.max(1, bottom - top);

  let pipeline = openImage(source);
  if (top > 0 || rows < original.height) {
    pipeline = pipeline.extract({ left: 0, top, width: original.width, height: rows });
  }
  if (plan.scaledWidth !== original.width || slice.height !== rows) {
    pipeline = pipeline.resize(plan.scaledWidth, slice.height, { fit: "fill" });
  }
  return pipeline.flatten({ background: "#ffffff" }).toColourspace("srgb").jpeg({ quality }).toBuffer();
}

/**
 * Downscales and slices an image per the `detail` rules and encodes each slice
 * as JPEG.
 *
 * Memory: slices are decoded and encoded one at a time inside libvips, so the
 * peak is its streaming window plus the JPEGs produced so far, whatever the
 * height of the page. The price is that slice N re-reads the rows above it.
 *
 * Bytes: the JPEGs of one result may not exceed the byte budget. Each slice
 * gets an even share of what is left; a slice over its share is re-encoded at
 * quality 70, then 60. If the total still does not fit, trailing slices are
 * dropped and the result is marked truncated. The first slice is always kept.
 */
export async function sizeForVision(source: ImageSource, options: SizeOptions = {}): Promise<VisionResult> {
  const detail = options.detail ?? "standard";
  const original = await readDimensions(source);
  const plan = planSlices(original.width, original.height, detail, options.maxSlices ?? DEFAULT_MAX_SLICES);
  const base = { original, total_slices: plan.totalSlices, plan };
  if (options.planOnly) {
    return { ...base, images: [], truncated: false, byte_limited: false, estimated_image_tokens: 0, inline_bytes: 0, warnings: [] };
  }

  const budget = Math.max(1, options.maxInlineBytes ?? inlineByteBudget(detail));
  const images: VisionImage[] = [];
  let used = 0;
  let lowestQuality = JPEG_QUALITY;
  let byteLimited = false;

  try {
    for (const [position, slice] of plan.shown.entries()) {
      const share = Math.max(0, budget - used) / (plan.shown.length - position);
      let jpeg: Buffer | undefined;
      let quality = JPEG_QUALITY;
      for (const step of JPEG_QUALITY_STEPS) {
        quality = step;
        jpeg = await encodeSlice(source, original, plan, slice, step);
        if (jpeg.byteLength <= share) break;
      }
      const encoded = jpeg as Buffer;
      if (used + encoded.byteLength > budget && images.length > 0) {
        byteLimited = true;
        break;
      }
      used += encoded.byteLength;
      lowestQuality = Math.min(lowestQuality, quality);
      images.push({ ...slice, data: encoded, quality });
    }
  } catch (err) {
    throw processingError(err);
  }

  const warnings: string[] = [];
  if (byteLimited) {
    const dropped = plan.shown.length - images.length;
    warnings.push(
      `${dropped} of the ${plan.shown.length} requested image slices ${dropped === 1 ? "was" : "were"} left out to keep the inline images under ${megabytes(budget)}: ` +
        "this page compresses poorly (photos, gradients or noise). Capture a smaller area with `element`, or open the full image at its URL.",
    );
  } else if (lowestQuality < JPEG_QUALITY) {
    warnings.push(
      `The inline images were compressed harder than usual (JPEG quality ${lowestQuality} instead of ${JPEG_QUALITY}) to stay under ${megabytes(budget)}. Fine text may be less sharp; the full-quality image is at its URL.`,
    );
  }

  return {
    ...base,
    images,
    truncated: plan.truncated || byteLimited,
    byte_limited: byteLimited,
    estimated_image_tokens: images.reduce((sum, image) => sum + image.estimated_tokens, 0),
    inline_bytes: used,
    warnings,
  };
}

/** Downloads a capture from an allowed origin and sizes it for a vision model. */
export async function fetchAndSize(
  url: string,
  options: SizeOptions & { download?: DownloadOptions | undefined } = {},
): Promise<VisionResult> {
  const file = await downloadResult(url, options.download);
  return sizeForVision(file.data, options);
}
