/**
 * Visual diff of two images for compare_screenshots.
 *
 * Both images are brought to the same width (the smaller of the two, capped),
 * padded with white to the same height, and compared with pixelmatch. The diff
 * image is the "after" image dimmed, with changed pixels painted in a solid
 * highlight colour and a rectangle around the changed area.
 */
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { GetScreenshotError } from "./api.js";
import { readDimensions, type RawImage } from "./vision.js";

export const DEFAULT_DIFF_THRESHOLD = 0.1;
/** Comparison happens at this width at most; wider captures are downscaled first. */
export const MAX_COMPARE_WIDTH = 1280;
/**
 * Rows beyond this (at comparison width) are not compared. A compare holds two
 * RGBA images and the diff in memory, 12 bytes per pixel: at 1280 x 2400 that
 * is 37 MB, which with decoding overhead keeps one compare around 50-60 MB.
 * Operators with memory to spare can raise it with COMPARE_MAX_HEIGHT.
 */
export const MAX_COMPARE_HEIGHT = 2400;

/** The compare height cap: env COMPARE_MAX_HEIGHT, else the default. */
export function compareMaxHeight(): number {
  const fromEnv = Number.parseInt(process.env.COMPARE_MAX_HEIGHT ?? "", 10);
  return Number.isInteger(fromEnv) && fromEnv >= 100 ? fromEnv : MAX_COMPARE_HEIGHT;
}

const HIGHLIGHT: readonly [number, number, number] = [255, 0, 96];
const BOX_COLOUR: readonly [number, number, number] = [220, 0, 0];
const BOX_PADDING = 6;
const BOX_STROKE = 3;
/** How much of the "after" image shows through where nothing changed. */
const DIM_OPACITY = 0.4;

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffOptions {
  threshold?: number | undefined;
  maxWidth?: number | undefined;
  maxHeight?: number | undefined;
}

export interface DiffResult {
  changedPixels: number;
  totalPixels: number;
  /** 0-100, rounded to 3 decimals. */
  changedPercent: number;
  identical: boolean;
  /** Smallest rectangle containing every changed pixel, in comparison-image pixels. Null when nothing changed. */
  boundingBox: BoundingBox | null;
  /** Original sizes of the two inputs. */
  before: { width: number; height: number };
  after: { width: number; height: number };
  /** Size both images were normalised to for the comparison. */
  compared: { width: number; height: number };
  /** True when the two inputs differ in width or height. */
  sizeChanged: boolean;
  /** True when rows beyond the height cap were left out of the comparison. */
  cropped: boolean;
  threshold: number;
  /** RGBA pixels (fully opaque) of the diff image, same size as `compared`. */
  diffImage: RawImage;
}

interface Normalised {
  rgba: Buffer;
  /** Height of this image at comparison width, before padding or cropping. */
  naturalHeight: number;
}

async function normalise(
  source: Buffer,
  original: { width: number; height: number },
  width: number,
  height: number,
): Promise<Normalised> {
  const scale = width / original.width;
  const naturalHeight = Math.max(1, Math.round(original.height * scale));
  const rows = Math.min(naturalHeight, height);
  const sourceRows = rows < naturalHeight ? Math.min(original.height, Math.max(1, Math.round(rows / scale))) : original.height;

  let pipeline = sharp(source, { sequentialRead: true });
  if (sourceRows < original.height) {
    pipeline = pipeline.extract({ left: 0, top: 0, width: original.width, height: sourceRows });
  }
  if (width !== original.width || rows !== sourceRows) {
    pipeline = pipeline.resize(width, rows, { fit: "fill" });
  }
  const { data, info } = await pipeline
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width === width && info.height === height && info.channels === 4) {
    return { rgba: data, naturalHeight };
  }
  // Pad with opaque white to the common height.
  const rgba = Buffer.alloc(width * height * 4, 255);
  data.copy(rgba, 0, 0, Math.min(data.length, info.width * Math.min(info.height, height) * 4));
  return { rgba, naturalHeight };
}

