/**
 * Command-line interface on the same bin as the MCP server. This is what
 * coding agents call from a shell when no MCP client is available.
 *
 *   getscreenshot-mcp capture <url> [flags]
 *   getscreenshot-mcp pdf <url> [flags]
 *   getscreenshot-mcp usage
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DEVICE_PRESETS,
  GetScreenshotClient,
  GetScreenshotError,
  IMAGE_FORMATS,
  SCREENSHOT_TTL_DAYS,
  WAIT_UNTIL_VALUES,
  noApiKeyError,
  type CaptureInput,
  type DevicePreset,
  type ImageFormat,
  type PdfInput,
  type WaitUntil,
} from "./api.js";
import { allowedOriginsFor, downloadResult } from "./download.js";
import { API_KEY_ENV, DOCS_URL, PRICING_URL, VERSION } from "./version.js";

export const HELP = `getscreenshot-mcp ${VERSION}
MCP server and CLI for the GetScreenshot API.

Usage:
  getscreenshot-mcp                       Start the MCP server on stdio (for MCP clients)
  getscreenshot-mcp --http                Start the Streamable HTTP server (port from PORT, default 8080)
  getscreenshot-mcp capture <url> [flags] Capture a page; print the image URL
  getscreenshot-mcp pdf <url> [flags]     Save a page as an A4 PDF; print the PDF URL
  getscreenshot-mcp usage                 Show screenshots used and left this month
  getscreenshot-mcp --help | --version

capture flags:
  --full-page            Capture the whole scrollable page
  --element <selector>   Capture one element (CSS selector)
  --device <name>        Device preset: ${DEVICE_PRESETS.join(", ")}
  --width <px>           Viewport width (default 1280)
  --height <px>          Viewport height (default 800)
  --format <png|jpeg>    Stored image format (default png)
  --wait-until <event>   ${WAIT_UNTIL_VALUES.join(" | ")} (default networkidle2)
  --wait-ms <ms>         Extra wait before capture, 0-20000 (default 2000)
  --hide <selector>      CSS selector(s) to hide before capture
  -o, --output <file>    Also download the image to this file
  --json                 Print the result as JSON

pdf flags:
  --wait-until <event>, --wait-ms <ms>, --hide <selector>, -o/--output <file>, --json

usage flags:
  --json

Environment:
  ${API_KEY_ENV}   Your API key (required). Get one at ${PRICING_URL}

Examples:
  getscreenshot-mcp capture https://example.com
  getscreenshot-mcp capture https://example.com --full-page -o page.png
  getscreenshot-mcp capture https://example.com --device iphone12 --json

Every capture uses 1 screenshot of the monthly quota, failed captures included.
The page must be reachable from the public internet (no localhost).
Result links are public to anyone who has them and expire after ${SCREENSHOT_TTL_DAYS} days.
Docs: ${DOCS_URL}
`;

/** Flags each subcommand acts on. Anything else is a usage error rather than silently ignored. */
const SUPPORTED_FLAGS: Record<"capture" | "pdf" | "usage", readonly string[]> = {
  capture: ["full-page", "element", "device", "width", "height", "format", "wait-until", "wait-ms", "hide", "output", "json"],
  pdf: ["wait-until", "wait-ms", "hide", "output", "json"],
  usage: ["json"],
};

export interface CliIo {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

class UsageError extends Error {}

function intFlag(name: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} expects a whole number, got "${value}".`);
  const n = Number(value);
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}, got ${n}.`);
  return n;
}

function enumFlag<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`--${name} must be one of: ${allowed.join(", ")}. Got "${value}".`);
  }
  return value as T;
}

function requireUrl(positionals: string[], command: string): string {
  const url = positionals[0];
  if (!url) throw new UsageError(`Missing <url>. Usage: getscreenshot-mcp ${command} <url> [flags]`);
  if (positionals.length > 1) {
    throw new UsageError(`Unexpected argument "${positionals[1]}". Quote the URL if it contains & or spaces.`);
  }
  return url;
}

interface SaveOutcome {
  path: string | null;
  error: string | null;
}

/**
 * Downloads a result to a file. Never throws: the capture is already paid for,
 * so a failed download must not hide its URL.
 */
