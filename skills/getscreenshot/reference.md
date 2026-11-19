# GetScreenshot reference

Read this only when SKILL.md points here: device names, extra API parameters, the usage endpoint, and commands for viewing a tall image in sections.

## Device presets (`--device NAME`, API `preset=NAME`)

A preset sets the viewport. Phone presets also send a mobile user agent.

| Kind | Names |
|---|---|
| Phones | `iphone5`, `iphone678`, `iphone678_plus`, `iphonex`, `iphone12`, `pixel2`, `pixel2_xl` |
| Tablets | `ipad`, `ipadpro` |
| Screen sizes | `hvga`, `wvga`, `dvga`, `wxga_v`, `xga`, `wxga_s`, `wxga_l`, `sxga`, `wsxga_plus` |

Names are exact and lowercase. The CLI rejects an unknown `--device` name before calling the API (exit code 2, no quota used). With curl, an unknown `preset` name makes the capture fail with a 500 and still uses quota.

With curl, a full-page capture that also uses a preset needs `noheight=true` instead of `fullpage=true`:

```bash
curl -sS -G "https://api.rasterwise.com/v1/get-screenshot" \
  --data-urlencode "apikey=$GETSCREENSHOT_API_KEY" \
  --data-urlencode "url=https://example.com" \
  --data-urlencode "preset=iphone12" \
  --data-urlencode "noheight=true"
```

## More API parameters (curl)

All parameters are lowercase query parameters on `GET https://api.rasterwise.com/v1/get-screenshot`. Authentication is the `apikey` query parameter. There is no header authentication on this endpoint.

| Parameter | Default | Meaning |
|---|---|---|
| `devicefactor` | 1 | Device pixel ratio. 2 gives a retina capture with four times the pixels. |
| `hidecookie` | true | Hides common cookie banners. Pass `false` to keep them in the image. |
| `hidemsg` | false | Hides common chat widgets (Intercom, Drift and similar). |
| `hideelement` | none | CSS selector(s) to hide before capture. |
| `customcss` | none | CSS injected before capture. |
| `customjs` | none | JavaScript injected before capture. |
| `click` | none | CSS selector to click before capture, for example to open a menu or dismiss a dialog. A selector that matches nothing makes the capture fail. |
| `highlight` | none | Keyword(s) to highlight on the page. |
| `cookie` | none | `name,value` cookie set for the target host. |
| `lang` | `en-US` | Browser language and Accept-Language. |
| `scrollmotion` | true | Scrolls the page first to trigger lazy-loaded content. |
| `forcetr` | false | Transparent background where the page sets none. |
| `strategy` | 0 | Full-page capture strategy, 0 to 3. Try another value if a full-page capture renders badly (repeated headers, blank areas). |
| `pdf` | false | Return an A4 PDF. The response has `pdfFile` instead of `screenshotImage`. |

Example: click a menu button, wait, then capture only the open menu at 2x.

```bash
curl -sS --max-time 100 -o menu.json -G "https://api.rasterwise.com/v1/get-screenshot" \
  --data-urlencode "apikey=$GETSCREENSHOT_API_KEY" \
  --data-urlencode "url=https://example.com" \
  --data-urlencode "click=button.menu-toggle" \
  --data-urlencode "timewait=1500" \
  --data-urlencode "element=nav.menu" \
  --data-urlencode "devicefactor=2"
```

Do not send passwords or session secrets through `cookie`, `customjs` or the URL. Results are stored at public URLs.

## Usage endpoint

```bash
curl -sS -G "https://api.rasterwise.com/v1/usage" \
  --data-urlencode "apikey=$GETSCREENSHOT_API_KEY" \
  --data-urlencode "email=x"
```

```json
{"usedQuota": 123, "remainingQuota": {"limit": 6000, "offset": 0, "period": "MONTH"}, "quotaRestartDate": "2026-12-01"}
```

- `remainingQuota.limit` is the monthly allowance, not what is left. Remaining = `remainingQuota.limit - usedQuota`.
- `email` must be present with any non-empty value, or the call returns 400.
- This call costs one quota unit. Do not poll it.

## Reading the JSON without jq

```bash
# with jq
img=$(jq -r '.screenshotImage // .pdfFile' shot.json)

# with sed
img=$(sed -n 's/.*"screenshotImage" *: *"\([^"]*\)".*/\1/p' shot.json)

# with python
img=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("screenshotImage") or d.get("pdfFile") or "")' shot.json)
```

An empty result means the call failed. Print the status code and the body (it never contains the key) and look it up in the error table in SKILL.md.

## View a tall image in sections

Check the size first, then cut slices about 1,000 px tall and view the ones you need. A 1280x1000 slice is roughly 1,700 image tokens.

```bash
# Size
file full.png                     # prints "... PNG image data, 1280 x 6400, ..."

# ImageMagick 7 (magick) or 6 (convert): one slice starting at y=2000
magick full.png -crop 1280x1000+0+2000 +repage part-2000.png

# ImageMagick: cut the whole image into 1000 px tiles (part-0.png, part-1.png, ...)
magick full.png -crop 1280x1000 +repage part-%d.png

# macOS without ImageMagick: crop height 1000, width 1280, offset y=2000 x=0
sips -c 1000 1280 --cropOffset 2000 0 full.png --out part-2000.png

# Python with Pillow
python3 -c 'from PIL import Image; im=Image.open("full.png"); im.crop((0,2000,im.width,3000)).save("part-2000.png")'
```

If none of these tools exist, do not view the full image. Capture the sections as separate `--element` captures instead.
