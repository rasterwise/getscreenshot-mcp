/**
 * stdio entry: `npx -y getscreenshot-mcp` with GETSCREENSHOT_API_KEY in the
 * environment. Nothing but protocol messages may go to stdout, so all logging
 * here uses stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GetScreenshotError } from "./api.js";
import { HTML_MAX_BYTES, htmlTooLargeError, type HostedHtml, type HtmlHost } from "./html-store.js";
import { createServer } from "./server.js";
import { API_KEY_ENV, HOSTED_MCP_BASE, USER_AGENT, VERSION } from "./version.js";

export const HTML_UPLOAD_TIMEOUT_MS = 30_000;

export function resolveMcpBase(explicit?: string | undefined): string {
  const raw = explicit ?? process.env.GETSCREENSHOT_MCP_BASE ?? HOSTED_MCP_BASE;
  return raw.trim().replace(/\/+$/, "") || HOSTED_MCP_BASE;
}

/**
 * render_html for the local server: the capture API can only load public URLs,
 * so the HTML is uploaded to the hosted service, which serves it from a
 * short-lived unguessable URL.
 */
export class RemoteHtmlHost implements HtmlHost {
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    base?: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = resolveMcpBase(base);
  }

  async publish(html: string, signal?: AbortSignal): Promise<HostedHtml> {
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > HTML_MAX_BYTES) throw htmlTooLargeError(HTML_MAX_BYTES, bytes);

    const endpoint = `${this.base}/v1/html`;
    const host = new URL(this.base).host;
    const unavailable = (detail: string, cause?: unknown) =>
      new GetScreenshotError(
        "html_host_unavailable",
        `render_html could not upload the HTML to ${host}: ${detail}. Nothing was captured and no quota was used. ` +
          "Check that this environment has outbound HTTPS access, then try again. As an alternative, publish the page at a public URL and use capture_screenshot.",
        { cause },
      );

    const timeout = AbortSignal.timeout(HTML_UPLOAD_TIMEOUT_MS);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "text/html; charset=utf-8",
          "User-Agent": USER_AGENT,
        },
        body: html,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      text = await response.text();
    } catch (err) {
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw unavailable(reason.split(this.apiKey).join("***"), err);
    }

    let body: { url?: unknown; expires_in_seconds?: unknown; error?: unknown } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // not JSON: handled below
    }

    if (response.status === 413) throw htmlTooLargeError(HTML_MAX_BYTES, bytes);
    if (response.status === 429 || response.status === 503) {
      // Rate limit, per-caller document cap or a full store: the service says which.
      const said = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new GetScreenshotError(
        "html_host_unavailable",
        `render_html could not host the HTML at ${host}: ${said} Nothing was captured and no quota was used.`,
        { httpStatus: response.status },
      );
    }
    if (!response.ok) throw unavailable(`HTTP ${response.status}`);

    const url = body.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      throw unavailable("the service answered in an unexpected format");
    }
    return {
      url,
      expiresInSeconds: typeof body.expires_in_seconds === "number" ? body.expires_in_seconds : 300,
      dispose: async () => {
        // Best effort: the document also expires by itself.
        try {
          await this.fetchImpl(url, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${this.apiKey}`, "User-Agent": USER_AGENT },
            redirect: "error",
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          // ignore
        }
      },
    };
  }
}

export interface StdioOptions {
  apiKey?: string | undefined;
  apiBase?: string | undefined;
  mcpBase?: string | undefined;
}

export async function runStdio(options: StdioOptions = {}): Promise<void> {
  const apiKey = (options.apiKey ?? process.env[API_KEY_ENV] ?? "").trim() || undefined;
  const server = createServer({
    apiKey,
    apiBase: options.apiBase,
    htmlHost: apiKey ? new RemoteHtmlHost(apiKey, options.mcpBase) : undefined,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `getscreenshot-mcp ${VERSION} running on stdio` +
      (apiKey ? "\n" : ` (no ${API_KEY_ENV} set: tools will explain how to get a key)\n`),
  );

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
