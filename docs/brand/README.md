# Brand: three app-icon directions

Three original icon directions for the editor, for the owner to choose from. **Nothing here is wired into the product. The owner picks a direction first; only then is any file under `resources/` or `src/` replaced.**

None of the directions uses a letter or depends on the product name, so the rename does not affect them.

## What is here

| Path | What it is |
|---|---|
| `direction-a/`, `direction-b/`, `direction-c/` | One folder per direction: `icon.svg` (full colour, 1024 canvas, macOS grid), `mono.svg` (single colour, `currentColor`, 16-unit grid), and the PNG renders |
| `direction-*/icon-{16,32,64,128,256,512,1024}.png` | Renders of `icon.svg`, transparent background |
| `direction-*/mono-{16,32,64}-{light,dark}.png` | Renders of `mono.svg`: black on a light swatch, white on a dark swatch |
| `sheet-light.png`, `sheet-dark.png` | Comparison sheets: all three at 16, 32, 64, 128, 256 px, the 16 px render enlarged 8 times, the mono glyphs, and a mock Dock strip |
| `wordmark-template.svg` | Lockup template: glyph slot plus a "Name" placeholder with the spacing rules |
| `similarity-check.md` | Written check against the Cursor, VS Code, Zed and Windsurf icons |
| `render.mts` | Regenerates every PNG from the SVGs |

All icon SVGs are hand-written: a rounded-rectangle body of 824 x 824 centred on the 1024 canvas with corner radius 185, a soft drop shadow, and two shapes. No embedded rasters, no fonts, no text.

## The three directions

### A, Hunk

Two horizontal bars, offset sideways like a diff hunk. The upper bar is solid: a change that was accepted. The lower bar is open: a proposal still waiting for review. Near-black on an amber body.

Why: reviewing proposed edits one hunk at a time is the thing the product does all day. The icon shows that state directly, with no reference to AI.

### B, Gauge

An instrument dial, a thick arc open at the bottom, with one short needle. Near-black arc and a vermilion needle on an off-white body.

Why: the product treats the model as a component you measure on your own machine. A dial with one reading says "instrument", and the single red needle is the only accent.

### C, Split

A disc cut by a vertical seam. The left half is solid: kept. The right half is faint and has slipped down along the seam: refused, not in line. Off-white on a deep wine-red body. It can also be read as a cut stone showing two planes.

Why: exact-or-refuse. An edit either lands exactly or does not land at all, and the icon shows both outcomes side by side.

## Size tests

Every size was rendered directly from the vector (not scaled down from a large bitmap) and looked at, both as individual files and on the sheets, where the 16 px render is also shown enlarged 8 times with no smoothing.

| Direction | 16 px | 32 px | 64 px and up |
|---|---|---|---|
| A | Both bars are clear. The bars sit on whole pixels at 16 px, so the solid bar is crisp. The open bar shows a one-pixel amber slot; its ends go soft. It reads as "dark bar, striped bar". | Solid and open are clearly different. | Clean. |
| B | The arc reads as a dark arch. The needle is two or three pinkish pixels, so the red is mostly lost and the needle reads as a smudge inside the arch. This is the weakest of the three at 16 px. | Arc and red needle both clear. | Clean. |
| C | The solid half is crisp. The faint half reads as a mauve half-disc. The slip along the seam is about one pixel and is barely visible, so at this size it is a two-tone disc. | The slip is visible. | Clean. |

Mono glyphs at 16 px: A is clear (the open bar keeps a visible hole). B is legible, but the needle nearly touches the arc. C is clear but needs two tones (the faint half is 45% opacity), so it would fail anywhere that flattens alpha to one bit.

### Weaknesses, plainly

- **A**: two offset blocks are close to list and alignment glyphs seen in toolbars. The amber body does most of the recognition work, and amber is the loudest of the three bodies in a Dock.
- **B**: a dial is a common picture (speed tests, system monitors), so it is the least ownable. The off-white body has a weak edge on light backgrounds and depends on the shadow there. Colour is lost at 16 px.
- **C**: a half-filled disc is the usual symbol for appearance or contrast settings. The mono version depends on alpha. The dark red body has the least contrast of the three against a dark wallpaper, though it stayed readable in the dark Dock mock.
- **All three**: the corner shape is a plain rounded rectangle with radius 185, not Apple's continuous-curvature shape. At icon sizes the difference is small, but a final version should redraw the body on Apple's template. The Dock strip is a mock made with CSS, not a screenshot of a real Dock. None of these has been tested as a real `.icns` in Finder, the Dock or the app switcher.

