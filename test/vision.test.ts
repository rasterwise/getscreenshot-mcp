import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GetScreenshotError } from "../src/api.js";
import {
  DEFAULT_ALLOWED_ORIGINS,
  DETAIL_LIMITS,
  allowedOriginsFor,
  assertAllowedUrl,
  assertResultUrl,
  downloadResult,
  estimateTokens,
  fetchAndSize,
  maxSliceHeight,
  INLINE_BYTE_BUDGET,
  inlineByteBudget,
  planSlices,
  probeDimensions,
  sizeForVision,
  type Detail,
} from "../src/vision.js";
import { GOOD_KEY, expectedBandColour, makeNoise, makePng, startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.js";

describe("estimateTokens", () => {
  const cases: Array<[number, number, number]> = [
    [28, 28, 1],
    [29, 28, 2],
    [1280, 800, 46 * 29],
    [1280, 952, 46 * 34],
    [1280, 953, 46 * 35],
    [1568, 1568, 56 * 56],
    [1920, 1932, 69 * 69],
    [390, 844, 14 * 31],
    [1, 1, 1],
  ];
  for (const [w, h, tokens] of cases) {
    it(`${w}x${h} = ${tokens}`, () => expect(estimateTokens(w, h)).toBe(tokens));
  }
});

describe("maxSliceHeight", () => {
  const cases: Array<[Detail, number, number]> = [
    ["standard", 1280, 952], // floor(1568 / 46) = 34 rows of 28 px
    ["standard", 1024, 1176], // 37 columns, 42 rows
    ["standard", 800, 1512], // 29 columns, 54 rows
    ["standard", 400, 1568], // token limit allows more; long edge caps it
    ["standard", 28, 1568],
    ["high", 1920, 1932], // floor(4784 / 69) = 69 rows
    ["high", 1280, 2576], // 46 columns, 104 rows = 2912 px; long edge caps it
  ];
  for (const [detail, width, expected] of cases) {
    it(`${detail} at ${width} px wide`, () => {
      const limits = DETAIL_LIMITS[detail];
      const columns = Math.ceil(width / 28);
      const byTokens = Math.floor(limits.maxTokens / columns) * 28;
      const want = Math.min(limits.maxLongEdge, byTokens);
      // The table documents the numbers; the formula cross-checks them.
      expect(expected).toBe(want);
      expect(maxSliceHeight(width, limits)).toBe(expected);
      expect(estimateTokens(width, expected)).toBeLessThanOrEqual(limits.maxTokens);
      expect(estimateTokens(width, expected + 28)).toBeGreaterThan(Math.min(limits.maxTokens, estimateTokens(width, limits.maxLongEdge)));
    });
  }
});

describe("planSlices", () => {
  interface Case {
    name: string;
    size: [number, number];
    detail: Detail;
    maxSlices: number;
    scaled: [number, number];
    heights: number[];
    shown: number;
    truncated: boolean;
    tokens: number;
  }
  const cases: Case[] = [
    {
      name: "default viewport is one image",
      size: [1280, 800],
      detail: "standard",
      maxSlices: 4,
      scaled: [1280, 800],
      heights: [800],
      shown: 1,
      truncated: false,
      tokens: 46 * 29,
    },
    {
      name: "1280x6000 full page: 952 px slices, truncated at 4",
      size: [1280, 6000],
      detail: "standard",
      maxSlices: 4,
      scaled: [1280, 6000],
      heights: [952, 952, 952, 952, 952, 952, 288],
      shown: 4,
      truncated: true,
      tokens: 4 * 46 * 34,
    },
    {
      name: "1280x6000 with max_slices 10 shows everything",
      size: [1280, 6000],
      detail: "standard",
      maxSlices: 10,
      scaled: [1280, 6000],
      heights: [952, 952, 952, 952, 952, 952, 288],
      shown: 7,
      truncated: false,
      tokens: 6 * 46 * 34 + 46 * 11,
    },
    {
      name: "max_slices 1 keeps only the top slice",
      size: [1280, 6000],
      detail: "standard",
      maxSlices: 1,
      scaled: [1280, 6000],
      heights: [952, 952, 952, 952, 952, 952, 288],
      shown: 1,
      truncated: true,
      tokens: 46 * 34,
    },
    {
      name: "retina capture is downscaled to 1280 first",
      size: [2560, 12000],
      detail: "standard",
      maxSlices: 4,
      scaled: [1280, 6000],
      heights: [952, 952, 952, 952, 952, 952, 288],
      shown: 4,
      truncated: true,
      tokens: 4 * 46 * 34,
    },
    {
      name: "1920x1080 standard is downscaled to 1280x720",
      size: [1920, 1080],
      detail: "standard",
      maxSlices: 4,
      scaled: [1280, 720],
      heights: [720],
      shown: 1,
      truncated: false,
      tokens: 46 * 26,
    },
    {
      name: "1920x1080 high keeps full size",
      size: [1920, 1080],
      detail: "high",
      maxSlices: 4,
      scaled: [1920, 1080],
      heights: [1080],
      shown: 1,
      truncated: false,
      tokens: 69 * 39,
    },
    {
      name: "1920x6000 high: 1932 px slices",
      size: [1920, 6000],
      detail: "high",
      maxSlices: 4,
      scaled: [1920, 6000],
      heights: [1932, 1932, 1932, 204],
      shown: 4,
      truncated: false,
      tokens: 3 * 69 * 69 + 69 * 8,
    },
    {
      name: "1280x6000 high is not upscaled; long edge caps the slice at 2576",
      size: [1280, 6000],
      detail: "high",
      maxSlices: 4,
      scaled: [1280, 6000],
      heights: [2576, 2576, 848],
      shown: 3,
      truncated: false,
      tokens: 2 * 46 * 92 + 46 * 31,
    },
    {
      name: "a sliver tail is balanced with the slice before it",
      size: [1280, 952 * 2 + 50],
      detail: "standard",
      maxSlices: 4,
      scaled: [1280, 1954],
      heights: [952, 501, 501],
      shown: 3,
      truncated: false,
      tokens: 46 * 34 + 2 * 46 * 18,
    },
    {
      name: "phone viewport is one small image",
      size: [390, 844],
      detail: "standard",
      maxSlices: 4,
      scaled: [390, 844],
      heights: [844],
      shown: 1,
      truncated: false,
      tokens: 14 * 31,
    },
    {
      name: "narrow tall image: long edge is the limit",
      size: [400, 3000],
      detail: "standard",
      maxSlices: 4,
      scaled: [400, 3000],
      heights: [1568, 1432],
      shown: 2,
      truncated: false,
      tokens: 15 * 56 + 15 * 52,
    },
    {
      name: "exactly one slice tall",
      size: [1280, 952],
      detail: "standard",
      maxSlices: 4,
      scaled: [1280, 952],
      heights: [952],
      shown: 1,
      truncated: false,
      tokens: 46 * 34,
    },
    {
      name: "one pixel over a slice",
      size: [1280, 953],
      detail: "standard",
      maxSlices: 4,
      scaled: [1280, 953],
      heights: [477, 476],
      shown: 2,
      truncated: false,
      tokens: 46 * 18 + 46 * 17,
    },
    {
      name: "tiny element is never upscaled",
      size: [120, 40],
      detail: "high",
      maxSlices: 4,
      scaled: [120, 40],
      heights: [40],
      shown: 1,
      truncated: false,
      tokens: 5 * 2,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const plan = planSlices(c.size[0], c.size[1], c.detail, c.maxSlices);
      expect([plan.scaledWidth, plan.scaledHeight]).toEqual(c.scaled);
      expect(plan.slices.map((s) => s.height)).toEqual(c.heights);
      expect(plan.totalSlices).toBe(c.heights.length);
      expect(plan.shown.length).toBe(c.shown);
      expect(plan.truncated).toBe(c.truncated);
      expect(plan.estimatedTokens).toBe(c.tokens);
      // Offsets are contiguous from the top.
      let y = 0;
      for (const [index, slice] of plan.slices.entries()) {
        expect(slice.index).toBe(index);
        expect(slice.y).toBe(y);
        expect(slice.width).toBe(c.scaled[0]);
        expect(slice.estimated_tokens).toBe(estimateTokens(slice.width, slice.height));
        y += slice.height;
      }
      expect(y).toBe(c.scaled[1]);
    });
  }

  it("every slice respects the limits for arbitrary sizes", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      const width = 1 + Math.floor(random() * 4000);
      const height = 1 + Math.floor(random() * 30000);
      const detail: Detail = random() < 0.5 ? "standard" : "high";
      const maxSlices = 1 + Math.floor(random() * 10);
      const limits = DETAIL_LIMITS[detail];
      const plan = planSlices(width, height, detail, maxSlices);
      const label = `${width}x${height} ${detail}`;
      expect(plan.scaledWidth, label).toBeLessThanOrEqual(limits.maxWidth);
      expect(plan.scaledWidth, label).toBeLessThanOrEqual(width);
      expect(plan.shown.length, label).toBeLessThanOrEqual(maxSlices);
      expect(plan.slices.reduce((sum, s) => sum + s.height, 0), label).toBe(plan.scaledHeight);
      for (const slice of plan.slices) {
        expect(slice.height, label).toBeGreaterThan(0);
        expect(Math.max(slice.width, slice.height), label).toBeLessThanOrEqual(limits.maxLongEdge);
        expect(slice.estimated_tokens, label).toBeLessThanOrEqual(limits.maxTokens);
      }
    }
  });

  it("rejects nonsense sizes and clamps max_slices", () => {
    expect(() => planSlices(0, 100)).toThrow(RangeError);
    expect(() => planSlices(100, Number.NaN)).toThrow(RangeError);
    expect(planSlices(1280, 60000, "standard", 99).shown.length).toBe(10);
    expect(planSlices(1280, 60000, "standard", 0).shown.length).toBe(4);
  });
});

