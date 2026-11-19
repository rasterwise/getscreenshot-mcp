/**
 * Hosted mode: the real HTTP server on an ephemeral port, driven by the SDK's
 * Streamable HTTP client, by plain fetch, and by raw sockets for the things a
 * well-behaved client never sends.
 */
import { connect as connectSocket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HTML_MAX_BYTES, MemoryHtmlStore } from "../src/html-store.js";
import {
  MCP_MAX_BODY_BYTES,
  clientIp,
  extractApiKey,
  httpOptionsFromEnv,
  parseRequestTarget,
  startHttpServer,
  type HttpServerOptions,
  type RunningHttpServer,
} from "../src/http.js";
import { VERSION } from "../src/version.js";
import { GOOD_KEY, INVALID_KEY, TRIAL_KEY, startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.js";

let fake: FakeUpstream;
let app: RunningHttpServer;
const logs: string[] = [];
const cleanup: Array<() => Promise<unknown>> = [];

async function start(options: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const server = await startHttpServer({
    port: 0,
    host: "127.0.0.1",
    apiBase: fake.url,
    log: (line) => logs.push(line),
    retryBaseMs: 2,
    ...options,
  });
  return server;
}

/** A server that is closed after the test. */
async function temp(options: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const server = await start(options);
  cleanup.push(() => server.close());
  return server;
}

beforeAll(async () => {
  fake = await startFakeUpstream();
  // Generous limits: the shared server is used by many tests within one minute.
  app = await start({ rateLimitPerMinute: 10_000, rateLimitPerIpPerMinute: 10_000, htmlUploadsPerMinutePerIp: 10_000 });
});
afterAll(async () => {
  await app.close();
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  logs.length = 0;
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn().catch(() => undefined);
});

interface ConnectOptions {
  headers?: Record<string, string>;
  query?: string;
}

async function connect(server: RunningHttpServer, options: ConnectOptions = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp${options.query ?? ""}`), {
    requestInit: { headers: options.headers ?? {} },
  });
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return client;
}

type Result = CallToolResult & { structuredContent?: Record<string, any> };
const capture = async (client: Client, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name: "capture_screenshot", arguments: { url: "https://example.com", ...args } })) as Result;
const textOf = (result: Result) => (result.content[0]?.type === "text" ? result.content[0].text : "");
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
const documents = (server: RunningHttpServer) => (server.store as MemoryHtmlStore).size;

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const rpcCall = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

/** Sends raw bytes and returns what came back until the server closed the connection (or a timeout). */
function raw(server: RunningHttpServer, payload: string, waitMs = 1500): Promise<{ response: string; closedAfterMs: number | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let response = "";
    let done = false;
    const finish = (closedAfterMs: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ response, closedAfterMs });
    };
    const socket = connectSocket(server.port, "127.0.0.1", () => socket.write(payload));
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("close", () => finish(Date.now() - started));
    socket.on("error", () => finish(Date.now() - started));
    const timer = setTimeout(() => finish(null), waitMs);
  });
}
const statusLine = (response: string) => response.split("\r\n")[0] ?? "";

describe("plain routes", () => {
  it("GET /health answers like /healthz, because Cloud Run never forwards /healthz", async () => {
    const res = await fetch(`${app.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: VERSION });
    expect((await fetch(`${app.url}/health`, { method: "POST" })).status).toBe(404);
  });

  it("GET /healthz", async () => {
    const res = await fetch(`${app.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: VERSION });
  });

  it("GET / redirects to the agents page", async () => {
    const res = await fetch(`${app.url}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://www.getscreenshotapi.com/agents/");
  });

  it("GET and DELETE /mcp answer 405 with an Allow header", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await fetch(`${app.url}/mcp`, { method, headers: { Accept: "text/event-stream" } });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("POST, OPTIONS");
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/stateless/);
    }
  });

  it("answers CORS preflight on /mcp and sets CORS headers on responses", async () => {
    const preflight = await fetch(`${app.url}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toMatch(/POST/);
    const allowed = preflight.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
    for (const header of ["authorization", "content-type", "x-api-key", "mcp-protocol-version", "mcp-session-id"]) {
      expect(allowed).toContain(header);
    }

    const post = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Origin: "https://app.example" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
      }),
    });
    expect(post.status).toBe(200);
    expect(post.headers.get("access-control-allow-origin")).toBe("*");
    // Stateless: no session is issued.
    expect(post.headers.get("mcp-session-id")).toBeNull();
    expect(await post.text()).toMatch(/"name":"getscreenshot"/);
  });

  it("unknown paths are 404", async () => {
    expect((await fetch(`${app.url}/nope`)).status).toBe(404);
    expect((await fetch(`${app.url}/healthz`, { method: "POST" })).status).toBe(404);
  });

  it("rejects an oversized MCP body with 413", async () => {
    const res = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MCP_MAX_BODY_BYTES) } }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/larger than/);
  });

  it("rejects a body that is not JSON with a JSON-RPC parse error", async () => {
    const res = await fetch(`${app.url}/mcp`, { method: "POST", headers: JSON_HEADERS, body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 }, id: null });
  });
});

describe("malformed request targets (F1)", () => {
  // Each of these made `new URL(req.url, base)` throw inside the request listener and killed the process.
  const hostile = ["//a:b", "//[", "http://[::1", "//x:99999/mcp", "//evil.example/mcp", "http://evil.example/mcp", "*", "mcp"];

  for (const target of hostile) {
    it(`answers 400 to ${JSON.stringify(target)} and keeps serving`, async () => {
      for (const method of ["GET", "POST"]) {
        const { response } = await raw(app, `${method} ${target} HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        expect(statusLine(response), `${method} ${target}`).toBe("HTTP/1.1 400 Bad Request");
      }
      expect((await fetch(`${app.url}/healthz`)).status).toBe(200);
    });
  }

  it("odd but parseable targets are ordinary 404s, and garbage request lines are 400s", async () => {
    for (const target of ["/%", "/h/%ZZ", "/h/%00", "/mcp%2f..%2f", "/?a=%ff"]) {
      const { response } = await raw(app, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      expect(statusLine(response), target).toMatch(/^HTTP\/1\.1 (302|404)/);
    }
    const garbage = await raw(app, "NOT A REQUEST\r\n\r\n");
    expect(statusLine(garbage.response)).toBe("HTTP/1.1 400 Bad Request");
    expect((await fetch(`${app.url}/healthz`)).status).toBe(200);
  });

  it("parseRequestTarget never throws", () => {
    for (const target of [...hostile, undefined, "", "//", "\u0000", "/\ud800"]) {
      expect(() => parseRequestTarget(target)).not.toThrow();
    }
    for (const target of hostile) expect(parseRequestTarget(target), target).toBeUndefined();
    expect(parseRequestTarget("/mcp?x=1")?.pathname).toBe("/mcp");
    expect(parseRequestTarget("/h/abc")?.pathname).toBe("/h/abc");
  });

  it("logs a malformed target without echoing it", async () => {
    await raw(app, "GET //secret-looking:port HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    const entry = JSON.parse(logs.at(-1)!) as Record<string, unknown>;
    expect(entry).toMatchObject({ msg: "request", status: 400, path: "(malformed)" });
    expect(logs.join("\n")).not.toContain("secret-looking");
  });
});

