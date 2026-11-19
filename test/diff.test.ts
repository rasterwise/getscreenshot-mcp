import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_COMPARE_HEIGHT, compareMaxHeight, cropRows, diffImages, focusRows } from "../src/diff.js";
import { sizeForVision } from "../src/vision.js";
import { CHANGED_RECT, makePng } from "./helpers/fake-upstream.js";

const base = (width = 1280, height = 800) => makePng({ width, height, changed: false, transparent: false });
const changed = (width = 1280, height = 800) => makePng({ width, height, changed: true, transparent: false });

function pixel(image: { data: Buffer; raw: { width: number; channels: number } }, x: number, y: number): number[] {
  const o = (y * image.raw.width + x) * image.raw.channels;
  return [image.data[o] as number, image.data[o + 1] as number, image.data[o + 2] as number];
}

describe("diffImages", () => {
  it("reports identical images as identical", async () => {
    const result = await diffImages(await base(), await base());
    expect(result.changedPixels).toBe(0);
    expect(result.changedPercent).toBe(0);
    expect(result.identical).toBe(true);
    expect(result.boundingBox).toBeNull();
    expect(result.sizeChanged).toBe(false);
    expect(result.compared).toEqual({ width: 1280, height: 800 });
    expect(result.totalPixels).toBe(1280 * 800);
  });

  it("finds a changed rectangle: pixel count, percentage and bounding box", async () => {
    const result = await diffImages(await base(), await changed());
    const area = CHANGED_RECT.width * CHANGED_RECT.height;
    expect(result.identical).toBe(false);
    expect(result.changedPixels).toBe(area);
    expect(result.changedPercent).toBeCloseTo((area / (1280 * 800)) * 100, 2);
    expect(result.boundingBox).toEqual(CHANGED_RECT);
    expect(result.sizeChanged).toBe(false);
  });

  it("renders the diff: changed pixels highlighted, the rest is the after image dimmed, with a box", async () => {
    const result = await diffImages(await base(), await changed());
    const image = result.diffImage;
    expect(image.raw).toEqual({ width: 1280, height: 800, channels: 4 });
    expect(image.data.length).toBe(1280 * 800 * 4);
    // Inside the changed rectangle: solid highlight.
    expect(pixel(image, CHANGED_RECT.x + 10, CHANGED_RECT.y + 10)).toEqual([255, 0, 96]);
    // Far away: the after image at 40% over white, so lighter than the source but not white.
    const after = await sharp(await changed()).raw().toBuffer({ resolveWithObject: true });
    const source = [after.data[(700 * 1280 + 900) * 3], after.data[(700 * 1280 + 900) * 3 + 1], after.data[(700 * 1280 + 900) * 3 + 2]] as number[];
    const dimmed = pixel(image, 900, 700);
    dimmed.forEach((value, i) => {
      expect(value).toBeCloseTo((source[i] as number) * 0.4 + 153, -0.5);
      expect(value).toBeLessThan(255);
    });
    // The rectangle outline sits 6 px outside the changed area.
    expect(pixel(image, CHANGED_RECT.x + 50, CHANGED_RECT.y - 6)).toEqual([220, 0, 0]);
    expect(pixel(image, CHANGED_RECT.x - 6, CHANGED_RECT.y + 50)).toEqual([220, 0, 0]);
    // It encodes through the normal sizing pipeline.
    const sized = await sizeForVision(image);
    expect(sized.images.length).toBe(1);
    expect((await sharp(sized.images[0]!.data).metadata()).format).toBe("jpeg");
  });

  it("pads the shorter image and flags a size change", async () => {
    const result = await diffImages(await base(1280, 800), await base(1280, 960));
    expect(result.sizeChanged).toBe(true);
    expect(result.identical).toBe(false);
    expect(result.compared).toEqual({ width: 1280, height: 960 });
    expect(result.before).toEqual({ width: 1280, height: 800 });
    expect(result.after).toEqual({ width: 1280, height: 960 });
    // The first 800 rows match; the 160 added rows are coloured bands against white padding.
    expect(result.changedPixels).toBe(1280 * 160);
    expect(result.boundingBox).toEqual({ x: 0, y: 800, width: 1280, height: 160 });
  });

  it("flags a size change even when the added rows are white", async () => {
    const white = (h: number) => sharp({ create: { width: 300, height: h, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const result = await diffImages(await white(200), await white(260));
    expect(result.changedPixels).toBe(0);
    expect(result.sizeChanged).toBe(true);
    expect(result.identical).toBe(false);
  });

  it("normalises different widths to the smaller one", async () => {
    // The same picture at 1x and 2x: after normalising they match.
    const small = await base(640, 400);
    const large = await sharp(small).resize(1280, 800, { kernel: "nearest" }).png().toBuffer();
    const result = await diffImages(small, large);
    expect(result.compared).toEqual({ width: 640, height: 400 });
    expect(result.sizeChanged).toBe(true); // the files differ in size
    expect(result.changedPercent).toBeLessThan(1.5); // only resampling noise at band edges
  });

  it("images of different size are never identical, even when every compared pixel matches", async () => {
    const flat = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#3366aa" } }).png().toBuffer();
    // Same aspect ratio, different size: after normalising to 320 px wide the pixels are equal.
    const scaled = await diffImages(await flat(320, 200), await flat(640, 400));
    expect(scaled.changedPixels).toBe(0);
    expect(scaled.sizeChanged).toBe(true);
    expect(scaled.identical).toBe(false);
    // Same size: identical.
    const same = await diffImages(await flat(320, 200), await flat(320, 200));
    expect(same).toMatchObject({ changedPixels: 0, sizeChanged: false, identical: true });
  });

  it("compares at most 2400 rows by default, and COMPARE_MAX_HEIGHT overrides that", async () => {
    expect(MAX_COMPARE_HEIGHT).toBe(2400);
    expect(compareMaxHeight()).toBe(2400);
    const tall = await base(400, 3000);
    const byDefault = await diffImages(tall, tall);
    expect(byDefault.compared).toEqual({ width: 400, height: 2400 });
    expect(byDefault.cropped).toBe(true);
    expect(byDefault.diffImage.data.length).toBe(400 * 2400 * 4);
    process.env.COMPARE_MAX_HEIGHT = "2900";
    try {
      expect(compareMaxHeight()).toBe(2900);
      expect((await diffImages(tall, tall)).compared.height).toBe(2900);
      process.env.COMPARE_MAX_HEIGHT = "junk";
      expect(compareMaxHeight()).toBe(2400);
    } finally {
      delete process.env.COMPARE_MAX_HEIGHT;
    }
  });

  it("downscales wide captures to 1280 before comparing", async () => {
    const result = await diffImages(await base(2560, 1600), await changed(2560, 1600));
    expect(result.compared).toEqual({ width: 1280, height: 800 });
    const box = result.boundingBox!;
    expect(Math.abs(box.x - CHANGED_RECT.x / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y - CHANGED_RECT.y / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.width - CHANGED_RECT.width / 2)).toBeLessThanOrEqual(4);
  });

  it("threshold decides whether a faint change counts", async () => {
    const flat = (colour: string) => sharp({ create: { width: 200, height: 100, channels: 3, background: colour } }).png().toBuffer();
    const a = await flat("#808080");
    const b = await flat("#868686");
    expect((await diffImages(a, b, { threshold: 0.1 })).changedPixels).toBe(0);
    expect((await diffImages(a, b, { threshold: 0 })).changedPixels).toBe(200 * 100);
  });

  it("caps the compared height and says so", async () => {
    const result = await diffImages(await base(400, 3000), await base(400, 3000), { maxHeight: 1000 });
    expect(result.compared).toEqual({ width: 400, height: 1000 });
    expect(result.cropped).toBe(true);
    expect(result.changedPixels).toBe(0);
  });

  it("rejects input that is not an image", async () => {
    await expect(diffImages(Buffer.from("nope"), await base())).rejects.toMatchObject({ code: "image_processing_failed" });
  });
});

describe("focusRows and cropRows", () => {
  it("focuses on the changed rows with a margin", () => {
    const compared = { width: 1280, height: 6000 };
    expect(focusRows({ boundingBox: { x: 0, y: 3000, width: 10, height: 50 }, compared })).toEqual({ top: 2880, height: 290 });
    expect(focusRows({ boundingBox: { x: 0, y: 20, width: 10, height: 50 }, compared })).toEqual({ top: 0, height: 190 });
    expect(focusRows({ boundingBox: { x: 0, y: 5950, width: 10, height: 50 }, compared })).toEqual({ top: 5830, height: 170 });
    expect(focusRows({ boundingBox: null, compared })).toEqual({ top: 0, height: 6000 });
  });

  it("crops raw rows without copying other rows in", () => {
    const data = Buffer.from([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]); // 1 px wide, 4 rows, RGB
    const cropped = cropRows({ data, raw: { width: 1, height: 4, channels: 3 } }, 1, 2);
    expect(cropped.raw).toEqual({ width: 1, height: 2, channels: 3 });
    expect([...cropped.data]).toEqual([2, 2, 2, 3, 3, 3]);
  });
});
