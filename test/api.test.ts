import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GetScreenshotClient,
  GetScreenshotError,
  buildCaptureParams,
  buildPdfParams,
  isPrivateHostname,
  mapApiError,
  parseCapturedAt,
  validateTargetUrl,
  type CaptureInput,
  type GetScreenshotErrorCode,
} from "../src/api.js";
import { VERSION } from "../src/version.js";
import {
  DISABLED_KEY,
  EXHAUSTED_KEY,
  FLAKY_KEY,
  GOOD_KEY,
  INVALID_KEY,
  RATE_LIMITED_KEY,
  USAGE_UNKNOWN_KEY,
  startFakeUpstream,
  type FakeUpstream,
} from "./helpers/fake-upstream.js";

let fake: FakeUpstream;

beforeAll(async () => {
  fake = await startFakeUpstream();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

function client(apiKey = GOOD_KEY, extra: Partial<ConstructorParameters<typeof GetScreenshotClient>[0]> = {}) {
  return new GetScreenshotClient({ apiKey, baseUrl: fake.url, retryBaseMs: 2, ...extra });
}

async function failure(promise: Promise<unknown>): Promise<GetScreenshotError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(GetScreenshotError);
    return err as GetScreenshotError;
  }
  throw new Error("expected the call to fail");
}