describe("MCP over Streamable HTTP", () => {
  it("lists tools and calls one with a Bearer key", async () => {
    const client = await connect(app, { headers: bearer(GOOD_KEY) });
    expect(client.getServerVersion()).toMatchObject({ name: "getscreenshot", version: VERSION });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["capture_screenshot", "render_html", "compare_screenshots", "capture_pdf", "get_usage"]);

    const result = await capture(client);
    expect(result.isError).toBeFalsy();
    expect(result.content.map((c) => c.type)).toEqual(["text", "image"]);
    const image = result.content[1] as { data: string; mimeType: string };
    expect(image.mimeType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1280, 800]);
    expect(result.structuredContent).toMatchObject({ page_status: 200, total_slices: 1 });
    expect(fake.captures()[0]!.params.apikey).toBe(GOOD_KEY);
  });

  it("reads the key from x-api-key", async () => {
    fake.allowKey("key-from-x-api-key-header");
    const client = await connect(app, { headers: { "x-api-key": "key-from-x-api-key-header" } });
    expect((await capture(client)).isError).toBeFalsy();
    expect(fake.captures()[0]!.params.apikey).toBe("key-from-x-api-key-header");
  });

  it("prefers Authorization over x-api-key", async () => {
    fake.allowKey("key-bearer-wins");
    const client = await connect(app, { headers: { Authorization: "Bearer key-bearer-wins", "x-api-key": GOOD_KEY } });
    expect((await capture(client)).isError).toBeFalsy();
    expect(fake.captures().map((r) => r.params.apikey)).toEqual(["key-bearer-wins"]);
  });

  it("does not accept a key in the query string (F8)", async () => {
    const client = await connect(app, { query: `?apikey=${GOOD_KEY}` });
    const result = await capture(client);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No GetScreenshot API key is configured/);
    expect(textOf(result)).toMatch(/Authorization: Bearer YOUR_API_KEY/);
    expect(fake.requests).toHaveLength(0);
    // The header still wins when both are present.
    const both = await connect(app, { query: "?apikey=ignored-key", headers: bearer(GOOD_KEY) });
    expect((await capture(both)).isError).toBeFalsy();
    expect(fake.captures()[0]!.params.apikey).toBe(GOOD_KEY);
  });

  it("an unrecognised key is told so by the API, not accepted", async () => {
    const client = await connect(app, { headers: bearer("made-up-key-123456") });
    const result = await capture(client);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does not recognise this API key/);
  });

  it("keeps concurrent callers' keys apart", async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `concurrent-key-${String(i).padStart(2, "0")}-abcdef`);
    for (const key of keys) fake.allowKey(key);
    fake.delayMs = 30;
    const results = await Promise.all(
      keys.map(async (key, i) => {
        const client = await connect(app, { headers: i % 2 === 0 ? bearer(key) : { "x-api-key": key } });
        return capture(client, { url: `https://example.com/caller-${i}` });
      }),
    );
    expect(results.every((r) => !r.isError)).toBe(true);
    const seen = fake.captures().map((r) => [r.params.url, r.params.apikey]);
    expect(seen).toHaveLength(keys.length);
    for (const [i, key] of keys.entries()) {
      expect(seen).toContainEqual([`https://example.com/caller-${i}`, key]);
      expect(results[i]!.structuredContent!.origin_url).toBe(`https://example.com/caller-${i}`);
    }
  });

  it("without a key it still connects and lists tools (no 401); tools explain how to get a key", async () => {
    const client = await connect(app);
    expect((await client.listTools()).tools).toHaveLength(5);
    const result = await capture(client);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No GetScreenshot API key is configured/);
    expect(textOf(result)).toMatch(/https:\/\/www\.getscreenshotapi\.com\/#pricing/);
    expect(textOf(result)).toMatch(/Authorization: Bearer YOUR_API_KEY/);
    expect(fake.requests).toHaveLength(0);

    const rawList = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(rawList.status).toBe(200);
  });

  it("render_html hosts the document on this server, the capture loads it, then it is deleted", async () => {
    const client = await connect(app, { headers: bearer(GOOD_KEY) });
    const html = "<main><h1>Hosted</h1></main>";
    const result = (await client.callTool({ name: "render_html", arguments: { html } })) as Result;
    expect(result.isError).toBeFalsy();
    const hostedUrl = fake.captures()[0]!.params.url!;
    expect(hostedUrl).toMatch(new RegExp(`^${app.htmlPublicBaseUrl}/h/[A-Za-z0-9_-]{43}$`));
    expect(fake.fetchedHtml[0]).toMatchObject({ status: 200, body: html });
    expect(result.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(documents(app)).toBe(0);
    expect((await fetch(hostedUrl)).status).toBe(404);
  });

  it("streams progress notifications over the POST response", async () => {
    const slow = await temp({ progressIntervalMs: 40 });
    const client = await connect(slow, { headers: bearer(GOOD_KEY) });
    fake.delayMs = 300;
    const seen: number[] = [];
    const result = (await client.callTool({ name: "capture_screenshot", arguments: { url: "https://example.com" } }, undefined, {
      onprogress: (p) => seen.push(p.progress),
    })) as Result;
    expect(result.isError).toBeFalsy();
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("logs one JSON line per request without keys, query strings or bodies", async () => {
    const secret = "sk-very-secret-key-000111222";
    fake.allowKey(secret);
    const client = await connect(app, { headers: bearer(secret), query: "?apikey=QUERY-SECRET&token=QUERY-TOKEN" });
    await client.callTool({ name: "render_html", arguments: { html: "<p>SECRET-HTML-BODY</p>" } });
    await fetch(`${app.url}/v1/html?note=QUERY-NOTE`, { method: "POST", headers: bearer(secret), body: "<p>SECRET-UPLOAD</p>" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(logs.length).toBeGreaterThanOrEqual(4);
    const entries = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const [i, line] of logs.entries()) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("QUERY-");
      expect(line).not.toContain("apikey");
      expect(line).not.toContain("SECRET-");
      expect(line.includes("\n")).toBe(false);
      expect(entries[i]).toMatchObject({ msg: "request", ts: expect.any(String), status: expect.any(Number), ms: expect.any(Number) });
    }
    const toolCall = entries.find((e) => e.tool === "render_html");
    expect(toolCall).toMatchObject({ method: "POST", path: "/mcp", status: 200, auth: "key", key_source: "bearer", tool_ok: true });
    // The id of a hosted document never reaches the log.
    const read = entries.find((e) => e.method === "GET" && String(e.path).startsWith("/h/"));
    expect(read?.path).toBe("/h/:id");
    expect(entries.find((e) => e.path === "/v1/html")).toMatchObject({ status: 200, auth: "key", key_source: "bearer" });
  });
});

describe("one JSON-RPC message per POST (F2)", () => {
  it("rejects a batch with a JSON-RPC error and runs none of it", async () => {
    const batch = Array.from({ length: 30 }, (_, i) => rpcCall(i + 1, "capture_screenshot", { url: `https://example.com/${i}` }));
    const res = await fetch(`${app.url}/mcp`, { method: "POST", headers: { ...JSON_HEADERS, ...bearer(GOOD_KEY) }, body: JSON.stringify(batch) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "JSON-RPC batches are not supported. Send one request per POST." },
      id: null,
    });
    expect(fake.requests).toHaveLength(0);
    // An empty batch and a batch of one are batches too.
    for (const body of ["[]", JSON.stringify([rpcCall(1, "get_usage", {})])]) {
      const again = await fetch(`${app.url}/mcp`, { method: "POST", headers: { ...JSON_HEADERS, ...bearer(GOOD_KEY) }, body });
      expect(again.status).toBe(400);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("a single request in the same shape works", async () => {
    const res = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...bearer(GOOD_KEY) },
      body: JSON.stringify(rpcCall(7, "get_usage", {})),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/"used":123/);
  });
});

describe("per-caller rate limit on tool calls (F2)", () => {
  it("limits a key to N calls per minute and tells it when to retry", async () => {
    const server = await temp({ rateLimitPerMinute: 3, rateLimitPerIpPerMinute: 100 });
    const client = await connect(server, { headers: bearer(GOOD_KEY) });
    for (let i = 0; i < 3; i++) expect((await capture(client)).isError, `call ${i + 1}`).toBeFalsy();
    const fourth = await capture(client);
    expect(fourth.isError).toBe(true);
    expect(textOf(fourth)).toMatch(/Too many tool calls in the last minute/);
    expect(textOf(fourth)).toMatch(/Wait about \d+ seconds, then retry/);
    expect(textOf(fourth)).toMatch(/no quota was used/);
    expect(fake.captures()).toHaveLength(3);
    // A new connection with the same key is the same caller; listing tools is not a tool call.
    const again = await connect(server, { headers: bearer(GOOD_KEY) });
    expect((await again.listTools()).tools).toHaveLength(5);
    expect((await capture(again)).isError).toBe(true);
    // The limit is per key, so another key is unaffected.
    fake.allowKey("another-valid-key-0001");
    expect((await capture(await connect(server, { headers: bearer("another-valid-key-0001") }))).isError).toBeFalsy();
    const entry = logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.tool_error === "server_rate_limited");
    expect(entry).toMatchObject({ tool: "capture_screenshot", tool_ok: false });
  });

  it("resets with the next minute", async () => {
    let now = Date.UTC(2026, 10, 18, 12, 0, 5);
    const server = await temp({ rateLimitPerMinute: 1, now: () => now });
    const client = await connect(server, { headers: bearer(GOOD_KEY) });
    expect((await capture(client)).isError).toBeFalsy();
    const refused = await capture(client);
    expect(textOf(refused)).toMatch(/Wait about 55 seconds/);
    now += 55_000;
    expect((await capture(client)).isError).toBeFalsy();
  });

  it("inventing a new key for every call does not get around it: the address is limited too", async () => {
    const server = await temp({ rateLimitPerMinute: 60, rateLimitPerIpPerMinute: 4 });
    const from = { "X-Forwarded-For": "203.0.113.77" };
    const outcomes: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const client = await connect(server, { headers: { ...bearer(`invented-key-${i}-000000`), ...from } });
      const result = (await client.callTool({ name: "get_usage", arguments: {} })) as Result;
      outcomes.push(/Too many tool calls/.test(textOf(result)));
    }
    expect(outcomes).toEqual([false, false, false, false, true, true]);
    // Only four calls ever reached the API (which rejected those made-up keys).
    expect(fake.requests).toHaveLength(4);
    // Another address is not affected.
    const other = await connect(server, { headers: { ...bearer(GOOD_KEY), "X-Forwarded-For": "198.51.100.5" } });
    expect((await capture(other)).isError).toBeFalsy();
  });

  it("keyless callers are limited by address, IPv6 by its /64", async () => {
    const server = await temp({ rateLimitPerMinute: 2 });
    const call = async (ip: string) => textOf(await capture(await connect(server, { headers: { "X-Forwarded-For": ip } })));
    expect(await call("2001:db8:aa:bb::1")).toMatch(/No GetScreenshot API key/);
    expect(await call("2001:db8:aa:bb:1234:5678:9abc:def0")).toMatch(/No GetScreenshot API key/);
    // Third call from the same /64, from yet another address in it.
    expect(await call("2001:db8:aa:bb:ffff::2")).toMatch(/Too many tool calls/);
    expect(await call("2001:db8:aa:cc::1")).toMatch(/No GetScreenshot API key/);
  });

  it("applies the documented defaults", () => {
    expect(httpOptionsFromEnv({})).toMatchObject({ rateLimitPerMinute: 60, rateLimitPerIpPerMinute: 120 });
    expect(httpOptionsFromEnv({ RATE_LIMIT_PER_MINUTE: "10", RATE_LIMIT_PER_IP_PER_MINUTE: "25" })).toMatchObject({
      rateLimitPerMinute: 10,
      rateLimitPerIpPerMinute: 25,
    });
  });
});