function findBoundingBox(mask: Uint8Array, width: number, height: number): BoundingBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (mask[row + x * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Turns the pixelmatch mask into the diff image in place: changed pixels become
 * the highlight colour, everything else the "after" pixel dimmed towards white.
 * Reusing the mask buffer avoids a third full-size allocation.
 */
function renderDiffInPlace(after: Buffer, mask: Buffer, width: number, height: number, box: BoundingBox | null): void {
  const lift = 255 * (1 - DIM_OPACITY);
  for (let p = 0, end = width * height * 4; p < end; p += 4) {
    if (mask[p + 3] !== 0) {
      mask[p] = HIGHLIGHT[0];
      mask[p + 1] = HIGHLIGHT[1];
      mask[p + 2] = HIGHLIGHT[2];
    } else {
      mask[p] = (after[p] as number) * DIM_OPACITY + lift;
      mask[p + 1] = (after[p + 1] as number) * DIM_OPACITY + lift;
      mask[p + 2] = (after[p + 2] as number) * DIM_OPACITY + lift;
      mask[p + 3] = 255;
    }
  }
  if (!box) return;
  const left = Math.max(0, box.x - BOX_PADDING);
  const top = Math.max(0, box.y - BOX_PADDING);
  const right = Math.min(width - 1, box.x + box.width - 1 + BOX_PADDING);
  const bottom = Math.min(height - 1, box.y + box.height - 1 + BOX_PADDING);
  const paint = (x: number, y: number) => {
    const p = (y * width + x) * 4;
    // Never paint over a changed pixel (dimmed pixels can never equal the highlight colour).
    if (mask[p] === HIGHLIGHT[0] && mask[p + 1] === HIGHLIGHT[1] && mask[p + 2] === HIGHLIGHT[2]) return;
    mask[p] = BOX_COLOUR[0];
    mask[p + 1] = BOX_COLOUR[1];
    mask[p + 2] = BOX_COLOUR[2];
  };
  for (let s = 0; s < BOX_STROKE; s++) {
    for (let x = left; x <= right; x++) {
      if (top + s <= bottom) paint(x, top + s);
      if (bottom - s >= top) paint(x, bottom - s);
    }
    for (let y = top; y <= bottom; y++) {
      if (left + s <= right) paint(left + s, y);
      if (right - s >= left) paint(right - s, y);
    }
  }
}

/** Compares two encoded images. See the module comment for the method. */
export async function diffImages(before: Buffer, after: Buffer, options: DiffOptions = {}): Promise<DiffResult> {
  const threshold = Math.min(1, Math.max(0, options.threshold ?? DEFAULT_DIFF_THRESHOLD));
  const maxWidth = options.maxWidth ?? MAX_COMPARE_WIDTH;
  const maxHeight = options.maxHeight ?? compareMaxHeight();

  const [beforeSize, afterSize] = await Promise.all([readDimensions(before), readDimensions(after)]);
  const width = Math.max(1, Math.min(beforeSize.width, afterSize.width, maxWidth));
  const naturalBefore = Math.max(1, Math.round((beforeSize.height * width) / beforeSize.width));
  const naturalAfter = Math.max(1, Math.round((afterSize.height * width) / afterSize.width));
  const tallest = Math.max(naturalBefore, naturalAfter);
  const height = Math.min(tallest, maxHeight);

  let a: Normalised;
  let b: Normalised;
  try {
    // One after the other: decoding both at once doubles the transient memory.
    a = await normalise(before, beforeSize, width, height);
    b = await normalise(after, afterSize, width, height);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GetScreenshotError("image_processing_failed", `The images could not be prepared for comparison: ${reason}.`, {
      cause: err,
    });
  }

  const mask = Buffer.alloc(width * height * 4);
  const changedPixels = pixelmatch(a.rgba, b.rgba, mask, width, height, { threshold, diffMask: true });
  const totalPixels = width * height;
  const boundingBox = changedPixels > 0 ? findBoundingBox(mask, width, height) : null;
  const sizeChanged = beforeSize.width !== afterSize.width || beforeSize.height !== afterSize.height;
  renderDiffInPlace(b.rgba, mask, width, height, boundingBox);

  return {
    changedPixels,
    totalPixels,
    changedPercent: Math.round((changedPixels / totalPixels) * 100_000) / 1000,
    // Two images of different size are never "identical", even when every compared pixel matches.
    identical: changedPixels === 0 && !sizeChanged,
    boundingBox,
    before: beforeSize,
    after: afterSize,
    compared: { width, height },
    sizeChanged,
    cropped: tallest > height,
    threshold,
    diffImage: { data: mask, raw: { width, height, channels: 4 } },
  };
}

/**
 * The rows of the diff image worth showing: the changed area plus a margin.
 * A tall page with one small change would otherwise spend the slice budget on
 * unchanged rows above it. Returns the whole image when nothing changed.
 */
export function focusRows(result: Pick<DiffResult, "boundingBox" | "compared">, margin = 120): { top: number; height: number } {
  const total = result.compared.height;
  if (!result.boundingBox) return { top: 0, height: total };
  const top = Math.max(0, result.boundingBox.y - margin);
  const bottom = Math.min(total, result.boundingBox.y + result.boundingBox.height + margin);
  return { top, height: Math.max(1, bottom - top) };
}

/** Crops a raw image to a band of rows without re-encoding. */
export function cropRows(image: RawImage, top: number, height: number): RawImage {
  const { width, channels } = image.raw;
  const start = top * width * channels;
  return {
    data: image.data.subarray(start, start + height * width * channels),
    raw: { width, height, channels },
  };
}