async function save(url: string, output: string | undefined, apiBase: string | undefined): Promise<SaveOutcome> {
  if (!output) return { path: null, error: null };
  try {
    const file = await downloadResult(url, { allowedOrigins: allowedOriginsFor(apiBase) });
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.data);
    return { path, error: null };
  } catch (error) {
    return { path: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs the CLI and returns the process exit code: 0 ok, 1 failure, 2 bad usage. */
export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const wantsJson = argv.includes("--json");

  const fail = (error: unknown): number => {
    if (error instanceof UsageError) {
      err(`Error: ${error.message}\nRun \`getscreenshot-mcp --help\` for usage.\n`);
      return 2;
    }
    const code = error instanceof GetScreenshotError ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) out(`${JSON.stringify({ error: { code, message } })}\n`);
    err(`Error: ${message}\n`);
    return 1;
  };

  /** The capture worked and its URL is printed; only writing the file failed. */
  const saveFailed = (saved: SaveOutcome, output: string | undefined): number => {
    if (!saved.error) return 0;
    err(`Error: the capture succeeded (URL above) but could not be saved to ${output}: ${saved.error}\n`);
    return 1;
  };

  try {
    const command = argv[0];
    const rest = argv.slice(1);

    if (command === "--help" || command === "-h" || command === "help") {
      out(HELP);
      return 0;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      out(`${VERSION}\n`);
      return 0;
    }
    if (command !== "capture" && command !== "pdf" && command !== "usage") {
      throw new UsageError(`Unknown command "${command}". Commands: capture, pdf, usage.`);
    }

    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: {
          "full-page": { type: "boolean" },
          element: { type: "string" },
          device: { type: "string" },
          width: { type: "string" },
          height: { type: "string" },
          format: { type: "string" },
          "wait-until": { type: "string" },
          "wait-ms": { type: "string" },
          hide: { type: "string" },
          output: { type: "string", short: "o" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (parseError) {
      throw new UsageError(parseError instanceof Error ? parseError.message : String(parseError));
    }
    const { values, positionals } = parsed;
    if (values.help) {
      out(HELP);
      return 0;
    }
    // One parser for all subcommands, so each one checks that it was only given flags it acts on.
    const supported = SUPPORTED_FLAGS[command];
    for (const flag of Object.keys(values)) {
      if (!supported.includes(flag)) {
        throw new UsageError(
          `--${flag} is not supported by \`${command}\`. ` +
            (supported.length > 0 ? `It accepts: ${supported.map((f) => `--${f}`).join(", ")}.` : "It takes no flags."),
        );
      }
    }

    const apiKey = (env[API_KEY_ENV] ?? "").trim();
    const client = () => {
      if (!apiKey) throw noApiKeyError();
      return new GetScreenshotClient({ apiKey, baseUrl: env.GETSCREENSHOT_API_BASE });
    };
    const waitUntil = enumFlag<WaitUntil>("wait-until", values["wait-until"], WAIT_UNTIL_VALUES);
    const waitMs = intFlag("wait-ms", values["wait-ms"], 0, 20000);

    if (command === "usage") {
      if (positionals.length > 0) throw new UsageError(`usage takes no arguments, got "${positionals[0]}".`);
      const usage = await client().usage();
      if (values.json) {
        out(
          `${JSON.stringify({
            used: usage.used,
            limit: usage.limit,
            remaining: usage.remaining,
            period: usage.period,
            quota_restart_date: usage.quotaRestartDate,
          })}\n`,
        );
      } else {
        out(`used: ${usage.used}\nlimit: ${usage.limit}\nremaining: ${usage.remaining}\nperiod: ${usage.period}\n`);
      }
      return 0;
    }

    if (command === "pdf") {
      const input: PdfInput = {
        url: requireUrl(positionals, "pdf"),
        wait_until: waitUntil,
        wait_ms: waitMs,
        hide_selectors: values.hide,
      };
      const pdf = await client().capturePdf(input);
      const saved = await save(pdf.pdfUrl, values.output, env.GETSCREENSHOT_API_BASE);
      if (values.json) {
        out(
          `${JSON.stringify({
            pdf_url: pdf.pdfUrl,
            origin_url: pdf.originUrl,
            page_status: pdf.pageStatus,
            captured_at: pdf.capturedAt,
            saved_to: saved.path,
            expires_in_days: SCREENSHOT_TTL_DAYS,
          })}\n`,
        );
      } else {
        out(`url: ${pdf.pdfUrl}\n`);
        if (saved.path) out(`saved: ${saved.path}\n`);
        if (pdf.pageStatus !== null) out(`page_status: ${pdf.pageStatus}\n`);
      }
      if (pdf.pageStatus !== null && pdf.pageStatus >= 400) {
        err(`Warning: the page answered with HTTP ${pdf.pageStatus}; this is probably an error page.\n`);
      }
      return saveFailed(saved, values.output);
    }

    // capture
    let format = enumFlag<ImageFormat>("format", values.format, IMAGE_FORMATS);
    if (!format && values.output && /\.jpe?g$/i.test(values.output)) format = "jpeg";
    const input: CaptureInput = {
      url: requireUrl(positionals, "capture"),
      full_page: values["full-page"],
      element: values.element,
      device: enumFlag<DevicePreset>("device", values.device, DEVICE_PRESETS),
      width: intFlag("width", values.width, 1, 10000),
      height: intFlag("height", values.height, 1, 10000),
      format,
      wait_until: waitUntil,
      wait_ms: waitMs,
      hide_selectors: values.hide,
    };
    const capture = await client().capture(input);
    const saved = await save(capture.screenshotUrl, values.output, env.GETSCREENSHOT_API_BASE);
    if (values.json) {
      out(
        `${JSON.stringify({
          screenshot_url: capture.screenshotUrl,
          origin_url: capture.originUrl,
          page_status: capture.pageStatus,
          captured_at: capture.capturedAt,
          format: capture.format,
          saved_to: saved.path,
          expires_in_days: SCREENSHOT_TTL_DAYS,
        })}\n`,
      );
    } else {
      out(`url: ${capture.screenshotUrl}\n`);
      if (saved.path) out(`saved: ${saved.path}\n`);
      if (capture.pageStatus !== null) out(`page_status: ${capture.pageStatus}\n`);
    }
    if (capture.pageStatus !== null && capture.pageStatus >= 400) {
      err(`Warning: the page answered with HTTP ${capture.pageStatus}; this is probably an error page.\n`);
    }
    return saveFailed(saved, values.output);
  } catch (error) {
    return fail(error);
  }
}
