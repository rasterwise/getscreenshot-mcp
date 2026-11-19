---
name: getscreenshot
description: Capture screenshots of public web pages from a shell with the GetScreenshot API, then view the image to check how the page renders. Use when asked to screenshot a URL, look at a deployed or preview site, visually verify a frontend or CSS change (before/after), capture one element, a mobile device view, a full page, or save a page as PDF. Useful in sandboxes, CI runners and cloud agents that have no local browser. Needs only npx or curl plus the GETSCREENSHOT_API_KEY environment variable. Cannot reach localhost or private networks.
license: MIT
compatibility: Requires internet access, the GETSCREENSHOT_API_KEY environment variable, and either Node.js 20.9+ (for npx) or curl.
metadata:
  author: rasterwise
  version: "0.1.0"
---

# GetScreenshot

Take a screenshot of a public URL, save it to a file, then open the file with your image or file viewing tool.

```bash
npx -y getscreenshot-mcp capture "https://example.com" -o shot.png
```

A capture usually takes about 10 seconds and can take up to 90. Each call uses one screenshot of the monthly quota, including calls that fail.

If the `capture_screenshot` MCP tool is available in this session, prefer it. It returns images already sized for vision models. Use this skill when only a shell is available.

## 1. Check the API key first

```bash
[ -n "$GETSCREENSHOT_API_KEY" ] && echo "key set" || echo "key missing"
```

If it is missing, stop and tell the user:

- GetScreenshot needs an API key. Plans start at $5/month for 2,500 screenshots. Code `FREE5` makes the first month of the $5 plan free.
- Get a key at https://www.getscreenshotapi.com/#pricing. It is emailed after checkout. A lost key can be recovered at https://www.getscreenshotapi.com/account.
- Then set it: `export GETSCREENSHOT_API_KEY=<key>`.

Never print the key, and never write it into files, commit messages or reports. Refer to it as `$GETSCREENSHOT_API_KEY`.

## 2. Pick the smallest capture that answers the question

| You need to check | Use | Why |
|---|---|---|
| One component (header, card, form, modal) | `--element "<css selector>"` | Smallest image, sharpest detail |
| What a visitor sees first | default viewport (1280x800) | About 1,300 image tokens |
| Mobile layout | `--device iphone12` (or `pixel2`, `ipad`) | Sets viewport and a mobile user agent |
| A specific breakpoint | `--width 768 --height 1024` | Exact viewport in CSS px |
| Whole page layout, footer, long content | `--full-page` | Tall image. Read "Keep images small" first |
| A document to hand to a person | `pdf` | A4 PDF. Not for visual checks |

Start with an element or viewport capture. Go to full page only when the thing you need is below the fold and you cannot name a selector for it.

## 3. Capture with the CLI

```bash
# Viewport (default 1280x800, PNG)
npx -y getscreenshot-mcp capture "https://example.com/pricing" -o pricing.png

# One element
npx -y getscreenshot-mcp capture "https://example.com" --element "header nav" -o nav.png

# Mobile
npx -y getscreenshot-mcp capture "https://example.com" --device iphone12 -o mobile.png

# Full page
npx -y getscreenshot-mcp capture "https://example.com" --full-page -o full.png

# Slow or script-heavy page: stop waiting on the network, then give it 4 s to render
npx -y getscreenshot-mcp capture "https://example.com/app" --wait-until domcontentloaded --wait-ms 4000 -o app.png

# Hide things that cover the content
npx -y getscreenshot-mcp capture "https://example.com" --hide ".promo-banner, #chat-widget" -o clean.png

# PDF, and quota check (the usage call also costs one unit)
npx -y getscreenshot-mcp pdf "https://example.com/invoice/123" -o invoice.pdf
npx -y getscreenshot-mcp usage
```

After the command exits successfully, open the saved file with your file or image viewing tool and describe what you see. Do not claim a page looks right without viewing the image.