describe("query-string mapping (as received by the API)", () => {
  const cases: Array<{ name: string; input: CaptureInput; expected: Record<string, string> }> = [
    {
      name: "url only sends nothing else",
      input: { url: "https://example.com" },
      expected: { url: "https://example.com" },
    },
    {
      name: "every option, no device",
      input: {
        url: "https://example.com/pricing?plan=pro&x=1#top",
        full_page: true,
        element: "#pricing .card",
        width: 1440,
        height: 900,
        scale: 2,
        format: "jpeg",
        wait_until: "domcontentloaded",
        wait_ms: 1500,
        hide_selectors: ".popup, #ad",
        hide_cookie_banners: false,
        hide_chat_widgets: true,
        click: "button.menu",
        custom_css: "body{background:#fff}",
        custom_js: "document.title='x'",
        highlight: "pricing",
        cookie: { name: "flag", value: "on" },
        lang: "de-DE",
        transparent_background: true,
        full_page_strategy: 2,
      },
      expected: {
        url: "https://example.com/pricing?plan=pro&x=1#top",
        fullpage: "true",
        element: "#pricing .card",
        width: "1440",
        height: "900",
        devicefactor: "2",
        format: "jpeg",
        waituntil: "domcontentloaded",
        timewait: "1500",
        hideelement: ".popup, #ad",
        hidecookie: "false",
        hidemsg: "true",
        click: "button.menu",
        customcss: "body{background:#fff}",
        customjs: "document.title='x'",
        highlight: "pricing",
        cookie: "flag,on",
        lang: "de-DE",
        forcetr: "true",
        strategy: "2",
      },
    },
    {
      name: "device + full_page becomes preset + noheight, never fullpage, and drops width/height",
      input: { url: "https://example.com", device: "iphone12", full_page: true, width: 1440, height: 900 },
      expected: { url: "https://example.com", preset: "iphone12", noheight: "true" },
    },
    {
      name: "device without full_page sends only the preset",
      input: { url: "https://example.com", device: "ipad", full_page: false },
      expected: { url: "https://example.com", preset: "ipad" },
    },
    {
      name: "values equal to the API defaults are not sent",
      input: {
        url: "https://example.com",
        full_page: false,
        scale: 1,
        format: "png",
        hide_cookie_banners: true,
        hide_chat_widgets: false,
        transparent_background: false,
        full_page_strategy: 0,
      },
      expected: { url: "https://example.com" },
    },
    {
      name: "undefined and empty values are not sent",
      input: {
        url: "https://example.com",
        element: undefined,
        hide_selectors: "",
        click: "   ",
        custom_css: "",
        custom_js: undefined,
        highlight: "",
        lang: "",
        width: undefined,
        wait_ms: undefined,
        cookie: undefined,
      },
      expected: { url: "https://example.com" },
    },
    {
      name: "wait_ms 0 is sent as 1 because the API treats 0 as unset",
      input: { url: "https://example.com", wait_ms: 0 },
      expected: { url: "https://example.com", timewait: "1" },
    },
    {
      name: "non-ASCII and reserved characters survive the round trip",
      input: { url: "https://example.com/café?q=a b&r=1+1", hide_selectors: 'a[href="/x?y=1&z=2"]' },
      expected: { url: "https://example.com/café?q=a b&r=1+1", hideelement: 'a[href="/x?y=1&z=2"]' },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      await client().capture(testCase.input);
      const [request] = fake.captures();
      expect(request?.params).toEqual({ apikey: GOOD_KEY, ...testCase.expected });
      // Pure builder agrees with what went over the wire.
      expect(Object.fromEntries(buildCaptureParams(testCase.input))).toEqual(testCase.expected);
    });
  }

  it("never sends retired or internal parameters", async () => {
    await client().capture({ url: "https://example.com", full_page: true, device: "pixel2" });
    const sent = Object.keys(fake.captures()[0]?.params ?? {});
    for (const forbidden of ["aiprompt", "filenameprefix", "fullpagebyel", "pflag", "customstorage", "rwobject", "zapier_webhook", "encodedurl", "email", "webhook", "bplogin", "fullpage"]) {
      expect(sent).not.toContain(forbidden);
    }
  });

  it("maps capture_pdf input", async () => {
    const result = await client().capturePdf({
      url: "https://example.com/report",
      wait_until: "load",
      wait_ms: 500,
      hide_selectors: "nav",
      custom_css: "@page{margin:0}",
    });
    expect(fake.captures()[0]?.params).toEqual({
      apikey: GOOD_KEY,
      url: "https://example.com/report",
      pdf: "true",
      waituntil: "load",
      timewait: "500",
      hideelement: "nav",
      customcss: "@page{margin:0}",
    });
    expect(result.pdfUrl).toMatch(/\/getscreenshot-storage\/pdf[A-Za-z0-9]{10}\.pdf$/);
    expect(Object.fromEntries(buildPdfParams({ url: "https://example.com" }))).toEqual({
      url: "https://example.com",
      pdf: "true",
    });
  });

  it("calls /v1/usage with a non-empty email and derives the remaining count", async () => {
    const usage = await client().usage();
    const request = fake.requests.find((r) => r.path === "/v1/usage");
    expect(Object.keys(request?.params ?? {}).sort()).toEqual(["apikey", "email"]);
    expect(request?.params.email).not.toBe("");
    expect(usage).toEqual({ used: 123, limit: 6000, remaining: 5877, period: "MONTH", quotaRestartDate: "2026-12-01" });
  });

  it("uses GET with the package User-Agent and trims the key", async () => {
    await client(`  ${GOOD_KEY}\n`).capture({ url: "https://example.com" });
    const request = fake.captures()[0];
    expect(request?.method).toBe("GET");
    expect(request?.headers["user-agent"]).toBe(`getscreenshot-mcp/${VERSION}`);
    expect(request?.params.apikey).toBe(GOOD_KEY);
  });

  it("parses the success body", async () => {
    const result = await client().capture({ url: "https://example.com/status404" });
    expect(result.screenshotUrl).toMatch(/\/getscreenshot-storage\/image[A-Za-z0-9]{10}\.png$/);
    expect(result.originUrl).toBe("https://example.com/status404");
    expect(result.pageStatus).toBe(404);
    expect(result.format).toBe("png");
    expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("error table", () => {
  interface Row {
    name: string;
    call: () => Promise<unknown>;
    code: GetScreenshotErrorCode;
    http: number;
    message: RegExp[];
    counted: boolean;
    requests: number;
  }
  const rows: Row[] = [
    {
      name: "500 + x-amzn-errortype AuthorizerConfigurationException = unknown key",
      call: () => client(INVALID_KEY).capture({ url: "https://example.com" }),
      code: "invalid_api_key",
      http: 500,
      // This error type can also be a transient gateway fault, so the advice is "retry once if sure".
      message: [/does not recognise this API key/, /GETSCREENSHOT_API_KEY/, /getscreenshotapi\.com\/account/, /If you are sure the key is correct, retry once/],
      counted: false,
      requests: 1,
    },
    {
      name: "a key the gateway has never seen gets the same answer",
      call: () => client("some-key-nobody-issued").capture({ url: "https://example.com" }),
      code: "invalid_api_key",
      http: 500,
      message: [/does not recognise this API key/],
      counted: false,
      requests: 1,
    },
    {
      name: '403 {"message":"Forbidden"} = disabled key',
      call: () => client(DISABLED_KEY).capture({ url: "https://example.com" }),
      code: "key_disabled",
      http: 403,
      message: [/disabled/, /subscription was cancelled or a payment failed/, /getscreenshotapi\.com\/account/],
      counted: false,
      requests: 1,
    },
    {
      name: '429 {"message":"Limit Exceeded"} = quota used up, not retried',
      call: () => client(EXHAUSTED_KEY).capture({ url: "https://example.com" }),
      code: "quota_exhausted",
      http: 429,
      message: [/monthly screenshot quota/i, /https:\/\/www\.getscreenshotapi\.com\/#pricing/, /Retrying will not help/],
      counted: false,
      requests: 1,
    },
    {
      name: '429 {"message":"Too Many Requests"} = rate limited after 2 retries',
      call: () => client(RATE_LIMITED_KEY).capture({ url: "https://example.com" }),
      code: "rate_limited",
      http: 429,
      message: [/rate limiting/, /after 3 attempts/, /fewer captures in parallel/],
      counted: false,
      requests: 3,
    },
    {
      name: "400 Bad posture = invalid url",
      call: () => client().capture({ url: "not a url" }, { skipUrlCheck: true }),
      code: "invalid_url",
      http: 400,
      message: [/rejected the `url`/, /http:\/\/ or https:\/\//],
      counted: true,
      requests: 1,
    },
    {
      name: "403 denied = shortener or blocked domain",
      call: () => client().capture({ url: "https://bit.ly/abc" }),
      code: "url_blocked",
      http: 403,
      message: [/shorteners/, /final destination URL/],
      counted: true,
      requests: 1,
    },
    {
      name: "500 failed = page did not load, suggests domcontentloaded, not retried",
      call: () => client().capture({ url: "https://slow.example.com" }),
      code: "page_load_failed",
      http: 500,
      message: [/did not finish loading/, /wait_until: "domcontentloaded"/],
      counted: true,
      requests: 1,
    },
    {
      name: "500 plain text with element = selector matched nothing",
      call: () => client().capture({ url: "https://example.com", element: "#missing" }),
      code: "capture_crashed",
      http: 500,
      message: [/`element` selector "#missing" probably matched nothing/],
      counted: true,
      requests: 1,
    },
    {
      name: "500 plain text with click = click selector",
      call: () => client().capture({ url: "https://example.com", click: "#missing" }),
      code: "capture_crashed",
      http: 500,
      message: [/`click` selector "#missing" probably matched nothing/],
      counted: true,
      requests: 1,
    },
    {
      // Neither the MCP schema nor the CLI lets an invalid preset through, so a device is never blamed.
      name: "500 plain text with only a device = generic crash advice, the preset is not blamed",
      call: () => client().capture({ url: "https://crash.example.com", device: "ipad" }),
      code: "capture_crashed",
      http: 500,
      message: [/crashed inside the browser/, /^(?!.*preset)/s],
      counted: true,
      requests: 1,
    },
    {
      name: "500 plain text with no selector = generic crash advice",
      call: () => client().capture({ url: "https://crash.example.com" }),
      code: "capture_crashed",
      http: 500,
      message: [/crashed inside the browser/, /domcontentloaded/],
      counted: true,
      requests: 1,
    },
    {
      name: "504 = took longer than 90 s, not retried",
      call: () => client().capture({ url: "https://timeout.example.com" }),
      code: "gateway_timeout",
      http: 504,
      message: [/90 second limit/, /domcontentloaded/],
      counted: true,
      requests: 1,
    },
    {
      name: "anything else = unexpected response with a body snippet, not retried",
      call: () => client().capture({ url: "https://weird.example.com" }),
      code: "unexpected_response",
      http: 502,
      message: [/HTTP 502/, /Bad Gateway/],
      counted: true,
      requests: 1,
    },
    {
      name: 'usage 400 {"message":"Invalid API key"}',
      call: () => client(USAGE_UNKNOWN_KEY).usage(),
      code: "invalid_api_key",
      http: 400,
      message: [/does not recognise this API key/, /Retrying with the same key will not help/],
      counted: false,
      requests: 1,
    },
  ];

  for (const row of rows) {
    it(row.name, async () => {
      const err = await failure(row.call());
      expect(err.code).toBe(row.code);
      expect(err.httpStatus).toBe(row.http);
      for (const pattern of row.message) expect(err.message).toMatch(pattern);
      expect(err.countedAgainstQuota).toBe(row.counted);
      if (row.counted && row.code !== "unexpected_response") expect(err.message).toMatch(/still counted as 1 screenshot against the monthly quota/);
      expect(fake.requests.length).toBe(row.requests);
      // No error message may ever carry the key.
      for (const key of [GOOD_KEY, INVALID_KEY, DISABLED_KEY, EXHAUSTED_KEY, RATE_LIMITED_KEY]) {
        expect(err.message).not.toContain(key);
      }
    });
  }

  it('401 {"message":"Unauthorized"} = key did not reach the API', async () => {
    // The client refuses to call without a key, so strip it on the wire to reach the API's 401.
    const stripKey: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      url.searchParams.delete("apikey");
      return fetch(url, init);
    };
    const err = await failure(client(GOOD_KEY, { fetchImpl: stripKey }).capture({ url: "https://example.com" }));
    expect(err.code).toBe("missing_api_key");
    expect(err.httpStatus).toBe(401);
    expect(err.message).toMatch(/did not receive an API key/);
    expect(err.message).toMatch(/https:\/\/www\.getscreenshotapi\.com\/#pricing/);
  });

  it("mapApiError handles each row from raw status, headers and body", () => {
    const h = (entries: Record<string, string> = {}) => new Headers(entries);
    const ctx = { endpoint: "capture" as const };
    const table: Array<[number, Headers, string, GetScreenshotErrorCode]> = [
      [401, h(), '{"message":"Unauthorized"}', "missing_api_key"],
      [500, h({ "x-amzn-errortype": "AuthorizerConfigurationException" }), '{"message": "error"}', "invalid_api_key"],
      [500, h({ "X-Amzn-ErrorType": "AuthorizerConfigurationException:http://internal/" }), '{"message": "error"}', "invalid_api_key"],
      [403, h(), '{"message":"Forbidden"}', "key_disabled"],
      [429, h(), '{"message":"Limit Exceeded"}', "quota_exhausted"],
      [429, h(), '{"message":"Too Many Requests"}', "rate_limited"],
      [400, h(), '{"status":"denied","message":"Bad posture."}', "invalid_url"],
      [403, h(), '{"status":"denied","message":"Access denied - URL not allowed (shortener or blocked domain)"}', "url_blocked"],
      [500, h(), '{"status":"failed","message":"Could not load the target page within the time limit. ..."}', "page_load_failed"],
      [500, h(), "Internal Server Error", "capture_crashed"],
      [504, h(), '{"message": "error"}', "gateway_timeout"],
      [400, h(), '{"status":"failed","message":"The passed URL is not in the correct format."}', "capture_failed"],
      [500, h(), '{"message": "error"}', "unexpected_response"],
      [400, h(), '{"message":"Email parameter is required"}', "unexpected_response"],
    ];
    for (const [status, headers, body, code] of table) {
      expect(mapApiError(status, headers, body, ctx).code, `${status} ${body}`).toBe(code);
    }
  });

  it("page-load advice changes when domcontentloaded was already used", async () => {
    const err = await failure(client().capture({ url: "https://slow.example.com", wait_until: "domcontentloaded" }));
    expect(err.code).toBe("page_load_failed");
    expect(err.message).toMatch(/already used wait_until: "domcontentloaded"/);
  });

  it("retries 429 Too Many Requests and then succeeds", async () => {
    const result = await client(FLAKY_KEY).capture({ url: "https://example.com" });
    expect(result.screenshotUrl).toContain("/getscreenshot-storage/image");
    expect(fake.captures().length).toBe(3);
  });

  it("backs off with jitter between rate-limit retries", async () => {
    const started = Date.now();
    // random() = 1 gives the top of the jitter range: 40*1.5 + 80*1.5 = 180 ms.
    await client(FLAKY_KEY, { retryBaseMs: 40, random: () => 0.999 }).capture({ url: "https://example.com" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(170);
  });

  it("refuses to call the API without a key and explains how to get one", async () => {
    const err = await failure(client("   ").capture({ url: "https://example.com" }));
    expect(err.code).toBe("no_api_key");
    expect(err.message).toMatch(/https:\/\/www\.getscreenshotapi\.com\/#pricing/);
    expect(err.message).toMatch(/FREE5/);
    expect(err.message).toMatch(/GETSCREENSHOT_API_KEY/);
    expect(err.message).toMatch(/Authorization: Bearer/);
    expect(fake.requests.length).toBe(0);
  });

  it("rejects localhost and private URLs before spending quota", async () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:8080/x", "http://192.168.1.10/", "http://10.0.0.5", "http://172.20.1.1", "http://[::1]:3000/", "http://dev.local/", "http://169.254.169.254/latest"]) {
      const err = await failure(client().capture({ url }));
      expect(err.code, url).toBe("private_url");
      expect(err.message).toMatch(/render_html/);
      expect(err.message).toMatch(/no quota was used/);
    }
    for (const url of ["example.com", "ftp://example.com/file", "file:///etc/passwd", ""]) {
      const err = await failure(client().capture({ url }));
      expect(err.code, url).toBe("invalid_url");
    }
    expect(fake.requests.length).toBe(0);
    expect(validateTargetUrl("https://example.com/a").hostname).toBe("example.com");
  });

  it("applies the private ranges to IP literals only, so public names that start with digits pass", () => {
    const publicHosts = [
      "example.com", "10.com", "10.example.org", "127.news", "127.0.0.1.example.com", "169.254.co", "192.168.example.com",
      "172.16.example.net", "0.0.0.0.example", "fc00.example", "fe80.io", "localhost.example.com", "notlocalhost",
      "internal.example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "100.63.0.1", "100.128.0.1", "1.2.3.4",
      "[2001:4860:4860::8888]", "[2606:4700::1111]", "[::ffff:8.8.8.8]",
    ];
    for (const host of publicHosts) {
      expect(isPrivateHostname(host), host).toBe(false);
      expect(() => validateTargetUrl(`https://${host}/`), host).not.toThrow();
    }
    const privateHosts = [
      "localhost", "LOCALHOST", "localhost.", "app.localhost", "printer.local", "db.internal", "metadata.google.internal",
      "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "192.168.0.1", "172.16.0.1", "172.31.255.255",
      "169.254.169.254", "0.0.0.0", "100.64.0.1",
      "[::1]", "[::]", "[fc00::1]", "[fd12:3456:789a::1]", "[fe80::1]", "[febf::1]", "[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]",
      "[::ffff:169.254.169.254]",
    ];
    for (const host of privateHosts) {
      expect(isPrivateHostname(host), host).toBe(true);
      expect(() => validateTargetUrl(`http://${host}/`), host).toThrow(/localhost or private-network/);
    }
    // Other spellings of a loopback address are normalised by URL parsing before the check.
    for (const url of ["http://2130706433/", "http://0x7f.1/", "http://127.1/", "http://[0:0:0:0:0:0:0:1]/"]) {
      expect(() => validateTargetUrl(url), url).toThrow(/localhost or private-network/);
    }
  });

  it("reports a network failure without leaking the key", async () => {
    const dead = new GetScreenshotClient({ apiKey: GOOD_KEY, baseUrl: "http://127.0.0.1:9" });
    const err = await failure(dead.capture({ url: "https://example.com" }));
    expect(err.code).toBe("network_error");
    expect(err.message).toMatch(/Could not reach the GetScreenshot API at 127\.0\.0\.1:9/);
    expect(err.message).not.toContain(GOOD_KEY);
  });

  it("times out on the client side", async () => {
    fake.delayMs = 400;
    const err = await failure(client(GOOD_KEY, { timeoutMs: 60 }).capture({ url: "https://example.com" }));
    expect(err.code).toBe("client_timeout");
    expect(err.countedAgainstQuota).toBe(true);
  });

  it("stops when the caller aborts", async () => {
    fake.delayMs = 400;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const err = await failure(client().capture({ url: "https://example.com" }, { signal: controller.signal }));
    expect(err.code).toBe("cancelled");
  });
});

describe("parseCapturedAt", () => {
  it("combines the API's UTC date and hour", () => {
    expect(parseCapturedAt("2026/11/18", "14:03:22")).toBe("2026-11-18T14:03:22Z");
    expect(parseCapturedAt("2026/1/5", "4:03")).toBe("2026-01-05T04:03:00Z");
    expect(parseCapturedAt(undefined, "14:03:22")).toBeNull();
    expect(parseCapturedAt("yesterday", "noon")).toBeNull();
  });
});