describe("image work is gated (F2/F3)", () => {
  it("a burst of compares with a made-up key never runs more than the configured jobs at once", async () => {
    // The reviewer's scenario: compare_screenshots with two screenshot_url sides never calls the
    // API, so the key is never checked. It must still be bounded.
    const server = await temp({ imageConcurrency: 2, imageQueueMax: 4, imageQueueWaitMs: 20_000, rateLimitPerMinute: 1000, rateLimitPerIpPerMinute: 1000 });
    const seed = async (path: string) => {
      const res = await fetch(`${fake.url}/v1/get-screenshot?apikey=${GOOD_KEY}&url=${encodeURIComponent(`https://example.com/${path}`)}&fullpage=true`);
      return ((await res.json()) as { screenshotImage: string }).screenshotImage;
    };
    const args = { before: { screenshot_url: await seed("") }, after: { screenshot_url: await seed("changed") } };
    fake.reset();

    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, server.imageGate.running)), 1);
    const responses = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const res = await fetch(`${server.url}/mcp`, {
          method: "POST",
          headers: { ...JSON_HEADERS, ...bearer("not-a-real-key") },
          body: JSON.stringify(rpcCall(i + 1, "compare_screenshots", args)),
        });
        const text = await res.text();
        return /server is busy/.test(text) ? "busy" : /changed_percent/.test(text) ? "ok" : `other: ${text.slice(0, 200)}`;
      }),
    );
    clearInterval(watch);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
    const ok = responses.filter((r) => r === "ok").length;
    const busy = responses.filter((r) => r === "busy").length;
    expect(ok + busy).toBe(30);
    // 2 running + 4 queued can be in the system at any moment; the rest of the burst is turned away.
    expect(ok).toBeGreaterThanOrEqual(6);
    expect(busy).toBeGreaterThan(0);
    expect(server.imageGate.running).toBe(0);
    expect(fake.captures()).toHaveLength(0);
  });

  it("reads the gate settings from the environment", () => {
    expect(httpOptionsFromEnv({})).toMatchObject({ imageConcurrency: 3, imageQueueMax: 24, imageQueueWaitMs: 20_000 });
    expect(httpOptionsFromEnv({ IMAGE_CONCURRENCY: "5", IMAGE_QUEUE_MAX: "0", IMAGE_QUEUE_WAIT_MS: "1500" })).toMatchObject({
      imageConcurrency: 5,
      imageQueueMax: 0,
      imageQueueWaitMs: 1500,
    });
    expect(httpOptionsFromEnv({ IMAGE_CONCURRENCY: "0" }).imageConcurrency).toBe(3);
  });
});