| CLI flag | API parameter | Default | Notes |
|---|---|---|---|
| `<url>` | `url` | required | Public http/https URL. URL shorteners are rejected. |
| `--full-page` | `fullpage` | off | Captures the full scrollable page. |
| `--element SEL` | `element` | none | CSS selector. If it matches nothing the capture fails with a 500. |
| `--device NAME` | `preset` | none | Device preset. The CLI rejects an unknown name before calling the API (exit code 2, no quota used). List in [reference.md](reference.md). |
| `--width N`, `--height N` | `width`, `height` | 1280, 800 | Viewport in CSS px. |
| `--format png\|jpeg` | `format` | `png` | Use `jpeg` for photo-heavy pages to get a smaller file. |
| `--wait-until X` | `waituntil` | `networkidle2` | `load`, `domcontentloaded`, `networkidle0`, `networkidle2`. `domcontentloaded` is the fastest and most reliable on heavy sites. |
| `--wait-ms N` | `timewait` | 2000 | Extra wait before capture, in ms. |
| `--hide SEL` | `hideelement` | none | CSS selector(s) set to `display:none` before capture. |
| `-o FILE` | | | Also download the image or PDF to this file. Without it the command only prints the URL. |
| `--json` | | | Print the result as JSON (includes the public screenshot URL). |

Cookie banners are hidden by default, and the page is scrolled before capture so lazy-loaded content appears.

## 4. Capture with curl (no Node.js needed)

The API is one GET endpoint. It always answers with JSON, never image bytes. Read `screenshotImage` from the JSON, then download that URL.

```bash
curl "https://api.rasterwise.com/v1/get-screenshot?apikey=$GETSCREENSHOT_API_KEY&url=https%3A%2F%2Fexample.com&fullpage=true"
```

In scripts, let curl do the URL encoding and keep the HTTP status:

```bash
status=$(curl -sS --max-time 100 -o shot.json -w '%{http_code}' -G \
  "https://api.rasterwise.com/v1/get-screenshot" \
  --data-urlencode "apikey=$GETSCREENSHOT_API_KEY" \
  --data-urlencode "url=https://example.com/pricing" \
  --data-urlencode "element=.pricing-table")
echo "HTTP $status"

# Only on 200: pull the image URL out of the JSON and download it
img=$(sed -n 's/.*"screenshotImage" *: *"\([^"]*\)".*/\1/p' shot.json)
curl -sS -o shot.png "$img"
```

Success body:

```json
{
  "status": "success",
  "originUrl": "https://example.com/pricing",
  "pageStatus": 200,
  "captureDate": "2026/11/18",
  "captureHour": "14:03:22",
  "screenshotImage": "https://storage.googleapis.com/getscreenshot-storage/imageAbC123xYz9.png"
}
```

Check `pageStatus` too. A 404 or 500 there means you captured the site's error page. With `pdf=true` the field is `pdfFile` instead of `screenshotImage`. More parameters (device pixel ratio, custom CSS, click before capture, cookies, language) are in [reference.md](reference.md).

Do not paste a command line with the key expanded into your output. The key is a query parameter, so any printed URL would leak it.

## 5. Keep images small

Image cost grows with pixel area. A rough estimate is `ceil(width/28) * ceil(height/28)` tokens.

- Prefer `--element`, then a viewport capture. A 1280x800 viewport is roughly 1,300 image tokens.
- Leave the device pixel ratio at 1. `devicefactor=2` (curl only) quadruples the pixels. Use it only to inspect fine detail such as icon rendering or thin borders, and combine it with `element`.
- A full-page capture of a long page can be 1280 px wide and many thousands of px tall. Most image viewers scale that down until text is unreadable. Instead of viewing it whole:
  - capture the sections you care about as separate `--element` captures (for example `main`, `footer`, `#pricing`), or
  - save the full page once and view it in sections by cropping it locally. Crop commands are in [reference.md](reference.md).
- A smaller viewport costs less: `--width 800 --height 800` is about 840 tokens. It may switch the site to its tablet layout, so use it only when the desktop layout is not what you are checking.