describe("sizeForVision", () => {
  async function meanColour(jpeg: Buffer, top: number): Promise<number[]> {
    const { data } = await sharp(jpeg).extract({ left: 10, top, width: 20, height: 4 }).raw().toBuffer({ resolveWithObject: true });
    return [data[0] as number, data[1] as number, data[2] as number];
  }
  function near(actual: number[], expected: number[], tolerance = 12): boolean {
    return actual.every((v, i) => Math.abs(v - (expected[i] as number)) <= tolerance);
  }

  it("cuts a 1280x6000 PNG into JPEG slices from the right rows and truncates", async () => {
    const png = await makePng({ width: 1280, height: 6000, changed: false, transparent: false });
    const result = await sizeForVision(png, { detail: "standard", maxSlices: 4 });
    expect(result.original).toEqual({ width: 1280, height: 6000 });
    expect(result.total_slices).toBe(7);
    expect(result.truncated).toBe(true);
    expect(result.images.length).toBe(4);
    expect(result.estimated_image_tokens).toBe(4 * 1564);
    for (const image of result.images) {
      const meta = await sharp(image.data).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(1280);
      expect(meta.height).toBe(952);
      expect(image.y).toBe(image.index * 952);
      // The first rows of slice N are the rows of the page at y = N * 952.
      expect(near(await meanColour(image.data, 4), expectedBandColour(image.y + 5))).toBe(true);
      expect(near(await meanColour(image.data, 940), expectedBandColour(image.y + 942))).toBe(true);
    }
  });

  it("returns every slice when max_slices allows, including the short tail", async () => {
    const png = await makePng({ width: 1280, height: 6000, changed: false, transparent: false });
    const result = await sizeForVision(png, { maxSlices: 10 });
    expect(result.truncated).toBe(false);
    expect(result.images.map((i) => i.height)).toEqual([952, 952, 952, 952, 952, 952, 288]);
    const tail = result.images[6]!;
    expect((await sharp(tail.data).metadata()).height).toBe(288);
    expect(near(await meanColour(tail.data, 280), expectedBandColour(5712 + 282))).toBe(true);
  });

  it("downscales wide images and keeps the aspect ratio", async () => {
    const png = await makePng({ width: 2560, height: 1600, changed: false, transparent: false });
    const standard = await sizeForVision(png);
    expect(standard.images.length).toBe(1);
    const meta = await sharp(standard.images[0]!.data).metadata();
    expect([meta.width, meta.height]).toEqual([1280, 800]);
    expect(standard.estimated_image_tokens).toBe(46 * 29);
    // Row 425 of the inline image is row 850 of the original.
    expect(near(await meanColour(standard.images[0]!.data, 425), expectedBandColour(850))).toBe(true);

    const high = await sizeForVision(png, { detail: "high" });
    const highMeta = await sharp(high.images[0]!.data).metadata();
    expect([highMeta.width, highMeta.height]).toEqual([1920, 1200]);
    expect(high.estimated_image_tokens).toBe(69 * 43);
  });

  it("truncated retina page: slices still come from the right rows", async () => {
    const png = await makePng({ width: 2560, height: 9000, changed: false, transparent: false });
    const result = await sizeForVision(png, { maxSlices: 2 });
    expect(result.truncated).toBe(true);
    expect(result.images.length).toBe(2);
    const second = result.images[1]!;
    expect(second.y).toBe(952);
    // Inline row 952 + 520 corresponds to original row (952 + 520) * 2 = 2944.
    expect(near(await meanColour(second.data, 520), expectedBandColour((952 + 520) * 2))).toBe(true);
  });

  it("planOnly reads dimensions without producing images", async () => {
    const png = await makePng({ width: 1280, height: 6000, changed: false, transparent: false });
    const result = await sizeForVision(png, { planOnly: true });
    expect(result.images).toEqual([]);
    expect(result.total_slices).toBe(7);
    expect(result.truncated).toBe(false);
    expect(result.estimated_image_tokens).toBe(0);
  });

  it("flattens transparency onto white", async () => {
    const png = await makePng({ width: 200, height: 100, changed: false, transparent: true });
    const result = await sizeForVision(png);
    const { data } = await sharp(result.images[0]!.data).extract({ left: 20, top: 50, width: 4, height: 4 }).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(245);
    expect(data[1]).toBeGreaterThan(245);
    expect(data[2]).toBeGreaterThan(245);
  });

  it("accepts JPEG and greyscale input", async () => {
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    expect((await sizeForVision(jpeg)).images.length).toBe(1);
    const grey = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#777777" } }).greyscale().png().toBuffer();
    const sized = await sizeForVision(grey);
    expect((await sharp(sized.images[0]!.data).metadata()).format).toBe("jpeg");
  });

  it("reports plain results as inside the budget at quality 80", async () => {
    const png = await makePng({ width: 1280, height: 6000, changed: false, transparent: false });
    const result = await sizeForVision(png, { maxSlices: 10 });
    expect(result.byte_limited).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.images.every((image) => image.quality === 80)).toBe(true);
    expect(result.inline_bytes).toBe(result.images.reduce((sum, image) => sum + image.data.byteLength, 0));
    expect(result.inline_bytes).toBeLessThan(INLINE_BYTE_BUDGET.standard);
  });

  describe("inline byte budget", () => {
    it("has the documented defaults and reads overrides from the environment", () => {
      expect(INLINE_BYTE_BUDGET).toEqual({ standard: 1_500_000, high: 4_000_000 });
      expect(inlineByteBudget("standard")).toBe(1_500_000);
      expect(inlineByteBudget("high")).toBe(4_000_000);
      process.env.INLINE_MAX_BYTES_STANDARD = "250000";
      process.env.INLINE_MAX_BYTES_HIGH = "nonsense";
      try {
        expect(inlineByteBudget("standard")).toBe(250_000);
        expect(inlineByteBudget("high")).toBe(4_000_000);
      } finally {
        delete process.env.INLINE_MAX_BYTES_STANDARD;
        delete process.env.INLINE_MAX_BYTES_HIGH;
      }
    });

    it("an incompressible page is squeezed, then cut, to stay under the default budget", async () => {
      // Random pixels: each 1280x952 slice is far over its share of 1.5 MB at quality 80.
      const noise = await makeNoise(1280, 3808);
      const unlimited = await sizeForVision(noise, { maxSlices: 4, maxInlineBytes: Number.MAX_SAFE_INTEGER });
      expect(unlimited.images).toHaveLength(4);
      expect(unlimited.inline_bytes).toBeGreaterThan(INLINE_BYTE_BUDGET.standard);
      expect(unlimited.images.every((image) => image.quality === 80)).toBe(true);

      const result = await sizeForVision(noise, { maxSlices: 4 });
      expect(result.inline_bytes).toBeLessThanOrEqual(INLINE_BYTE_BUDGET.standard);
      expect(result.inline_bytes).toBe(result.images.reduce((sum, image) => sum + image.data.byteLength, 0));
      expect(result.images.length).toBeGreaterThanOrEqual(1);
      expect(result.images.length).toBeLessThan(4);
      expect(result.images.every((image) => image.quality === 60)).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.byte_limited).toBe(true);
      expect(result.total_slices).toBe(4);
      expect(result.estimated_image_tokens).toBe(result.images.length * 1564);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/left out to keep the inline images under 1\.5 MB/);
      expect(result.warnings[0]).toMatch(/compresses poorly/);
      // What is kept is still the top of the page, in order, as valid JPEGs.
      for (const [i, image] of result.images.entries()) {
        expect(image.index).toBe(i);
        expect(image.y).toBe(i * 952);
        expect((await sharp(image.data).metadata()).format).toBe("jpeg");
      }
    });

    it("steps the quality down before dropping anything", async () => {
      const noise = await makeNoise(1280, 1904); // two slices
      const full = await sizeForVision(noise, { maxInlineBytes: Number.MAX_SAFE_INTEGER });
      const q80 = full.inline_bytes;
      // A budget a little under the quality-80 size: quality 70 is enough, nothing is dropped.
      const result = await sizeForVision(noise, { maxInlineBytes: Math.round(q80 * 0.9) });
      expect(result.images).toHaveLength(2);
      expect(result.truncated).toBe(false);
      expect(result.byte_limited).toBe(false);
      expect(result.inline_bytes).toBeLessThanOrEqual(Math.round(q80 * 0.9));
      expect(Math.min(...result.images.map((image) => image.quality))).toBe(70);
      expect(result.warnings[0]).toMatch(/compressed harder than usual \(JPEG quality 70 instead of 80\)/);
    });

    it("always keeps the first slice, even when it alone is over the budget", async () => {
      const noise = await makeNoise(1280, 1904);
      const result = await sizeForVision(noise, { maxInlineBytes: 1000 });
      expect(result.images).toHaveLength(1);
      expect(result.images[0]!.quality).toBe(60);
      expect(result.truncated).toBe(true);
      expect(result.byte_limited).toBe(true);
    });
  });

  it("reports undecodable input as a typed error", async () => {
    await expect(sizeForVision(Buffer.from("this is not an image"))).rejects.toMatchObject({
      name: "GetScreenshotError",
      code: "image_processing_failed",
    });
  });
});

