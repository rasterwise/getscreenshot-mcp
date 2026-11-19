/**
 * The built bin (`dist/bin.js`), spawned as a real process against the fake
 * API: the CLI subcommands, and the stdio MCP server as an MCP client sees it.
 * `npm test` builds first (pretest).
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { connect as connectSocket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startHttpServer, type RunningHttpServer } from "../src/http.js";
import { VERSION } from "../src/version.js";
import { GOOD_KEY, INVALID_KEY, startFakeUpstream, type FakeUpstream } from "./helpers/fake-upstream.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

let fake: FakeUpstream;
let hosted: RunningHttpServer;
let dir: string;

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error("dist/bin.js is missing. Run `npm run build` (npm test does this for you).");
  fake = await startFakeUpstream();
  hosted = await startHttpServer({ port: 0, host: "127.0.0.1", apiBase: fake.url, log: () => undefined });
  dir = await mkdtemp(join(tmpdir(), "getscreenshot-cli-"));
});
afterAll(async () => {
  await hosted.close();
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function childEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GETSCREENSHOT_API_KEY: GOOD_KEY,
    GETSCREENSHOT_API_BASE: fake.url,
    GETSCREENSHOT_MCP_BASE: hosted.url,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: childEnv(env), timeout: 20_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe("cli", () => {
  it("--version and --help", async () => {
    const version = await run(["--version"]);
    expect(version).toMatchObject({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    for (const word of ["capture <url>", "pdf <url>", "usage", "--full-page", "--element", "--device", "--wait-until", "-o, --output", "--json", "GETSCREENSHOT_API_KEY"]) {
      expect(help.stdout).toContain(word);
    }
  });

  it("capture prints the hosted URL", async () => {
    const result = await run(["capture", "https://example.com"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^url: http:\/\/127\.0\.0\.1:\d+\/getscreenshot-storage\/image[A-Za-z0-9]{10}\.png\npage_status: 200\n$/);
    expect(fake.captures()[0]!.params).toEqual({ apikey: GOOD_KEY, url: "https://example.com" });
    expect(fake.captures()[0]!.headers["user-agent"]).toBe(`getscreenshot-mcp/${VERSION}`);
  });

  it("maps every capture flag to the API parameter", async () => {
    const result = await run([
      "capture", "https://example.com/p?a=1&b=2",
      "--full-page", "--element", "#hero", "--width", "1440", "--height", "900", "--format", "jpeg",
      "--wait-until", "domcontentloaded", "--wait-ms", "500", "--hide", ".ad, .popup",
    ]);
    expect(result.code).toBe(0);
    expect(fake.captures()[0]!.params).toEqual({
      apikey: GOOD_KEY,
      url: "https://example.com/p?a=1&b=2",
      fullpage: "true",
      element: "#hero",
      width: "1440",
      height: "900",
      format: "jpeg",
      waituntil: "domcontentloaded",
      timewait: "500",
      hideelement: ".ad, .popup",
    });
    expect(result.stdout).toMatch(/\.jpeg\n/);
  });

  it("--device with --full-page sends preset + noheight", async () => {
    await run(["capture", "https://example.com", "--device", "iphone12", "--full-page", "--width", "999"]);
    expect(fake.captures()[0]!.params).toEqual({ apikey: GOOD_KEY, url: "https://example.com", preset: "iphone12", noheight: "true" });
  });

  it("-o downloads the original image and prints the saved path", async () => {
    const file = join(dir, "nested", "shot.png");
    const result = await run(["capture", "https://example.com", "--full-page", "-o", file]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`saved: ${file}\n`);
    const meta = await sharp(await readFile(file)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1280, 6000]);
  });

  it("-o with a .jpg name asks the API for jpeg", async () => {
    const file = join(dir, "shot.jpg");
    const result = await run(["capture", "https://example.com", "-o", file]);
    expect(result.code).toBe(0);
    expect(fake.captures()[0]!.params.format).toBe("jpeg");
    expect((await sharp(await readFile(file)).metadata()).format).toBe("jpeg");
  });

  it("--json prints one JSON object", async () => {
    const file = join(dir, "json.png");
    const result = await run(["capture", "https://example.com/status404", "--json", "-o", file]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      origin_url: "https://example.com/status404",
      page_status: 404,
      format: "png",
      saved_to: file,
      expires_in_days: 30,
    });
    expect(parsed.screenshot_url).toMatch(/\/getscreenshot-storage\/image/);
    expect(result.stderr).toMatch(/Warning: the page answered with HTTP 404/);
  });

  it("pdf prints the PDF URL and saves the file", async () => {
    const file = join(dir, "page.pdf");
    const result = await run(["pdf", "https://example.com/report", "--wait-until", "load", "-o", file]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^url: http:\/\/127\.0\.0\.1:\d+\/getscreenshot-storage\/pdf[A-Za-z0-9]{10}\.pdf\n/);
    expect(result.stdout).toContain(`saved: ${file}\n`);
    expect(fake.captures()[0]!.params).toEqual({ apikey: GOOD_KEY, url: "https://example.com/report", pdf: "true", waituntil: "load" });
    expect((await readFile(file)).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("usage prints used, limit and remaining", async () => {
    const text = await run(["usage"]);
    expect(text).toMatchObject({ code: 0, stdout: "used: 123\nlimit: 6000\nremaining: 5877\nperiod: MONTH\n" });
    const json = await run(["usage", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({ used: 123, limit: 6000, remaining: 5877, period: "MONTH", quota_restart_date: "2026-12-01" });
  });

  it("exits 1 with the how-to-get-a-key message when no key is set", async () => {
    const result = await run(["capture", "https://example.com"], { GETSCREENSHOT_API_KEY: undefined });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Error: No GetScreenshot API key is configured/);
    expect(result.stderr).toMatch(/https:\/\/www\.getscreenshotapi\.com\/#pricing/);
    expect(result.stderr).toMatch(/GETSCREENSHOT_API_KEY/);
    expect(fake.requests).toHaveLength(0);
  });

  it("exits 1 with the actionable message on API failures", async () => {
    const invalid = await run(["capture", "https://example.com"], { GETSCREENSHOT_API_KEY: INVALID_KEY });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/does not recognise this API key/);
    expect(invalid.stderr).not.toContain(INVALID_KEY);

    const missing = await run(["capture", "https://example.com", "--element", "#missing"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/`element` selector "#missing" probably matched nothing/);

    const slow = await run(["capture", "https://slow.example.com", "--json"]);
    expect(slow.code).toBe(1);
    expect(JSON.parse(slow.stdout)).toMatchObject({ error: { code: "page_load_failed" } });
    expect(slow.stderr).toMatch(/domcontentloaded/);

    const local = await run(["capture", "http://localhost:3000"]);
    expect(local.code).toBe(1);
    expect(local.stderr).toMatch(/localhost or private-network address/);
  });

  it("still prints the URL when saving the file fails", async () => {
    const result = await run(["capture", "https://offlist-image.example.com", "-o", join(dir, "never.png")]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("url: http://169.254.169.254/latest/meta-data/image.png\n");
    expect(result.stderr).toMatch(/the capture succeeded \(URL above\) but could not be saved/);
    expect(existsSync(join(dir, "never.png"))).toBe(false);
  });

  it("exits 2 on bad usage without calling the API", async () => {
    const cases: Array<[string[], RegExp]> = [
      [["capture"], /Missing <url>/],
      [["capture", "https://example.com", "--device", "iphone99"], /--device must be one of/],
      [["capture", "https://example.com", "--format", "webp"], /--format must be one of: png, jpeg/],
      [["capture", "https://example.com", "--wait-ms", "soon"], /--wait-ms expects a whole number/],
      [["capture", "https://example.com", "--wait-ms", "99999"], /between 0 and 20000/],
      [["capture", "https://example.com", "--nope"], /Unknown option/],
      [["capture", "https://example.com", "extra"], /Unexpected argument/],
      [["frobnicate"], /Unknown command "frobnicate"/],
      // Each subcommand rejects flags it would otherwise silently ignore.
      [["pdf", "https://example.com", "--element", "#x"], /--element is not supported by `pdf`\. It accepts: --wait-until, --wait-ms, --hide, --output, --json/],
      [["pdf", "https://example.com", "--full-page"], /--full-page is not supported by `pdf`/],
      [["pdf", "https://example.com", "--device", "ipad"], /--device is not supported by `pdf`/],
      [["pdf", "https://example.com", "--format", "jpeg"], /--format is not supported by `pdf`/],
      [["pdf", "https://example.com", "--width", "800"], /--width is not supported by `pdf`/],
      [["usage", "--full-page"], /--full-page is not supported by `usage`\. It accepts: --json/],
      [["usage", "-o", "x.png"], /--output is not supported by `usage`/],
      [["usage", "--wait-ms", "5"], /--wait-ms is not supported by `usage`/],
    ];
    for (const [args, pattern] of cases) {
      const result = await run(args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toMatch(pattern);
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("stdio server (bin with no arguments)", () => {
  type Result = CallToolResult & { structuredContent?: Record<string, any> };

  async function connect(env: Record<string, string | undefined> = {}) {
    const stderr: string[] = [];
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: childEnv(env), stderr: "pipe" });
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    return { client, stderr };
  }

  it("speaks MCP on stdout and captures with the key from the environment", async () => {
    const { client, stderr } = await connect();
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "getscreenshot", version: VERSION });
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        "capture_screenshot", "render_html", "compare_screenshots", "capture_pdf", "get_usage",
      ]);
      const result = (await client.callTool({ name: "capture_screenshot", arguments: { url: "https://example.com" } })) as Result;
      expect(result.isError).toBeFalsy();
      expect(result.content.map((c) => c.type)).toEqual(["text", "image"]);
      expect(fake.captures()[0]!.params).toEqual({ apikey: GOOD_KEY, url: "https://example.com" });
      // Logging goes to stderr only; the protocol stream stayed clean or the calls above would have failed.
      expect(stderr.join("")).toMatch(/running on stdio/);
    } finally {
      await client.close();
    }
  });

  it("render_html uploads to the hosted service, which serves it to the capture", async () => {
    const { client } = await connect();
    try {
      const html = "<h1>from stdio</h1>";
      const result = (await client.callTool({ name: "render_html", arguments: { html } })) as Result;
      expect(result.isError).toBeFalsy();
      expect(fake.captures()[0]!.params.url).toMatch(new RegExp(`^${hosted.url}/h/[A-Za-z0-9_-]{43}$`));
      expect(fake.fetchedHtml[0]).toMatchObject({ status: 200, body: html });
    } finally {
      await client.close();
    }
  });

  it("without GETSCREENSHOT_API_KEY it starts and the tools explain how to get a key", async () => {
    const { client, stderr } = await connect({ GETSCREENSHOT_API_KEY: undefined });
    try {
      expect((await client.listTools()).tools).toHaveLength(5);
      const result = (await client.callTool({ name: "get_usage", arguments: {} })) as Result;
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/https:\/\/www\.getscreenshotapi\.com\/#pricing/);
      expect(stderr.join("")).toMatch(/no GETSCREENSHOT_API_KEY set/);
      expect(fake.requests).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});

describe("hosted server (bin --http)", () => {
  it("starts on PORT, serves /healthz and MCP, logs JSON lines, and exits cleanly on SIGTERM", async () => {
    const child = spawn(process.execPath, [BIN, "--http"], {
      env: childEnv({ PORT: "0", GETSCREENSHOT_API_KEY: undefined, PUBLIC_BASE_URL: "https://mcp.example.test" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let stderr = "";
    let buffer = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    const listening = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start. stderr: ${stderr}`)), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          lines.push(line);
          const entry = JSON.parse(line) as { msg: string; port?: number };
          if (entry.msg === "listening" && entry.port) {
            clearTimeout(timer);
            resolve(entry.port);
          }
        }
      });
    });

    try {
      const port = await listening;
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: "ok", version: VERSION });

      const upload = await fetch(`${base}/v1/html`, { method: "POST", headers: { Authorization: `Bearer ${GOOD_KEY}` }, body: "<p>x</p>" });
      expect(((await upload.json()) as { url: string }).url).toMatch(/^https:\/\/mcp\.example\.test\/h\//);

      const transport = new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport(
        new URL(`${base}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${GOOD_KEY}` } } },
      );
      const client = new Client({ name: "process-test", version: "1.0.0" });
      await client.connect(transport);
      const result = (await client.callTool({ name: "capture_screenshot", arguments: { url: "https://example.com" } })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(result.content.map((c) => c.type)).toEqual(["text", "image"]);
      await client.close();
    } finally {
      child.kill("SIGTERM");
    }

    const exit = await exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(stderr).toBe("");
    // Every stdout line is one JSON object, and none carries the key.
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries[0]).toMatchObject({
      msg: "listening",
      version: VERSION,
      preview_mode: false,
      public_base_url: "https://mcp.example.test",
      html_public_base_url: "https://mcp.example.test",
      image_concurrency: 3,
      rate_limit_per_minute: 60,
    });
    expect(entries.some((e) => e.severity === "WARNING")).toBe(false);
    expect(entries.some((e) => e.msg === "request" && e.path === "/mcp" && e.tool === "capture_screenshot" && e.tool_ok === true)).toBe(true);
    expect(entries.at(-1)).toMatchObject({ msg: "shutting down", signal: "SIGTERM" });
    expect(lines.join("\n")).not.toContain(GOOD_KEY);
  });
});

/** Starts `bin --http` (or another entry) and resolves once it logs "listening". */
function spawnServer(args: string[], env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, args, { env: childEnv({ PORT: "0", GETSCREENSHOT_API_KEY: undefined, ...env }), stdio: ["ignore", "pipe", "pipe"] });
  const lines: Array<Record<string, any>> = [];
  let stderr = "";
  let buffer = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const port = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start. stderr: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const entry = JSON.parse(buffer.slice(0, newline)) as Record<string, any>;
        buffer = buffer.slice(newline + 1);
        lines.push(entry);
        if (entry.msg === "listening" && entry.port) {
          clearTimeout(timer);
          resolve(entry.port as number);
        }
      }
    });
  });
  return { child, lines, port, exited, stderr: () => stderr };
}

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    let response = "";
    const socket = connectSocket(port, "127.0.0.1", () => socket.write(payload));
    socket.on("data", (chunk) => (response += chunk.toString()));
    const done = () => resolve(response.split("\r\n")[0] ?? "");
    socket.on("close", done);
    socket.on("error", done);
    setTimeout(() => {
      socket.destroy();
      done();
    }, 2000);
  });
}