describe("POST /v1/html and /h/:id", () => {
  const upload = (
    body: string | Buffer,
    headers: Record<string, string> = bearer(GOOD_KEY),
    server: RunningHttpServer = app,
  ) => fetch(`${server.url}/v1/html`, { method: "POST", headers: { "Content-Type": "text/html", ...headers }, body });
  const urlOf = async (res: Response) => ((await res.json()) as { url: string }).url;

  it("requires a key header", async () => {
    const none = await upload("<p>x</p>", {});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/Bearer/);
    // The query string is not accepted.
    const query = await fetch(`${app.url}/v1/html?apikey=${GOOD_KEY}`, { method: "POST", body: "<p>x</p>" });
    expect(query.status).toBe(401);
    expect((await upload("<p>x</p>", { "x-api-key": GOOD_KEY })).status).toBe(200);
    expect((await fetch(`${app.url}/v1/html`)).status).toBe(405);
  });

  it("round trip: stores the HTML, serves it with safe headers, 3 reads only", async () => {
    const html = "<!doctype html><title>t</title><p>café ☃</p><script>1</script>";
    const res = await upload(html, bearer("round-trip-key-000001"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expires_in_seconds: number };
    expect(body.expires_in_seconds).toBe(300);
    expect(body.url).toMatch(new RegExp(`^${app.htmlPublicBaseUrl}/h/[A-Za-z0-9_-]{43}$`));

    for (let read = 1; read <= 3; read++) {
      const page = await fetch(body.url);
      expect(page.status, `read ${read}`).toBe(200);
      expect(await page.text()).toBe(html);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
      expect(page.headers.get("x-robots-tag")).toBe("noindex");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const fourth = await fetch(body.url);
    expect(fourth.status).toBe(404);
    expect(await fourth.text()).not.toContain("caf");
  });

  it("rejects bodies over 2 MB and empty bodies", async () => {
    expect((await upload(Buffer.alloc(HTML_MAX_BYTES + 1, 0x61), bearer("size-test-key-000001"))).status).toBe(413);
    expect((await upload(Buffer.alloc(HTML_MAX_BYTES, 0x61), bearer("size-test-key-000001"))).status).toBe(200);
    expect((await upload("", bearer("size-test-key-000001"))).status).toBe(400);
  });

  it("survives a grossly oversized upload", async () => {
    // Far past the limit the server stops reading and closes the connection, so the
    // client sees either the 413 or a broken connection. Either way nothing is stored.
    const before = documents(app);
    const outcome = await upload(Buffer.alloc(HTML_MAX_BYTES * 9, 0x61), bearer("oversize-key-0000001")).then(
      (res) => res.status,
      () => "connection closed",
    );
    expect([413, "connection closed"]).toContain(outcome);
    expect(documents(app)).toBe(before);
    expect((await fetch(`${app.url}/healthz`)).status).toBe(200);
    expect((await upload("<p>still works</p>", bearer("oversize-key-0000001"))).status).toBe(200);
  });

  it("404s unknown and malformed ids; other methods are 405", async () => {
    expect((await fetch(`${app.url}/h/${"A".repeat(43)}`)).status).toBe(404);
    expect((await fetch(`${app.url}/h/short`)).status).toBe(404);
    expect((await fetch(`${app.url}/h/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    const post = await fetch(`${app.url}/h/${"A".repeat(43)}`, { method: "POST", body: "x" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, DELETE");
  });

  it("DELETE removes a document, but only for the key that uploaded it", async () => {
    const owner = bearer("owner-key-0000000001");
    const url = await urlOf(await upload("<p>mine</p>", owner));
    expect((await fetch(url, { method: "DELETE" })).status).toBe(404); // no key
    expect((await fetch(url, { method: "DELETE", headers: bearer("someone-else-00000001") })).status).toBe(404);
    expect((await fetch(url)).status).toBe(200); // still there
    expect((await fetch(url, { method: "DELETE", headers: owner })).status).toBe(204);
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(url, { method: "DELETE", headers: owner })).status).toBe(404);
  });
});

describe("HTML store abuse limits (F5)", () => {
  const upload = (server: RunningHttpServer, key: string, ip = "203.0.113.10", body = "<p>x</p>") =>
    fetch(`${server.url}/v1/html`, { method: "POST", headers: { ...bearer(key), "X-Forwarded-For": ip }, body });

  it("caps live documents per caller", async () => {
    const server = await temp({ htmlMaxDocsPerCaller: 2 });
    expect((await upload(server, "caller-a-key-0000001")).status).toBe(200);
    const second = await upload(server, "caller-a-key-0000001");
    expect(second.status).toBe(200);
    const third = await upload(server, "caller-a-key-0000001");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
    expect(((await third.json()) as { error: string }).error).toMatch(/Too many temporary HTML documents.*limit 2/);
    // Another caller from another address is unaffected.
    expect((await upload(server, "caller-b-key-0000001", "198.51.100.20")).status).toBe(200);
    // Room opens as soon as one of the caller's documents is removed.
    const url = ((await second.json()) as { url: string }).url;
    expect((await fetch(url, { method: "DELETE", headers: bearer("caller-a-key-0000001") })).status).toBe(204);
    expect((await upload(server, "caller-a-key-0000001")).status).toBe(200);
  });

  it("making up a new key per upload does not help: the address has a cap too", async () => {
    const server = await temp({ htmlMaxDocsPerCaller: 2 }); // 2 per key, 8 per address
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await upload(server, `rotating-key-${i}-0000000`)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 429, 429, 429]);
    expect(documents(server)).toBe(8);
  });

  it("when the store is full it rejects the newcomer and keeps the documents that are there", async () => {
    const server = await temp({ store: new MemoryHtmlStore({ maxDocs: 3 }) });
    const victim = await upload(server, "victim-key-123456789", "192.0.2.1", "<h1>victim</h1>");
    const victimUrl = ((await victim.json()) as { url: string }).url;
    expect((await upload(server, "filler-key-1-0000000", "192.0.2.2")).status).toBe(200);
    expect((await upload(server, "filler-key-2-0000000", "192.0.2.3")).status).toBe(200);
    // The store is full. A flood of uploads from many addresses and keys is turned away...
    for (let i = 0; i < 20; i++) {
      const res = await upload(server, `flood-key-${i}-00000000`, `198.51.100.${i}`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/store is full right now/);
    }
    // ...and the victim's document, uploaded before the flood, is still served.
    const page = await fetch(victimUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>victim</h1>");
  });

  it("render_html through /mcp tells the model when the store is full, without using quota", async () => {
    const server = await temp({ store: new MemoryHtmlStore({ maxDocs: 1 }) });
    expect((await upload(server, "holder-key-000000001", "192.0.2.9")).status).toBe(200);
    const client = await connect(server, { headers: bearer(GOOD_KEY) });
    const result = (await client.callTool({ name: "render_html", arguments: { html: "<p>x</p>" } })) as Result;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/store is full right now.*no quota was used/s);
    expect(fake.captures()).toHaveLength(0);
  });

  it("render_html with an unrecognised key leaves nothing in the store", async () => {
    // The reviewer's scenario: 200 render_html calls with a key the API rejects used to leave
    // 200 documents behind and evict everyone else's.
    const server = await temp({ rateLimitPerMinute: 1000, rateLimitPerIpPerMinute: 1000, htmlUploadsPerMinutePerIp: 1000 });
    const victim = await upload(server, "victim-key-123456789", "192.0.2.1", "<h1>victim</h1>");
    const victimUrl = ((await victim.json()) as { url: string }).url;
    const client = await connect(server, { headers: bearer(INVALID_KEY) });
    const results = await Promise.all(
      Array.from({ length: 40 }, () => client.callTool({ name: "render_html", arguments: { html: "x" } }) as Promise<Result>),
    );
    expect(results.every((r) => r.isError)).toBe(true);
    const texts = results.map(textOf);
    // Each call was either rejected by the API (and its document removed) or by the per-caller cap.
    expect(texts.every((t) => /does not recognise this API key|Too many temporary HTML documents/.test(t))).toBe(true);
    expect(documents(server)).toBe(1);
    expect((await fetch(victimUrl)).status).toBe(200);
  });

  it("the upload rate limit also applies to render_html through /mcp, and is shared with POST /v1/html", async () => {
    const server = await temp({ htmlUploadsPerMinutePerIp: 3 });
    const from = "203.0.113.42";
    const client = await connect(server, { headers: { ...bearer(GOOD_KEY), "X-Forwarded-For": from } });
    const render = async () => (await client.callTool({ name: "render_html", arguments: { html: "<p>x</p>" } })) as Result;
    expect((await render()).isError).toBeFalsy();
    expect((await render()).isError).toBeFalsy();
    const third = await upload(server, GOOD_KEY, from);
    expect(third.status).toBe(200);
    const fourth = await render();
    expect(fourth.isError).toBe(true);
    expect(textOf(fourth)).toMatch(/Too many HTML uploads from this address/);
    expect(textOf(fourth)).toMatch(/No quota was used/);
    const fifth = await upload(server, GOOD_KEY, from);
    expect(fifth.status).toBe(429);
    expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fake.captures()).toHaveLength(2);
  });

  it("reads the per-caller cap from the environment", () => {
    expect(httpOptionsFromEnv({}).htmlMaxDocsPerCaller).toBe(5);
    expect(httpOptionsFromEnv({ HTML_MAX_DOCS_PER_CALLER: "9" }).htmlMaxDocsPerCaller).toBe(9);
  });
});

describe("request deadlines (F6)", () => {
  it("drops a request whose body trickles in too slowly", async () => {
    const server = await temp({ bodyTimeoutMs: 300 });
    for (const path of ["/v1/html", "/mcp"]) {
      const { response, closedAfterMs } = await raw(
        server,
        `POST ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${GOOD_KEY}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\nx`,
        5000,
      );
      // The server answered and closed the connection by itself, well before the test's own timeout.
      expect(closedAfterMs, path).not.toBeNull();
      expect(closedAfterMs!, path).toBeLessThan(2500);
      expect(closedAfterMs!, path).toBeGreaterThanOrEqual(250);
      expect(statusLine(response), path).toBe("HTTP/1.1 408 Request Timeout");
    }
    expect(documents(server)).toBe(0);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
  });

  it("does not charge the upload limiter for a body that never arrived", async () => {
    const server = await temp({ bodyTimeoutMs: 200, htmlUploadsPerMinutePerIp: 1 });
    for (let i = 0; i < 3; i++) {
      const stalled = await raw(server, `POST /v1/html HTTP/1.1\r\nHost: x\r\nx-api-key: ${GOOD_KEY}\r\nContent-Length: 500\r\n\r\nabc`, 4000);
      expect(statusLine(stalled.response)).toBe("HTTP/1.1 408 Request Timeout");
    }
    // The one upload this address is allowed per minute is still available.
    const real = await fetch(`${server.url}/v1/html`, { method: "POST", headers: bearer(GOOD_KEY), body: "<p>real</p>" });
    expect(real.status).toBe(200);
    expect((await fetch(`${server.url}/v1/html`, { method: "POST", headers: bearer(GOOD_KEY), body: "<p>second</p>" })).status).toBe(429);
  });

  it("drops a connection that never finishes its headers", async () => {
    const server = await temp({ bodyTimeoutMs: 300 });
    const { closedAfterMs } = await raw(server, "POST /mcp HTTP/1.1\r\nHost: x\r\nX-Slow: ", 5000);
    expect(closedAfterMs).not.toBeNull();
    expect(closedAfterMs!).toBeLessThan(3000);
  });

  it("sets Node's request timeouts to match", async () => {
    expect(app.server.requestTimeout).toBe(15_000);
    expect(app.server.headersTimeout).toBe(10_000);
    const quick = await temp({ bodyTimeoutMs: 400 });
    expect(quick.server.requestTimeout).toBe(400);
    expect(quick.server.headersTimeout).toBe(400);
  });

  it("the deadline is for receiving the request, not for answering it: a slow capture is not cut off", async () => {
    const server = await temp({ bodyTimeoutMs: 300 });
    const client = await connect(server, { headers: bearer(GOOD_KEY) });
    fake.delayMs = 1200; // four times the deadline
    const result = await capture(client);
    expect(result.isError).toBeFalsy();
    expect(result.content.map((c) => c.type)).toEqual(["text", "image"]);
  });

  it("a normal slow-ish body inside the deadline is accepted", async () => {
    const server = await temp({ bodyTimeoutMs: 1500 });
    const result = await new Promise<string>((resolve) => {
      let response = "";
      const html = "<p>slow but fine</p>";
      const socket = connectSocket(server.port, "127.0.0.1", () => {
        socket.write(`POST /v1/html HTTP/1.1\r\nHost: x\r\nx-api-key: ${GOOD_KEY}\r\nContent-Length: ${html.length}\r\nConnection: close\r\n\r\n`);
        setTimeout(() => socket.write(html.slice(0, 5)), 100);
        setTimeout(() => socket.write(html.slice(5)), 300);
      });
      socket.on("data", (chunk) => (response += chunk.toString()));
      socket.on("close", () => resolve(response));
    });
    expect(statusLine(result)).toBe("HTTP/1.1 200 OK");
  });
});

describe("separate HTML hostname (F7)", () => {
  it("builds /h/ links on HTML_PUBLIC_BASE_URL, falling back to PUBLIC_BASE_URL", async () => {
    const both = await temp({ publicBaseUrl: "https://mcp.getscreenshotapi.com/", htmlPublicBaseUrl: "https://gs-html.example/" });
    expect(both.publicBaseUrl).toBe("https://mcp.getscreenshotapi.com");
    expect(both.htmlPublicBaseUrl).toBe("https://gs-html.example");
    const res = await fetch(`${both.url}/v1/html`, { method: "POST", headers: bearer(GOOD_KEY), body: "<p>x</p>" });
    expect(((await res.json()) as { url: string }).url).toMatch(/^https:\/\/gs-html\.example\/h\/[A-Za-z0-9_-]{43}$/);

    const one = await temp({ publicBaseUrl: "https://mcp.getscreenshotapi.com/" });
    expect(one.htmlPublicBaseUrl).toBe("https://mcp.getscreenshotapi.com");
    const res2 = await fetch(`${one.url}/v1/html`, { method: "POST", headers: bearer(GOOD_KEY), body: "<p>x</p>" });
    expect(((await res2.json()) as { url: string }).url).toMatch(/^https:\/\/mcp\.getscreenshotapi\.com\/h\//);

    expect(httpOptionsFromEnv({ PUBLIC_BASE_URL: "https://a.example", HTML_PUBLIC_BASE_URL: "https://b.example" })).toMatchObject({
      publicBaseUrl: "https://a.example",
      htmlPublicBaseUrl: "https://b.example",
    });
    expect(httpOptionsFromEnv({ PUBLIC_BASE_URL: "https://a.example" }).htmlPublicBaseUrl).toBeUndefined();
  });

  it("with two hostnames, the MCP name serves no HTML and the HTML name serves nothing else", async () => {
    const server = await temp({ publicBaseUrl: "https://mcp.example.test", htmlPublicBaseUrl: "https://html.example.test" });
    const upload = await fetch(`${server.url}/v1/html`, { method: "POST", headers: bearer(GOOD_KEY), body: "<p>doc</p>" });
    const id = ((await upload.json()) as { url: string }).url.split("/h/")[1]!;
    const get = async (host: string, path: string) =>
      statusLine((await raw(server, `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)).response);

    expect(await get("mcp.example.test", `/h/${id}`)).toBe("HTTP/1.1 404 Not Found");
    expect(await get("html.example.test", "/healthz")).toBe("HTTP/1.1 404 Not Found");
    expect(await get("html.example.test", "/")).toBe("HTTP/1.1 404 Not Found");
    expect(await get("html.example.test", "/mcp")).toBe("HTTP/1.1 404 Not Found");
    expect(await get("mcp.example.test", "/healthz")).toBe("HTTP/1.1 200 OK");
    // Neither of those refusals used up a read.
    expect(await get("html.example.test", `/h/${id}`)).toBe("HTTP/1.1 200 OK");
    // Other names (the platform's own URL, health checks) reach everything.
    expect(await get("service-abc.a.run.app", "/healthz")).toBe("HTTP/1.1 200 OK");
  });
});

describe("keyless preview mode (TRIAL_API_KEY)", () => {
  async function preview(options: HttpServerOptions = {}) {
    return temp({ trialApiKey: TRIAL_KEY, trialDailyLimitPerIp: 2, trialDailyLimitGlobal: 3, ...options });
  }
  const from = (ip: string) => ({ headers: { "X-Forwarded-For": ip } });

  it("is off by default: no key means no capture", async () => {
    expect(httpOptionsFromEnv({}).trialApiKey).toBeUndefined();
    const result = await capture(await connect(app));
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it("captures the viewport with the operator's key and says how to get your own", async () => {
    const server = await preview();
    const result = await capture(await connect(server, from("203.0.113.7")));
    expect(result.isError).toBeFalsy();
    expect(fake.captures()[0]!.params).toEqual({ apikey: TRIAL_KEY, url: "https://example.com" });
    expect(result.content.map((c) => c.type)).toEqual(["text", "image"]);
    const text = textOf(result);
    expect(text).toMatch(/Preview capture: made without an API key \(limit 2 per day/);
    expect(text).toMatch(/https:\/\/www\.getscreenshotapi\.com\/#pricing/);
    expect(text).toMatch(/Authorization: Bearer YOUR_API_KEY/);
    expect(text).not.toMatch(/free tier|free plan|free trial|try free|no credit card/i);
    expect(text).not.toContain(TRIAL_KEY);
  });

  it("allows only a plain viewport capture; every refusal is free and leaves the allowance intact (F4)", async () => {
    const server = await preview();
    const client = await connect(server, from("203.0.113.8"));

    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ full_page: true }, /full-page capture .* needs an API key/],
      [{ element: "body" }, /`element` capture needs an API key/],
      [{ scale: 2 }, /`scale` above 1 needs an API key/],
      [{ scale: 3 }, /`scale` above 1/],
      [{ click: "#x" }, /Clicking with `click`/],
      [{ custom_js: "alert(1)" }, /custom_js.* needs an API key/],
      [{ custom_css: "*{display:none}" }, /custom_css/],
      [{ cookie: { name: "a", value: "b" } }, /cookie/],
      [{ wait_ms: 5001 }, /`wait_ms` above 5000/],
      [{ wait_ms: 20000 }, /`wait_ms` above 5000/],
      [{ width: 1921 }, /viewport larger than 1920x1200/],
      [{ width: 2000, height: 2000, scale: 3, wait_ms: 20000, click: "#x" }, /needs an API key/],
      [{ height: 10000 }, /viewport larger than 1920x1200/],
    ];
    for (const [args, pattern] of refused) {
      const result = await capture(client, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result), JSON.stringify(args)).toMatch(pattern);
      expect(textOf(result)).toMatch(/#pricing/);
    }
    expect((await capture(client, { url: "http://localhost:3000" })).isError).toBe(true);

    for (const [name, args] of [
      ["render_html", { html: "<p>x</p>" }],
      ["compare_screenshots", { before: { url: "https://a.example" }, after: { url: "https://b.example" } }],
      ["capture_pdf", { url: "https://example.com" }],
      ["get_usage", {}],
    ] as const) {
      const result = (await client.callTool({ name, arguments: args })) as Result;
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(/needs an API key/);
      expect(textOf(result), name).toMatch(/#pricing/);
    }
    expect(fake.requests).toHaveLength(0);
    expect(documents(server)).toBe(0);

    // The allowance is intact, and what is allowed still works: scale 1, a short wait, a modest viewport, a device.
    expect((await capture(client, { scale: 1, wait_ms: 5000, width: 1920, height: 1200 })).isError).toBeFalsy();
    expect((await capture(client, { device: "iphone12", wait_until: "domcontentloaded" })).isError).toBeFalsy();
    expect(fake.captures()[0]!.params).toEqual({ apikey: TRIAL_KEY, url: "https://example.com", width: "1920", height: "1200", timewait: "5000" });
  });

  it("refuses to capture pages hosted on the server itself, so /v1/html is not an anonymous render_html (F4)", async () => {
    const server = await preview({ publicBaseUrl: "https://mcp.example.test", htmlPublicBaseUrl: "https://html.example.test" });
    const upload = await fetch(`${server.url}/v1/html`, { method: "POST", headers: { "x-api-key": "aaaaaaaa" }, body: "<script>1</script>" });
    const hostedUrl = ((await upload.json()) as { url: string }).url;
    expect(hostedUrl).toMatch(/^https:\/\/html\.example\.test\/h\//);
    const client = await connect(server, from("203.0.113.60"));
    for (const url of [hostedUrl, "https://html.example.test/anything", "https://mcp.example.test/h/whatever"]) {
      const result = await capture(client, { url });
      expect(result.isError, url).toBe(true);
      expect(textOf(result)).toMatch(/Capturing a page hosted on this server needs an API key/);
    }
    expect(fake.requests).toHaveLength(0);
    // Other sites are fine.
    expect((await capture(client, { url: "https://example.org/" })).isError).toBeFalsy();
  });

  it("enforces the per-address daily limit and returns the upgrade message", async () => {
    const server = await preview();
    const client = await connect(server, from("203.0.113.9"));
    expect((await capture(client)).isError).toBeFalsy();
    expect((await capture(client)).isError).toBeFalsy();
    const third = await capture(client);
    expect(third.isError).toBe(true);
    expect(textOf(third)).toMatch(/used all 2 keyless preview captures for today/);
    expect(textOf(third)).toMatch(/https:\/\/www\.getscreenshotapi\.com\/#pricing/);
    expect(textOf(third)).toMatch(/FREE5/);
    expect(fake.captures()).toHaveLength(2);

    // A new connection from the same address is still limited; another address is not.
    expect((await capture(await connect(server, from("203.0.113.9")))).isError).toBe(true);
    expect((await capture(await connect(server, from("198.51.100.1")))).isError).toBeFalsy();
  });

  it("counts an IPv6 /64 as one address (F4)", async () => {
    const server = await preview({ trialDailyLimitGlobal: 50 });
    expect((await capture(await connect(server, from("2001:db8:5:6::1")))).isError).toBeFalsy();
    expect((await capture(await connect(server, from("2001:db8:5:6:aaaa:bbbb:cccc:dddd")))).isError).toBeFalsy();
    const third = await capture(await connect(server, from("2001:db8:5:6:1::99")));
    expect(third.isError).toBe(true);
    expect(textOf(third)).toMatch(/used all 2/);
    expect((await capture(await connect(server, from("2001:db8:5:7::1")))).isError).toBeFalsy();
  });

  it("uses the right-most X-Forwarded-For hop, so a forged left-most entry does not reset the limit", async () => {
    const server = await preview();
    const real = "203.0.113.50";
    expect((await capture(await connect(server, from(`1.1.1.1, ${real}`)))).isError).toBeFalsy();
    expect((await capture(await connect(server, from(`2.2.2.2, ${real}`)))).isError).toBeFalsy();
    const third = await capture(await connect(server, from(`3.3.3.3, ${real}`)));
    expect(third.isError).toBe(true);
    expect(textOf(third)).toMatch(/used all 2/);
  });

  it("enforces the global daily limit across addresses", async () => {
    const server = await preview();
    for (const ip of ["198.51.100.10", "198.51.100.11", "198.51.100.12"]) {
      expect((await capture(await connect(server, from(ip)))).isError, ip).toBeFalsy();
    }
    const fourth = await capture(await connect(server, from("198.51.100.13")));
    expect(fourth.isError).toBe(true);
    expect(textOf(fourth)).toMatch(/shared keyless preview allowance for today is used up/);
    expect(textOf(fourth)).toMatch(/#pricing/);
    expect(fake.captures()).toHaveLength(3);
  });

  it("a caller with their own key is not limited by preview rules and uses their own quota", async () => {
    const server = await preview({ trialDailyLimitPerIp: 1 });
    const client = await connect(server, { headers: { ...bearer(GOOD_KEY), "X-Forwarded-For": "203.0.113.99" } });
    for (let i = 0; i < 3; i++) {
      const result = await capture(client, { full_page: true, scale: 2 });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).not.toMatch(/Preview capture/);
    }
    expect(fake.captures().every((r) => r.params.apikey === GOOD_KEY)).toBe(true);
  });
});

describe("helpers", () => {
  it("clientIp trusts only the right-most hop by default", () => {
    expect(clientIp("203.0.113.7", "10.0.0.1")).toBe("203.0.113.7");
    expect(clientIp("6.6.6.6, 203.0.113.7", "10.0.0.1")).toBe("203.0.113.7");
    expect(clientIp(" 6.6.6.6 ,7.7.7.7 , 203.0.113.7 ", "10.0.0.1")).toBe("203.0.113.7");
    expect(clientIp(undefined, "::ffff:192.0.2.4")).toBe("192.0.2.4");
    expect(clientIp("", "192.0.2.4")).toBe("192.0.2.4");
    expect(clientIp(undefined, undefined)).toBe("unknown");
    expect(clientIp("2001:DB8::1", undefined)).toBe("2001:db8::1");
    // One trusted proxy of our own (a load balancer) appends one more entry.
    expect(clientIp("6.6.6.6, 203.0.113.7, 35.191.0.1", "10.0.0.1", 1)).toBe("203.0.113.7");
    expect(clientIp("203.0.113.7", "10.0.0.1", 1)).toBe("203.0.113.7");
  });

  it("extractApiKey reads the two headers and nothing else", () => {
    expect(extractApiKey({ authorization: "Bearer abc" })).toEqual({ key: "abc", source: "bearer" });
    expect(extractApiKey({ authorization: "bearer   abc  " })).toEqual({ key: "abc", source: "bearer" });
    expect(extractApiKey({ "x-api-key": " k " })).toEqual({ key: "k", source: "x-api-key" });
    expect(extractApiKey({ authorization: "Bearer one", "x-api-key": "two" })).toEqual({ key: "one", source: "bearer" });
    expect(extractApiKey({ authorization: "Basic abc" })).toBeUndefined();
    expect(extractApiKey({ authorization: "Bearer " })).toBeUndefined();
    expect(extractApiKey({ "x-api-key": "  " })).toBeUndefined();
    expect(extractApiKey({})).toBeUndefined();
    // There is no parameter through which a query string could be passed.
    expect(extractApiKey.length).toBe(1);
  });

  it("httpOptionsFromEnv applies the documented defaults", () => {
    expect(httpOptionsFromEnv({})).toEqual({
      port: 8080,
      apiBase: undefined,
      publicBaseUrl: undefined,
      htmlPublicBaseUrl: undefined,
      trialApiKey: undefined,
      trialDailyLimitPerIp: 5,
      trialDailyLimitGlobal: 200,
      trustedProxyHops: 0,
      rateLimitPerMinute: 60,
      rateLimitPerIpPerMinute: 120,
      imageConcurrency: 3,
      imageQueueMax: 24,
      imageQueueWaitMs: 20_000,
      htmlMaxDocsPerCaller: 5,
    });
    expect(
      httpOptionsFromEnv({
        PORT: "9090",
        PUBLIC_BASE_URL: "https://mcp.getscreenshotapi.com",
        TRIAL_API_KEY: "k",
        TRIAL_DAILY_LIMIT_PER_IP: "3",
        TRIAL_DAILY_LIMIT_GLOBAL: "50",
        TRUSTED_PROXY_HOPS: "1",
        GETSCREENSHOT_API_BASE: "http://127.0.0.1:1",
      }),
    ).toMatchObject({
      port: 9090,
      apiBase: "http://127.0.0.1:1",
      publicBaseUrl: "https://mcp.getscreenshotapi.com",
      trialApiKey: "k",
      trialDailyLimitPerIp: 3,
      trialDailyLimitGlobal: 50,
      trustedProxyHops: 1,
    });
  });

  it("close() stops the listener", async () => {
    const server = await start();
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    await server.close();
    await expect(fetch(`${server.url}/healthz`)).rejects.toThrow();
  });
});