## 6. Verify a UI change (before and after)

1. Decide the one or two captures that prove the change: the element you are changing, at the viewport(s) that matter. Write down the exact flags.
2. Capture the current state from the URL that serves it (production, staging, or the existing preview):
   `npx -y getscreenshot-mcp capture "$URL" --element ".site-header" -o before.png`
3. Make the change. Deploy it to a public preview URL. The API cannot load `localhost`.
4. Capture again with the same flags against the preview URL:
   `npx -y getscreenshot-mcp capture "$PREVIEW_URL" --element ".site-header" -o after.png`
5. View `before.png` and `after.png`. Check the specific thing that was supposed to change, then check that nothing next to it moved or broke (alignment, wrapping, overflow, contrast).
6. If the change is responsive, repeat steps 2 to 5 with `--device iphone12` or the relevant `--width`.
7. Report what you saw in plain terms and include both file names. If the result is wrong, fix it and capture again. Do not capture repeatedly without changing something: every capture costs quota.

If the GetScreenshot MCP server is connected, its `compare_screenshots` tool produces a pixel diff of two URLs or two earlier screenshots.

## 7. Errors

| Response | Meaning | What to do |
|---|---|---|
| 401 `{"message":"Unauthorized"}` | `apikey` parameter missing | Set `GETSCREENSHOT_API_KEY` and pass it. |
| 500 `{"message": "error"}` with header `x-amzn-errortype: AuthorizerConfigurationException` | API key not recognised (the usual answer for an unknown key) | The key is wrong or mistyped. Ask the user to check it at https://www.getscreenshotapi.com/account. Do not retry. |
| 403 `{"message":"Forbidden"}` | Key disabled (subscription cancelled or payment failed). An unknown key can also get this answer | Tell the user to check the key and their subscription. Do not retry. |
| 429 `{"message":"Limit Exceeded"}` | Monthly quota used up | Stop. Tell the user. The quota resets at the start of the next billing month. |
| 429 `{"message":"Too Many Requests"}` | Rate limited | Wait a few seconds and retry, at most twice. |
| 400 `{"status":"denied","message":"Bad posture."}` | `url` missing or not a valid http(s) URL | Fix the URL. Include the scheme. URL-encode it when using curl by hand. |
| 403 `{"status":"denied","message":"Access denied - URL not allowed (shortener or blocked domain)"}` | Blocked URL | Use the final destination URL, not a shortener. |
| 500 `{"status":"failed","message":"Could not load the target page within the time limit. ..."}` | Page did not load | Retry once with `--wait-until domcontentloaded`. If it still fails the site is down, very slow, or blocks automated browsers. |
| 500 plain text `Internal Server Error` | Capture crashed | Almost always a selector that matches nothing (`--element`, or `click` via curl) or, with curl, an unknown `preset` name. Fix the selector or name. If unsure of the selector, take a viewport capture first and look. |
| 504 `{"message": "error"}` | Took longer than 90 s | Retry once with `--wait-until domcontentloaded` and without `--full-page`. |

Failed calls still use quota. Change something before each retry.

## 8. Limits

- **No localhost or private networks.** The capture runs on GetScreenshot's servers, so `localhost`, `127.0.0.1`, `*.local` and VPN-only hosts are unreachable. Options: deploy to a public preview URL, expose the dev server through a tunnel, or, for a single HTML file or component, use the `render_html` tool of the GetScreenshot MCP server, which takes an HTML string.
- **Screenshots are public for 30 days.** Each result is stored at a public URL with a random file name. Anyone with the link can open it. Do not capture pages that show secrets, tokens, personal data or anything the user would not post in a shared channel. Do not put credentials in the URL you capture.
- **One page load per call.** There is no session, no multi-step navigation and no logged-in browsing. For flows that need clicks across pages or a login, use a browser automation tool instead.
- **Some sites block headless browsers.** Sites with aggressive bot protection may return a challenge page or fail to load.
- **PNG or JPEG only** for images. PDF output is A4.