describe("hosted server process hardening", () => {
  it("survives malformed request targets that used to crash it (F1)", async () => {
    const server = spawnServer([BIN, "--http"], {});
    try {
      const port = await server.port;
      for (const target of ["//a:b", "//[", "http://[::1", "//x:99999/mcp"]) {
        expect(await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`), target).toBe("HTTP/1.1 400 Bad Request");
      }
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect(server.child.exitCode).toBeNull();
    } finally {
      server.child.kill("SIGTERM");
    }
    expect(await server.exited).toEqual({ code: 0, signal: null });
    expect(server.lines.filter((e) => e.msg === "request" && e.status === 400)).toHaveLength(4);
    expect(server.lines.some((e) => e.msg === "uncaughtException")).toBe(false);
    expect(server.stderr()).toBe("");
  });

  it("logs and keeps serving after an uncaught exception or unhandled rejection (backstop)", async () => {
    const httpModule = new URL("../dist/http.js", import.meta.url).href;
    const script = `
      const { runHttp } = await import(${JSON.stringify(httpModule)});
      await runHttp();
      setTimeout(() => { throw new Error("boom from a timer"); }, 150);
      setTimeout(() => { Promise.reject(new Error("boom from a promise")); }, 250);
    `;
    const server = spawnServer(["--input-type=module", "-e", script], {});
    try {
      const port = await server.port;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(server.child.exitCode).toBeNull();
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect(server.lines.find((e) => e.msg === "uncaughtException")).toMatchObject({ severity: "ERROR", error: "Error: boom from a timer" });
      expect(server.lines.find((e) => e.msg === "unhandledRejection")).toMatchObject({ severity: "ERROR", error: "Error: boom from a promise" });
    } finally {
      server.child.kill("SIGTERM");
    }
    expect(await server.exited).toEqual({ code: 0, signal: null });
  });

  it("warns at startup when keyless preview mode is on, and stays quiet when it is off (F4)", async () => {
    const server = spawnServer([BIN, "--http"], { TRIAL_API_KEY: GOOD_KEY, PUBLIC_BASE_URL: "https://mcp.example.test", HTML_PUBLIC_BASE_URL: "https://html.example.test" });
    try {
      await server.port;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.lines[0]).toMatchObject({ msg: "listening", preview_mode: true, html_public_base_url: "https://html.example.test" });
      const warning = server.lines.find((e) => e.severity === "WARNING");
      expect(warning?.msg).toMatch(/TRIAL_API_KEY is set: keyless preview mode is ON/);
      expect(warning?.msg).toMatch(/reset on every restart, new revision and scale-to-zero/);
      expect(warning?.msg).toMatch(/Do not enable this in production until a persistent counter exists/);
      expect(JSON.stringify(server.lines)).not.toContain(GOOD_KEY);
    } finally {
      server.child.kill("SIGTERM");
    }
    await server.exited;
  });
});
