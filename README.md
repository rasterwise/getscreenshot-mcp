# getscreenshot-mcp

MCP server and CLI for the [GetScreenshot](https://www.getscreenshotapi.com) API. It gives AI agents eyes: capture a public web page, or HTML the agent just wrote, and get back images sized for vision models.

```bash
claude mcp add --env GETSCREENSHOT_API_KEY=YOUR_API_KEY --transport stdio getscreenshot -- npx -y getscreenshot-mcp
```

Then ask your agent to "take a screenshot of https://example.com and tell me what is above the fold".

- Works where there is no browser. Cloud coding agents, sandboxes and CI runners cannot launch Chromium. A hosted HTTPS API can render any public URL, or raw HTML, and hand back an image.
- Output sized for models. Captures are downscaled and full pages are cut into slices, so every image fits a vision model's input budget. The result reports the estimated token cost. The full-resolution image stays available by URL.
- One API key. Plans start at $5/month for 2,500 screenshots, and the MCP server, CLI and agent skill work with any key on any plan.

You need an API key: get one at <https://www.getscreenshotapi.com/#pricing>. It is emailed after checkout. Code `FREE5` makes the first month of the $5 plan free.

## Quick start

### Claude Code

Local server (stdio):

```bash
claude mcp add --env GETSCREENSHOT_API_KEY=YOUR_API_KEY --transport stdio getscreenshot -- npx -y getscreenshot-mcp
```

Hosted server (nothing to install):

```bash
claude mcp add --transport http getscreenshot https://mcp.getscreenshotapi.com/mcp --header "Authorization: Bearer YOUR_API_KEY"
```

### Cursor, Claude Desktop and other clients

Add this to the client's MCP config (`.cursor/mcp.json` or `~/.cursor/mcp.json` for Cursor, `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "getscreenshot": {
      "command": "npx",
      "args": ["-y", "getscreenshot-mcp"],
      "env": { "GETSCREENSHOT_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### Any client that speaks Streamable HTTP

- URL: `https://mcp.getscreenshotapi.com/mcp`
- Header: `Authorization: Bearer YOUR_API_KEY` (`x-api-key: YOUR_API_KEY` also works)

The key is accepted in a header only. A key in the URL (`?apikey=`) is ignored: URLs are written to request logs, config files and browser history.

Without a key the server still connects and lists its tools. Each tool then answers with instructions for getting and setting a key.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `capture_screenshot` | Capture a public web page as images the model can see. Viewport by default; `element` for one part of the page; `full_page` for the whole page. | 1 screenshot |
| `render_html` | Render an HTML string (a component or page the agent just wrote) and screenshot it. | 1 screenshot |
| `compare_screenshots` | Visual diff of two pages or two earlier screenshots: changed-pixel percentage, bounding box, diff image. | 1 per side given as `url`, 0 for `screenshot_url` |
| `capture_pdf` | Save a page as an A4 PDF and return the link. | 1 screenshot |
| `get_usage` | Screenshots used, monthly limit, remaining, reset date. | 1 screenshot |

All tools are annotated `readOnlyHint: true`, `openWorldHint: true`, `destructiveHint: false`, `idempotentHint: false`.

### `capture_screenshot` inputs

| Input | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | Absolute http(s) URL, reachable from the public internet. |
| `full_page` | boolean | `false` | Whole scrollable page. |
| `element` | string | | CSS selector; captures only that element. |
| `device` | enum | | `iphone5`, `iphone678`, `iphone678_plus`, `iphonex`, `iphone12`, `pixel2`, `pixel2_xl`, `ipad`, `ipadpro`, `hvga`, `wvga`, `dvga`, `wxga_v`, `xga`, `wxga_s`, `wxga_l`, `sxga`, `wsxga_plus`. Overrides `width`/`height`. |
| `width`, `height` | integer | 1280, 800 | Viewport in CSS pixels. |
| `scale` | 1-3 | 1 | Device pixel ratio of the stored image. |
| `format` | `png` \| `jpeg` | `png` | Format of the stored file. Inline images are always JPEG. |
| `wait_until` | enum | `networkidle2` | `load`, `domcontentloaded`, `networkidle0`, `networkidle2`. |
| `wait_ms` | 0-20000 | 2000 | Extra wait before capture. |
| `hide_selectors` | string | | CSS selector(s) to hide. |
| `hide_cookie_banners` | boolean | `true` | Hides common cookie banners. |
| `hide_chat_widgets` | boolean | `false` | Hides common chat widgets. |
| `click` | string | | CSS selector to click before capture. |
| `custom_css`, `custom_js` | string | | Injected before capture. |
| `highlight` | string | | Keyword(s) to highlight. |
| `cookie` | `{name, value}` | | One cookie for the target host. |
| `lang` | string | `en-US` | Browser language. |
| `transparent_background` | boolean | `false` | Transparent where the page sets no background. |
| `full_page_strategy` | 0-3 | 0 | Try another value if a full-page capture renders badly. |
| `detail` | `standard` \| `high` | `standard` | Size of inline images, see below. |
| `max_slices` | 1-10 | 4 | Maximum number of inline images. Fewer are attached if they would exceed the inline size limit, see below. |
| `return` | `image_and_url` \| `url_only` | `image_and_url` | `url_only` attaches no image and reads only the image's dimensions. |

`render_html` takes `html` (required, at most 2 MB) plus `full_page`, `element`, `device`, `width`, `height`, `scale`, `wait_ms`, `detail`, `max_slices`, `return`. The HTML is hosted at an unguessable temporary URL, captured like any page, and deleted as soon as the capture returns (at the latest after 5 minutes or 3 reads). Relative asset URLs do not resolve unless the HTML sets `<base href>` or inlines its assets. The page runs in a sandbox without cookies or localStorage, so code that depends on them may render blank. Cookie-banner hiding is off for this tool so the page renders as written.

`compare_screenshots` takes `before` and `after`, each either `{ "url": "..." }` (a page to capture) or `{ "screenshot_url": "..." }` (an earlier GetScreenshot result), plus shared `full_page`, `width`, `height`, `device`, `hide_selectors`, `wait_until`, `wait_ms`, and `threshold` (0-1, default 0.1). `screenshot_url` must be a GetScreenshot result URL (`https://storage.googleapis.com/getscreenshot-storage/...`); anything else is refused. A `screenshot_url` side is checked first (it must exist and be an image) before a capture is spent on a `url` side. At most the top 2,400 px are compared, at up to 1280 px wide; for a lower part of a long page, capture that part of both versions with `capture_screenshot` and `element`, then compare the two `screenshot_url` values.

`capture_pdf` takes `url`, `wait_until`, `wait_ms`, `hide_selectors`, `custom_css`.

## Output contract

Every successful call returns a short text block, then the image blocks (if any), plus `structuredContent` that matches the tool's declared `outputSchema`.

```text
Screenshot captured: https://storage.googleapis.com/getscreenshot-storage/imageAbC123xYz9.png
Page: https://example.com (HTTP 200).
Original image: 1280x6000 px (png).
Attached: 4 of 7 slices as JPEG images, 1280 px wide, top to bottom, about 6,256 image tokens (approximate).
Truncated: only the top 3808 px of 6000 px (after downscaling) are attached. To see the rest, raise max_slices (up to 10) or capture one part with `element`.
The link is public to anyone who has it and expires in 30 days.
```

`structuredContent` of `capture_screenshot` and `render_html`:

```json
{
  "screenshot_url": "https://storage.googleapis.com/getscreenshot-storage/imageAbC123xYz9.png",
  "origin_url": "https://example.com",
  "page_status": 200,
  "captured_at": "2026-11-18T14:03:22Z",
  "format": "png",
  "original": { "width": 1280, "height": 6000 },
  "images": [
    { "index": 0, "y": 0, "width": 1280, "height": 952, "estimated_tokens": 1564 },
    { "index": 1, "y": 952, "width": 1280, "height": 952, "estimated_tokens": 1564 },
    { "index": 2, "y": 1904, "width": 1280, "height": 952, "estimated_tokens": 1564 },
    { "index": 3, "y": 2856, "width": 1280, "height": 952, "estimated_tokens": 1564 }
  ],
  "total_slices": 7,
  "truncated": true,
  "estimated_image_tokens": 6256,
  "expires_in_days": 30,
  "warnings": []
}
```

- `images[i]` describes the i-th image block. `y` is the slice's top offset in the downscaled capture, in the same pixels as `width` and `height`.
- `page_status` is the HTTP status the page answered with. At 400 or above the text and `warnings` say so, because the capture is probably an error page.
- `original` is `null` if the stored image could not be read. The capture and its URL are still returned. The same happens when the server is too busy to process the image: the result is not an error, `images` is empty and `warnings` says why.
- `total_slices` is how many slices the whole image needs at this detail level, whether or not they are attached. `truncated` is `true` when images were requested and some slices were left out, because of `max_slices` or the inline size limit. With `return: "url_only"` no image is attached by request, so `images` is empty, `truncated` is `false`, and `total_slices` is what a normal call would produce.
- `compare_screenshots` returns `changed_percent`, `changed_pixels`, `total_pixels`, `identical`, `threshold`, `bounding_box` (`{x, y, width, height}` or `null`), `size_changed`, `compared`, `before` and `after` (each with `screenshot_url`, `origin_url`, `page_status`, `width`, `height`), and the same image fields. `identical` is `true` only when no compared pixel differs and both images have exactly the same width and height. The diff image is the after image dimmed, with changed pixels in magenta and a red rectangle around the changed area. It is cropped to the changed rows. When nothing changed, no image is attached. If a capture succeeded but the comparison could not be completed, the error names the screenshot URLs that are already paid for, so they can be passed back as `screenshot_url`.
- `capture_pdf` returns `pdf_url`, `origin_url`, `page_status`, `captured_at`, `expires_in_days`, `warnings`.
- `get_usage` returns `used`, `limit`, `remaining`, `percent_used`, `period`, `quota_restart_date`, `resets_on`.

Failures are returned as tool results with `isError: true` and a message that says what to change. For example a page that fails to load suggests `wait_until: "domcontentloaded"`, and a crashed capture with `element` set says the selector probably matched nothing.

Stored files are on Google Cloud Storage for 30 days. The links are public to anyone who has them.

### Sizing rules

| `detail` | Max width | Max long edge | Max tokens per image | Slice height at max width |
|---|---|---|---|---|
| `standard` (default) | 1280 px | 1568 px | about 1,568 | 952 px |
| `high` | 1920 px | 2576 px | about 4,784 | 1932 px |

1. Images wider than the max width are downscaled. Nothing is upscaled.
2. The result is cut top to bottom into slices of the tallest height that respects both limits. If the last slice would be under 200 px, the last two slices are balanced instead.
3. The first `max_slices` slices are returned. `truncated` and `total_slices` tell you whether there is more.
4. Inline images are JPEG, quality 80. Transparent areas are flattened onto white.
5. The inline images of one result may not exceed about 1.5 MB in total (`standard`) or 4 MB (`high`). A slice over its share is re-encoded at quality 70, then 60. If the total still does not fit, trailing slices are left out, `truncated` is `true` and `warnings` names the cause. Ordinary pages stay far below this; photo-heavy or noisy pages can reach it. The first slice is always returned.
6. Token estimate per image: `ceil(width / 28) * ceil(height / 28)`. This is an approximation in the style of Claude's image accounting; other models count differently.

A default 1280x800 viewport capture is one image of about 1,334 tokens. Use `element` to look at one part of a page for less, and `high` only when you need to read small text.

## CLI

The same package is a command-line tool, for agents that have a shell but no MCP client.

```bash
export GETSCREENSHOT_API_KEY=YOUR_API_KEY
npx -y getscreenshot-mcp capture https://example.com --full-page -o page.png
```

```text
url: https://storage.googleapis.com/getscreenshot-storage/imageAbC123xYz9.png
saved: /work/page.png
page_status: 200
```

```text
getscreenshot-mcp capture <url> [--full-page] [--element SEL] [--device NAME]
                                [--width N] [--height N] [--format png|jpeg]
                                [--wait-until X] [--wait-ms N] [--hide SEL]
                                [-o FILE] [--json]
getscreenshot-mcp pdf <url> [--wait-until X] [--wait-ms N] [--hide SEL] [-o FILE] [--json]
getscreenshot-mcp usage [--json]
getscreenshot-mcp --help | --version
```

- `-o FILE` downloads the original full-resolution file. A `.jpg` or `.jpeg` name selects JPEG unless `--format` says otherwise.
- `--json` prints one JSON object: `screenshot_url` (or `pdf_url`), `origin_url`, `page_status`, `captured_at`, `format` (capture only), `saved_to`, `expires_in_days`. `usage --json` prints `used`, `limit`, `remaining`, `period`, `quota_restart_date`. A failure with exit code 1 also prints `{"error": {"code", "message"}}` on stdout.
- Exit codes: `0` success, `1` the capture or download failed (the message on stderr says what to change), `2` bad arguments, for example an unknown `--device` name or a flag the subcommand does not support, such as `pdf --element` (nothing is captured and no quota is used).
- With no arguments the bin starts the MCP server on stdio. `--http` starts the hosted server.

## Agent skill

The package ships an agent skill named `getscreenshot` in `skills/`. Install it with:

```bash
npx skills add rasterwise/getscreenshot-mcp
```

## Limits

- No localhost. A hosted API cannot reach `localhost` or private networks. Use `render_html`, or a public preview URL or tunnel. Such URLs are rejected before any quota is used.
- Single-shot captures. One page load per call, with an optional click, cookie, CSS and JS. Logged-in, multi-step browsing sessions are what browser-automation tools such as Playwright MCP are for.
- Failed captures still count against the monthly quota. The API charges one unit per authenticated request, so the server never retries a failed capture on its own. The only automatic retry is for a `429 Too Many Requests` rate limit (2 retries with backoff).
- Captures take about 9 seconds typically and up to about 25 seconds. The API gives up at 90 seconds.
- Sites with aggressive bot protection may refuse headless browsers.
- `render_html` in the local (stdio) server uploads the HTML to the hosted service at `mcp.getscreenshotapi.com`, because the capture API needs a public URL to load. The document is deleted as soon as the capture returns, and at the latest after 5 minutes or 3 reads.
- `compare_screenshots` compares at most the top 2,400 px of each image (at up to 1280 px wide). The local server can raise this with `COMPARE_MAX_HEIGHT`.
- The hosted server limits each caller to 60 tool calls per minute, runs at most 3 image jobs at a time, and holds at most 5 `render_html` documents per caller. When a limit is hit the tool returns an error that says how long to wait. A capture that already succeeded is still returned by URL.

## Environment variables

Local server and CLI:

| Variable | Default | Purpose |
|---|---|---|
| `GETSCREENSHOT_API_KEY` | | Your API key. |
| `GETSCREENSHOT_API_BASE` | `https://api.rasterwise.com` | REST API base URL. For tests. |
| `GETSCREENSHOT_MCP_BASE` | `https://mcp.getscreenshotapi.com` | Service that hosts HTML for `render_html` in stdio mode. |
| `COMPARE_MAX_HEIGHT` | `2400` | Rows `compare_screenshots` compares at most. A compare holds about 12 bytes per compared pixel in memory, so raise it only with memory to spare. |
| `INLINE_MAX_BYTES_STANDARD` | `1500000` | Cap on the total inline JPEG bytes of one result at `detail: "standard"`. |
| `INLINE_MAX_BYTES_HIGH` | `4000000` | The same at `detail: "high"`. |
| `IMAGE_CONCURRENCY` | `3` | Image jobs (download and resize, or compare) that run at once. |
| `IMAGE_QUEUE_MAX` | `24` | Image jobs that may wait for a slot. Beyond this a job is refused at once. |
| `IMAGE_QUEUE_WAIT_MS` | `20000` | Longest a job waits for a slot before it is refused. |

Hosted server (`getscreenshot-mcp --http`). All of the above apply, plus:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port to listen on. |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:<port>` | Public origin of the MCP endpoint. Must be set in production. |
| `HTML_PUBLIC_BASE_URL` | value of `PUBLIC_BASE_URL` | Public origin used in `render_html` links (`/h/<id>`). Point this at a throwaway domain so a flagged page cannot damage the MCP hostname. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Tool calls per caller per minute. A caller is the API key (as a SHA-256 hash), or the client address when no key is sent. |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | `120` | Tool calls per client address per minute, across all keys it sends. Stops a caller from getting a fresh allowance by inventing keys. |
| `HTML_MAX_DOCS_PER_CALLER` | `5` | Live `render_html` documents per caller. One client address may hold four times this across keys. |
| `SHARP_CONCURRENCY` | `1` | libvips threads per image job. |
| `TRUSTED_PROXY_HOPS` | `0` | Proxies between Google's front end and the container that append to `X-Forwarded-For`. `0` for Cloud Run reached directly or by domain mapping, `1` behind an external load balancer. A value above `0` is only safe when the service is deployed with `--ingress internal-and-cloud-load-balancing`; otherwise a caller who reaches the service directly chooses the address that is trusted. |
| `TRIAL_API_KEY` | unset | Turns on keyless preview mode, see below. Off by default. Not for production yet. |
| `TRIAL_DAILY_LIMIT_PER_IP` | `5` | Preview captures per client address per UTC day. |
| `TRIAL_DAILY_LIMIT_GLOBAL` | `200` | Preview captures per UTC day in total. |

Client addresses are IPv4 addresses, or the /64 of an IPv6 address.

Routes:

| Route | Purpose |
|---|---|
| `POST /mcp` | Stateless Streamable HTTP. A fresh server per request, no sessions. One JSON-RPC message per POST: a batch (JSON array) is rejected with error `-32600`. `GET` and `DELETE` answer 405. CORS is open for browser-based clients. |
| `GET /healthz` | `{"status":"ok","version":"..."}` |
| `GET /` | 302 to <https://www.getscreenshotapi.com/agents/> |
| `POST /v1/html` | Body is raw HTML (at most 2 MB), key in `Authorization: Bearer` or `x-api-key`. Returns `{"url", "expires_in_seconds"}`. Used by the local server's `render_html`. Answers 429 when the caller is over a limit and 503 when the store is full. |
| `GET /h/:id` | Serves a stored document with `Content-Security-Policy: sandbox allow-scripts`, `X-Robots-Tag: noindex`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. |
| `DELETE /h/:id` | Removes a document. Needs the key that uploaded it. Used by the local server once its capture has returned. |

Authentication is by header only: `Authorization: Bearer <API key>` or `x-api-key: <API key>`. The query string is never read for a key.

### Logging

The server writes one JSON line per request to stdout: method, path without the query string, status, duration, whether a key was sent and in which header, and the tool name and outcome. It does not write API keys, query strings, request bodies, tool arguments or the ids of hosted documents.

The platform keeps its own request log, which this server does not control. Cloud Run's request log records the full URL of every request, including the path of `GET /h/<id>` and anything a client puts in a query string. This is why keys are only accepted in headers.

### Limits that protect the service

A key cannot be verified without spending the caller's quota, so every limit below applies whether or not the key is valid. All of them are held in the memory of the one instance.

- Request targets that are not a plain path (`//host`, absolute URLs, `*`) get a 400. A request must deliver its headers and body within 15 seconds or the connection is closed with a 408. Bodies are capped at 6 MB for `/mcp` and 2 MB for `/v1/html`.
- Tool calls are limited per caller and per client address (`RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_IP_PER_MINUTE`). Over the limit, the tool returns an error with the number of seconds to wait.
- Downloading, resizing and comparing images goes through one gate (`IMAGE_CONCURRENCY`, `IMAGE_QUEUE_MAX`, `IMAGE_QUEUE_WAIT_MS`). When it is full, `compare_screenshots` is refused before anything is captured. A capture that already succeeded is returned by URL with a warning instead of an image.
- Memory per image job is bounded. Slices are encoded one at a time, which measured 30 to 50 MB for the largest pages (3840x20000 px, `high`, 10 slices). A compare is capped at 2,400 rows and measured 50 to 60 MB. Inline images are capped in bytes (`INLINE_MAX_BYTES_*`). With 3 jobs at a time, a sustained worst-case load test kept the process under 500 MB (measured on macOS; not yet measured in the Linux container).
- HTML documents: at most 5 live per caller and 20 per client address, 60 uploads per minute per client address (`POST /v1/html` and `render_html` together), 200 documents and 100 MB in total. When the store is full a new document is refused; documents that are already there are never evicted. A `render_html` document is deleted as soon as its capture returns, and otherwise after 5 minutes or 3 reads.
- `POST /v1/html` only checks that a key-shaped value was sent. The capture that follows is what the API authenticates.

The service must run as a single instance (`deploy.sh` sets `--max-instances 1`). `HtmlStore` in `src/html-store.ts` is the interface to implement for a shared store.

### Keyless preview mode

Off by default. Do not enable it in production yet: its daily counters are kept in the memory of the process and reset on every restart, new revision and scale-to-zero, so the limits are not reliable until a persistent counter exists. The server logs a warning at startup when `TRIAL_API_KEY` is set.

When `TRIAL_API_KEY` is set, a request without a key uses that key, within the two daily limits. Only `capture_screenshot` is allowed, and only as a plain viewport capture: no `full_page`, no `element`, `scale` 1, no `click`, `custom_js`, `custom_css` or `cookie`, `wait_ms` at most 5000, and a viewport of at most 1920x1200. Pages on the server's own hostnames are refused, so an uploaded HTML document cannot be captured without a key. The result says it was a preview capture and how to get a key; past the limit the tool returns that message as an error. The client address is the right-most `X-Forwarded-For` entry, which on Cloud Run is the one appended by Google's front end and cannot be forged by the client; IPv6 addresses count by their /64.

### Deploying

```bash
GCP_PROJECT=my-project ./deploy.sh          # prints what it would run and exits
GCP_PROJECT=my-project ./deploy.sh --yes    # deploys to Cloud Run
```

`deploy.sh` needs `GCP_PROJECT` (the Google Cloud project id) and refuses to run without it. It deploys service `$SERVICE` (default `getscreenshot-mcp`) to region `$REGION` (default `us-central1`) with `--max-instances 1`, `--memory 2Gi` and `--timeout 300`, and sets `PUBLIC_BASE_URL` (default `https://mcp.getscreenshotapi.com`) and, if given, `HTML_PUBLIC_BASE_URL`.

Each deploy replaces the service's environment variables and secrets. Preview mode is on only when `TRIAL_API_KEY_SECRET` names a Secret Manager secret; when it is unset, the script passes `--clear-secrets`, so a `TRIAL_API_KEY` attached by an earlier deploy is removed.

To serve `render_html` documents from their own hostname, map a second domain to the same service and set `HTML_PUBLIC_BASE_URL` to it. That hostname then serves only `/h/<id>`, and the MCP hostname serves no HTML documents.

The `Dockerfile` is a multi-stage `node:22-slim` build that runs as the unprivileged `node` user. It starts Node with `--expose-gc`, so the server can ask for a garbage collection after each image job instead of letting dead pixel buffers pile up, and sets `MALLOC_ARENA_MAX=2` to limit allocator fragmentation.

## Development

Requires Node.js 20.9 or newer.

```bash
npm install
npm run typecheck   # tsc --noEmit over src and test
npm run build       # tsc to dist/
npm test            # builds, then runs the vitest suite
```

The tests make no calls to the real API. `test/helpers/fake-upstream.ts` is a local HTTP server that mimics the REST API and its image storage: the success JSON points at PNGs it generates and serves (including a 1280x6000 one), every error in the API's error table can be triggered, and, like the real gateway, it rejects every key that is not on its list of valid test keys. On top of it the suite covers:

- `test/api.test.ts`: the exact query parameters received for every input, including the ones that must not be sent, and every error row mapped to its message.
- `test/vision.test.ts`: slice math and token estimates as tables, real image slicing, the inline byte budget, and the download allow-list.
- `test/diff.test.ts`, `test/html-store.test.ts`, `test/limits.test.ts`: the diff, the HTML store (per-caller caps, reject when full), and the rate limiters and image gate.
- `test/mcp.e2e.test.ts`: a real MCP `Client` over the SDK's in-memory transport calling each tool; image blocks are decoded and checked against the sizing rules and `structuredContent` is validated against each `outputSchema`.
- `test/http.test.ts`: the HTTP server on an ephemeral port with the SDK's Streamable HTTP client, plus raw sockets for malformed request lines, stalled bodies, batches and the limits.
- `test/cli.test.ts`: the built bin as a child process (CLI, stdio server, `--http` with SIGTERM, malformed requests and uncaught errors against the real process).

Run the server against a local fake or staging API by setting `GETSCREENSHOT_API_BASE`. Downloads are only allowed from `https://storage.googleapis.com` and, when the base is overridden, from that base's origin. Redirects are refused and downloads are capped at 25 MB.

Source layout:

| File | Role |
|---|---|
| `src/api.ts` | REST client, parameter mapping, error mapping. |
| `src/download.ts` | Allow-listed, size-capped downloads. |
| `src/vision.ts` | Downscale, slice, JPEG encode, token estimates. |
| `src/diff.ts` | Image comparison. |
| `src/html-store.ts` | Temporary HTML documents. |
| `src/limits.ts` | Caller identity, rate limiters, the image gate. |
| `src/tools.ts`, `src/server.ts` | The five tools and the MCP server. |
| `src/stdio.ts`, `src/http.ts`, `src/cli.ts`, `src/bin.ts` | Entry points. |

## Links

- Agents hub: <https://www.getscreenshotapi.com/agents/>
- Docs: <https://docs.rasterwise.com/docs/agents/mcp-server/>
- Pricing and API keys: <https://www.getscreenshotapi.com/#pricing>
- Account, usage and key recovery: <https://www.getscreenshotapi.com/account>
- Support: <support@rasterwise.com>

MIT License. Copyright (c) 2026 Rasterwise, LLC.
