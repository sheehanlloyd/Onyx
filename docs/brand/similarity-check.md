# Similarity check against other editors' icons

Date of the check: 2026-11-22.

This is a designer's visual check, not a legal opinion. It compares shape, glyph, colour scheme and layout by eye. It does not assess trademark registrations, classes of goods, or likelihood of confusion in the legal sense. Anyone who needs that should ask a trademark lawyer before launch.

No third-party icon, and no image containing one, is stored in this repository. The comparison image (the installed Cursor icon beside the three directions at 128, 32 and 16 px) was made in a temporary directory outside the repository, looked at, and left there.

## What the other icons look like

| Product | Source | Body shape | Glyph | Colours | Layout |
|---|---|---|---|---|---|
| Cursor | installed application (the `.icns` in its bundle resources, converted with `sips`), 2026-11-22 | macOS rounded square, flat near-black | A faceted hexagonal solid, read as a cube seen corner-on, with one bright white triangular facet pointing right and down | Black body, greys from mid to dark, one white facet. No hue. | Single centred glyph filling about 60% of the body |
| VS Code | `https://code.visualstudio.com/brand`, viewed 2026-11-22 | No body in the brand mark; the glyph is free-standing | A folded ribbon: a tall slab at right and two crossing bands at left that form a sideways chevron pair | Blues from mid to light. A white version exists for blue backgrounds. | Single free-standing glyph, leaning right |
| Zed | `https://raw.githubusercontent.com/zed-industries/zed/main/crates/zed/resources/app-icon.png` and the favicons declared by `https://zed.dev/`, viewed 2026-11-22 | macOS rounded square, near-black with a faint grain | A thin-line capital Z made from one diagonal stroke and concentric square spirals, fading to grey at lower right | Black body, white line work. No hue. | Single centred line glyph, about 50% of the body |
| Windsurf | `https://windsurf.com/brand`, viewed 2026-11-22. The site root now redirects to `https://devin.ai/desktop`, so the Devin Desktop touch icon (`https://devin.ai/apple-icon.png`) was viewed too. | Windsurf: the brand page shows the mark free-standing on dark navy; I did not see a macOS app icon for it. Devin Desktop: rounded square, near-black. | Windsurf: two slanted wave crests drawn as parallel strokes, close to a W. Devin Desktop: three white hexagons joined at a round centre. | Windsurf: white mark, dark navy ground, mint-green accent. Devin Desktop: black and white. | Windsurf: mark to the left of a wordmark. Devin Desktop: single centred glyph. |

What this shows: three of the four neighbours in the Dock are a black rounded square with a white or grey centred glyph. The fourth is blue. So the crowded positions are "black body, light glyph" and "blue".

## The three directions

| Direction | Shape | Glyph | Colour scheme | Layout | Verdict |
|---|---|---|---|---|---|
| A, Hunk | Same macOS rounded square as every Dock icon. That shape is the platform grid, shared by all of them. | Two flat horizontal bars, one solid, one open, offset sideways. No facets, no diagonal, no ribbon, no hexagon, no wave. Not close to any of the four. | Amber body, near-black glyph. None of the four uses yellow or amber. | Two elements, stacked and offset, not one centred emblem. Different from all four. | Distinct on glyph, colour and layout. |
| B, Gauge | Same platform rounded square. | A thick arc open at the bottom and a short needle. Curved and round-capped, where Cursor, Zed and Devin Desktop are all straight-edged. Not close to any of the four. | Off-white body, near-black arc, one vermilion needle. It is the only light-bodied icon in the set. The black and white is the inverse of Cursor and Zed, and the red accent appears in none of them. | Single centred glyph, as in Cursor and Zed. This is the one dimension it shares, and it is the most common icon layout there is. | Distinct on glyph and colour. Shares only the generic centred layout. |
| C, Split | Same platform rounded square. | A disc cut by a vertical seam, left half solid, right half faint and slipped down. Round, flat, two parts. Cursor's glyph also has a bright part and dimmer parts, but as facets of a solid with straight edges; this has no depth and no straight outer edge. | Deep wine red body, off-white glyph. None of the four uses red. | Single centred glyph, as in Cursor and Zed. | Distinct on glyph and colour. Shares only the generic centred layout. |

## Changes made because of this check and the avoid list

1. Direction A was first planned as a graphite body with an off-white bar and an amber bar. After looking at the installed Cursor icon (black body, light glyph) I moved A to an amber body with near-black bars before drawing it. Seeing Zed and Devin Desktop afterwards, also black bodies with white glyphs, confirmed that. No direction now uses a black or dark neutral body.
2. Direction C was first drawn with the right half as an outlined half-disc. Rendered at 128 and 256 px it read as a capital letter D. That breaks the "no letterform" rule, so I replaced the outline with a faint solid half and slipped it down along the seam. Viewed again at every size, it no longer reads as a letter.
3. Direction B's first render had an arc and needle too thin to survive at 16 px. I thickened both. This was a legibility change, not a similarity change.

## Things that are close to generic symbols, not to these four products

These are not conflicts with the four editors, but the owner should know them before picking.

- B: a dial with a needle is a common picture for speed tests, system monitors and dashboards. Of the three it is the least ownable glyph.
- C: a half-filled disc is the usual symbol for "appearance" or "contrast" settings. The slip along the seam separates it at 32 px and up; at 16 px the slip is about one pixel and the glyph reads as a two-tone disc.
- A: two offset blocks resemble list and alignment glyphs in toolbars. The amber body carries most of the recognition.

I did not search trademark registers or app stores for other products using similar marks. That search is still to do for whichever direction is picked.