## Light and dark tests

`sheet-light.png` puts the icons on a light page and a light wallpaper gradient; `sheet-dark.png` does the same on dark. What I saw:

- A holds on both. Amber separates from light and dark grounds alike.
- B is strong on dark and softer on light, where body and page are both pale.
- C is strong on light and a little recessed on dark.
- Mono glyphs were rendered black on `#f2f2f2` and white on `#1e1e1e` at 16, 32 and 64 px. All three hold in both.

## How the renders were produced

Renderer: headless Chromium, driven by the `playwright` package already in the repository's `node_modules`. Each SVG is placed inline in a blank page whose viewport is exactly the target size at device scale 1, and the page is captured with a transparent background. The sheets are HTML pages built by the same script and captured in full.

Command, from the repository root, with Node 24:

```sh
node docs/brand/render.mts
```

The Chromium revision that this playwright version pins was not in the local playwright cache, so the script fell back to the newest cached build (headless shell revision 1228). The script does this on its own. To force a browser, set `BRAND_CHROMIUM` to an executable path. Nothing was installed.

Checks made on the output:

```sh
sips -g hasAlpha -g pixelWidth docs/brand/direction-a/icon-16.png   # hasAlpha: yes, pixelWidth: 16
du -sh docs/brand                                                    # under 1 MB
```

`qlmanage -t -s 64 -o <temp dir> docs/brand/direction-a/icon.svg` also produced a 64 px PNG with alpha. It was only confirmed to run; its output is not used and was not compared pixel for pixel.

For the similarity check, the installed Cursor icon was converted outside the repository:

```sh
sips -s format png <Cursor bundle>/Contents/Resources/Cursor.icns --out <temp dir>/cursor.png
sips -z 128 128 <temp dir>/cursor.png --out <temp dir>/cursor-128.png
```

## Wordmark template

`wordmark-template.svg` is a lockup that works for any name. With G as the glyph height (128 in the file):

- Glyph slot: G x G square at left. Paste the chosen direction's `mono.svg` shapes into `#glyph-slot`, scaled by 8.
- Gap between glyph and first letter: 0.375 G (48).
- Clear space around the lockup: 0.25 G (32).
- Text: system font stack (`-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Inter, 'Helvetica Neue', Arial, sans-serif`), weight 600, size 0.8125 G (104), tracking -0.02 em, first letter capitalised.
- Baseline at y = 165, which centres the cap height on the glyph.
- One colour: both parts use `currentColor`.

The template uses live text so any name can be dropped in. It will look different on machines with different system fonts. **Once the name is chosen, convert the text to outlines** and check the spacing by eye; that outlined file is the final wordmark. The template was rendered once to confirm it draws; in headless Chromium it fell back to Helvetica, so the preview is not what San Francisco will give.

## After the owner picks: files that carry the current icon

Found by listing `resources/darwin`, `resources/linux`, `resources/win32`, `resources/server` and by searching the build scripts and sources for `code.icns`, `code.ico`, `code.png`, `code-192`, `code-512`, `letterpress` and `code-icon`.

| File | Format and size now | Used by |
|---|---|---|
| `resources/darwin/code.icns` | iconset of 16, 32, 128, 256, 512, each at 1x and 2x | `build/lib/electron.ts` (app icon), `build/darwin/create-dmg.ts` (disk icon) |
| `resources/linux/code.png` | PNG, 1024 x 1024 | `build/gulpfile.vscode.linux.ts`, `build/gulpfile.vscode.ts` |
| `resources/linux/rpm/code.xpm` | XPM | RPM packaging |
| `resources/win32/code.ico` | multi-size ICO | `build/lib/electron.ts`, `build/gulpfile.vscode.win32.ts`, `build/gulpfile.vscode.ts` |
| `resources/win32/sessions.ico` | multi-size ICO (9 sizes) | `build/gulpfile.vscode.ts` |
| `resources/win32/code_70x70.png`, `code_150x150.png` | PNG, 70 and 150 px | Windows tiles (`VisualElementsManifest.xml`) |
| `resources/win32/inno-big-{100..250}.bmp` | BMP, 164 x 314 up to 410 x 797 | Windows installer side panel |
| `resources/win32/inno-small-{100..250}.bmp` | BMP, 55 x 55 up to 138 x 140 | Windows installer header |
| `resources/server/code-192.png`, `code-512.png` | PNG (both files are 1024 x 1024 today despite their names) | `resources/server/manifest.json`, `build/gulpfile.reh.ts`, `build/gulpfile.vscode.web.ts` |
| `resources/server/favicon.ico` | multi-size ICO (5 sizes) | web and server builds |
| `src/vs/workbench/browser/media/code-icon.svg` | SVG, 1024 viewBox | workbench window icon |
| `src/vs/workbench/browser/parts/editor/media/letterpress-{dark,light,hcDark,hcLight}.svg` | SVG, 260 viewBox | empty-editor watermark |
| `src/vs/sessions/browser/media/vscode-icon.svg` | SVG, 96 viewBox | sessions window |
| `src/vs/sessions/contrib/chat/browser/media/letterpress-sessions-{dark,light}.svg` | SVG | sessions watermark |
| `extensions/github-authentication/media/code-icon.svg`, `favicon.ico`; `extensions/microsoft-authentication/media/favicon.ico` | SVG, ICO | sign-in landing pages. Found by name only; look at them before replacing. |