describe("download allow-list", () => {
  let fake: FakeUpstream;
  beforeAll(async () => {
    fake = await startFakeUpstream();
  });
  afterAll(async () => {
    await fake.close();
  });

  it("defaults to the storage host over https only", () => {
    expect([...DEFAULT_ALLOWED_ORIGINS]).toEqual(["https://storage.googleapis.com"]);
    expect(assertAllowedUrl("https://storage.googleapis.com/getscreenshot-storage/imageAbC123xYz9.png").hostname).toBe(
      "storage.googleapis.com",
    );
  });

  const rejected = [
    "http://storage.googleapis.com/getscreenshot-storage/image.png",
    "https://storage.googleapis.com:8443/x.png",
    "https://storage.googleapis.com.evil.example/x.png",
    "https://evil.example/storage.googleapis.com/x.png",
    "https://storage.googleapis.com@evil.example/x.png",
    "https://user:pass@storage.googleapis.com/x.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8080/admin",
    "http://127.0.0.1/",
    "file:///etc/passwd",
    "gopher://storage.googleapis.com/",
    "//storage.googleapis.com/x.png",
    "not a url",
    "",
  ];
  for (const url of rejected) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(() => assertAllowedUrl(url)).toThrow(GetScreenshotError);
      try {
        assertAllowedUrl(url);
      } catch (err) {
        expect((err as GetScreenshotError).code).toBe("download_not_allowed");
      }
    });
  }

  it("caller-supplied result URLs must also be in the API's bucket", () => {
    expect(assertResultUrl("https://storage.googleapis.com/getscreenshot-storage/imageAbC123xYz9.png").pathname).toBe(
      "/getscreenshot-storage/imageAbC123xYz9.png",
    );
    for (const url of [
      "https://storage.googleapis.com/someone-elses-bucket/bomb.png",
      "https://storage.googleapis.com/getscreenshot-storage-evil/x.png",
      "https://storage.googleapis.com/getscreenshot-storage/../other-bucket/x.png",
      "https://storage.googleapis.com/getscreenshot-storage/%2e%2e/other-bucket/x.png",
      "https://storage.googleapis.com/",
      "https://evil.example/getscreenshot-storage/x.png",
    ]) {
      expect(() => assertResultUrl(url), url).toThrow(GetScreenshotError);
    }
  });

  it("adds the API base origin only when the base is overridden", () => {
    expect(allowedOriginsFor("https://api.rasterwise.com")).toEqual(["https://storage.googleapis.com"]);
    expect(allowedOriginsFor("http://127.0.0.1:4010/")).toEqual(["https://storage.googleapis.com", "http://127.0.0.1:4010"]);
    expect(() => assertAllowedUrl("http://127.0.0.1:4010/x.png", allowedOriginsFor("http://127.0.0.1:4010"))).not.toThrow();
    expect(() => assertAllowedUrl("http://127.0.0.1:4011/x.png", allowedOriginsFor("http://127.0.0.1:4010"))).toThrow();
  });

  it("makes no request at all for a URL off the list", async () => {
    let calls = 0;
    const spy: typeof fetch = (...args) => {
      calls += 1;
      return fetch(...args);
    };
    await expect(downloadResult("http://169.254.169.254/latest/meta-data/", { fetchImpl: spy })).rejects.toMatchObject({
      code: "download_not_allowed",
    });
    await expect(
      downloadResult(`${fake.url}/getscreenshot-storage/x.png`, { fetchImpl: spy }), // default list: the fake is not on it
    ).rejects.toMatchObject({ code: "download_not_allowed" });
    expect(calls).toBe(0);
  });

  it("downloads from an allowed origin and sizes the image", async () => {
    const api = await fetch(`${fake.url}/v1/get-screenshot?apikey=${GOOD_KEY}&url=${encodeURIComponent("https://example.com")}`);
    const body = (await api.json()) as { screenshotImage: string };
    const sized = await fetchAndSize(body.screenshotImage, { download: { allowedOrigins: [fake.origin] } });
    expect(sized.original).toEqual({ width: 1280, height: 800 });
    expect(sized.images.length).toBe(1);
    expect(sized.inline_bytes).toBe(sized.images[0]!.data.byteLength);
  });

  it("probeDimensions reads the size from the first 64 KB only", async () => {
    const api = await fetch(
      `${fake.url}/v1/get-screenshot?apikey=${GOOD_KEY}&url=${encodeURIComponent("https://example.com/noise")}&width=1280&height=3000`,
    );
    const body = (await api.json()) as { screenshotImage: string };
    fake.reset();
    let received = 0;
    const counting: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      received += Number(response.headers.get("content-length"));
      return response;
    };
    const size = await probeDimensions(body.screenshotImage, { allowedOrigins: [fake.origin], fetchImpl: counting });
    expect(size).toEqual({ width: 1280, height: 3000 });
    expect(fake.downloads()).toHaveLength(1);
    expect(fake.downloads()[0]!.headers.range).toBe("bytes=0-65535");
    expect(received).toBe(65536); // of a file several megabytes long
  });

  it("a prefix download stops at the requested size even when the server ignores Range", async () => {
    // /big streams 64 KB and knows nothing about Range.
    const head = await downloadResult(`${fake.url}/big`, { allowedOrigins: [fake.origin], prefixBytes: 1000 });
    expect(head.data.byteLength).toBe(1000);
    const small = await downloadResult(`${fake.url}/big`, { allowedOrigins: [fake.origin], prefixBytes: 1000, maxBytes: 10 });
    expect(small.data.byteLength).toBe(1000); // the prefix is the bound; maxBytes is for whole files
  });

  it("enforces the size cap on streamed and declared sizes", async () => {
    const options = { allowedOrigins: [fake.origin], maxBytes: 10 * 1024 };
    await expect(downloadResult(`${fake.url}/big`, options)).rejects.toMatchObject({ code: "image_too_large" });
    await expect(downloadResult(`${fake.url}/big-declared`, options)).rejects.toMatchObject({ code: "image_too_large" });
    await expect(downloadResult(`${fake.url}/big`, { allowedOrigins: [fake.origin] })).resolves.toMatchObject({
      data: expect.any(Buffer),
    });
  });

  it("refuses redirects and reports missing files", async () => {
    const options = { allowedOrigins: [fake.origin] };
    await expect(downloadResult(`${fake.url}/redirect`, options)).rejects.toMatchObject({ code: "download_failed" });
    const missing = await downloadResult(`${fake.url}/getscreenshot-storage/imageMISSING000.png`, options).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: "download_failed", httpStatus: 404 });
    expect((missing as Error).message).toMatch(/expired/);
  });
});