The other `.icns` and `.ico` files in `resources/darwin` and `resources/win32` (`bat`, `c`, `css` and so on) are document-type icons. I did not open them to see whether they carry the application mark.

### Commands

Set the chosen direction first. Work in a temporary folder and copy only the finished files into `resources/`.

```sh
D=docs/brand/direction-a          # the chosen direction
T=$(mktemp -d)

# macOS .icns: the renders already cover every slot, so no rescaling is needed
I=$T/code.iconset && mkdir -p $I
cp $D/icon-16.png   $I/icon_16x16.png
cp $D/icon-32.png   $I/icon_16x16@2x.png
cp $D/icon-32.png   $I/icon_32x32.png
cp $D/icon-64.png   $I/icon_32x32@2x.png
cp $D/icon-128.png  $I/icon_128x128.png
cp $D/icon-256.png  $I/icon_128x128@2x.png
cp $D/icon-256.png  $I/icon_256x256.png
cp $D/icon-512.png  $I/icon_256x256@2x.png
cp $D/icon-512.png  $I/icon_512x512.png
cp $D/icon-1024.png $I/icon_512x512@2x.png
iconutil -c icns $I -o $T/code.icns        # then copy to resources/darwin/code.icns

# Linux and server PNGs
cp $D/icon-1024.png $T/code.png            # resources/linux/code.png
sips -z 192 192 $D/icon-1024.png --out $T/code-192.png
cp $D/icon-512.png $T/code-512.png

# Windows tiles and installer header bitmaps
sips -z 70 70   $D/icon-1024.png --out $T/code_70x70.png
sips -z 150 150 $D/icon-1024.png --out $T/code_150x150.png
sips -s format bmp -z 55 55 $D/icon-1024.png --out $T/inno-small-100.bmp   # repeat per scale

# Windows .ico, one size per file
sips -s format ico -z 256 256 $D/icon-1024.png --out $T/code-256.ico
```

I ran the `.icns` steps, the PNG resize, and the BMP and ICO conversions once in a temporary folder for direction A; all of them produced valid files. The results were not copied anywhere.

What these tools cannot do, and what is therefore still open:

- `sips` writes an ICO with a single size. `code.ico`, `sessions.ico` and `favicon.ico` hold several sizes each, so they need a tool that is not on this machine (ImageMagick or a small script). Nothing was installed for this.
- `code.xpm` needs a converter that is not on this machine either.
- The `inno-big` bitmaps are tall installer panels with artwork, not plain icons. They need a layout of their own.
- The BMP from `sips` is 32-bit with alpha; the installer may want 24-bit on a solid ground. Check against the existing files.
- For sizes other than those rendered here (20, 24, 40, 48 for ICO), add them to `iconSizes` in `render.mts` so they come from the vector, not from a rescale.
- The workbench SVGs (`code-icon.svg`, the letterpress files, `vscode-icon.svg`) should be redrawn from `mono.svg` at their own viewBox sizes. The letterpress files are one-colour watermarks, so `mono.svg` is the right source.
- On Linux and Windows the macOS margin (100 units of empty canvas around the body) makes the icon look small. Those platforms want a version with the body filling the canvas.

## Status

Proposal only. The owner picks a direction, or asks for changes, before anything is swapped.
