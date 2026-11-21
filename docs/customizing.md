---
summary: How to give your own copy of the office a different look and a different cast of characters, by changing settings, art files and the source; what each file is for, what the engine keeps fixed, and how to see the result. Packs are not loaded yet, so customizing today means editing your copy.
read_when: You want to change the office's furniture, walls, window view or colours, replace a species' drawings, add or remove a species, or change how sessions get their characters.
---

# Customizing the office and its characters

This guide is for people who run their own copy of agent-office and want a different office, a different set of characters, or both. Today that means editing your copy: settings, art files and a few source files. The character and room pack formats in [packs.md](packs.md) are the plan for later; **the app does not load packs yet**. The renderer works differently from what that page describes: characters are cut-out figures (body parts with registration points, moved by the engine), not sprite sheets, and the office is one room that grows by wings, not a Tiled map.

Everything named here exists in the source as of this writing. Where something is not settled or not checked, it says so.

## 1. Before you start

**Licence.** The software and the bundled office and character art in `packages/ui/art-preview` are released under the [MIT License](../LICENSE).

**Your art is yours.** Pictures and sounds you add are your own work under your own licence, and you need the right to use whatever you put in. If you later want to submit art to the project, [CONTRIBUTING.md](../CONTRIBUTING.md) lists the accepted licences (`CC0-1.0`, `CC-BY-4.0` or `MIT`), and art that imitates existing game characters or brands is not accepted.

**What the public repository contains.** The public repository ships with the bundled office and eight-species character art in `packages/ui/art-preview` (internal provenance files and work notes are omitted). When you run `npm run build:ui`, it copies `packages/ui/art-preview` into `packages/ui/dist/art`. If `packages/ui/art-preview` is removed or a required file is missing, the office draws everything as plain shapes (round bodies in each session's colour, ears or a crest by species) and the top bar says the pictures did not load. To customize the cast or generate your own character set, edit `packages/ui/art-preview` and follow sections 5–7 below.

## 2. Changing things without touching code

Most of what people want first is a setting. The daemon reads `~/.agent-office/config.json` when it starts (restart it after editing); the full list with defaults is [../schemas/config.schema.json](../schemas/config.schema.json). If the file is not valid JSON or does not match the schema, the daemon uses **all** defaults and reports the problem, so check its log after a change.

| Setting | What it changes |
| --- | --- |
| `scene.cast` | How sessions get a species: `per-session` (default; from the session id, so a session always looks the same), `per-project` (one species per project folder) or `per-agent` (from the mapping below). |
| `species` | For `per-agent`: agent kind → species id, default `{ "claude-code": "cat", "codex": "otter" }`. Kinds not listed, or mapped to a species your copy cannot draw, get `bird`. |
| `scene.wander_after_s` | Seconds a session waits or rests before its character starts moving about (default 300). |
| `scene.needs_you_marker` | When the marker of a session that needs you grows stronger (`stronger_after_min`, `strongest_after_min`; `null` for never). |
| `scene.needs_you_glow` | The warm light behind a colleague waiting for you (default on). |
| `scene.board` | The board on the wall and the rewards: `show`, `preset`, `rewards`, `monthly_target`. |
| `labels.show` | Whose name tag shows without pointing: `needs-you`, `everyone`, `on-hover`. |
| `notifications.sound` | `chime`, `animal` (the cry of the session's species) or `off`. |
| `ui.language` | `auto`, `ko` or `en`. |

On the screen, without config:

- A session's card has a species choice. It is stored with the session's note and wins over `scene.cast` and `species`.
- The office's header has a button that switches the window's view between a forest and the sea; each browser remembers its own choice.

## 3. The edit, build and look loop

The browser page is plain JavaScript built from TypeScript in `packages/ui/src`, plus the static files in `packages/ui/static` (the page, the stylesheet, icons and sounds). The daemon serves the built folder `packages/ui/dist`; the page loads its pictures from `dist/art/` (the `art/` address, `ART_BASE` in `packages/ui/src/art.ts`).

1. Install once: `npm install` (Node 22.18 or later).
2. Build after each change: `npm run build:ui`. It compiles the page into `packages/ui/dist`, copies the static files next to it, and copies your art folder `packages/ui/art-preview` (section 5) to `dist/art` when that folder exists; without it you see the plain shapes.
3. Run it, either in a browser — `npm run daemon` in one terminal, then `npm run ui`, which prints an address that opens the page once — or as the desktop app: `npm run app`, which builds the page first and starts its own daemon.
4. After the next build, reload the page. The daemon reads the files from `dist` on each request, so it does not need a restart. In the desktop app, quit it and start it again.

Checked for this guide on a fresh copy of the public repository (macOS, Node 22): `npm install`, `npm run build:ui` with and without an art folder, `npm run daemon` and `npm run ui` — plain shapes with the note in the top bar without art, the pictures with it. Not checked there: `npm run app`, which needs the Electron download that `npm install` runs.

**Checking your copy.** These four commands are the public repository's only scripts; it has no test suite or check scripts. What you can run besides: `npx tsc -p packages/ui/tsconfig.json` (type-checks the page; it catches a species missing from one of the tables in section 6) and the same for `packages/app` if you change the desktop app. The maintainers' own tests also measure seated poses, compare a recorded day of the scene's motion, and check that furniture stays clear of desks at every room size; those tests are not in the public repository, so look at the result yourself (section 7).

The daemon serves only files of known types (for art: `.png` or `.svg` pictures and `.json`), each at most 16 MiB, with file names of letters, digits, `.`, `_` and `-`, from inside `dist` (a symbolic link to a file outside it is refused). The page may load nothing from other sites.

## 4. The office: furniture, walls, window, colours

The office's shape is the engine's: **one room** with a core in the middle (two desks, four desk seats, a sofa and a coffee corner) that grows by **wings** of two desks each, added left and right as more sessions come (`roomAt` in `packages/ui/src/space.ts`), and a waiting room below it joined by a door. You can change what it looks like and where things stand; splitting it into rooms, tabs or a scrolling floor is not a supported change.

**Pictures and their measurements** (paths inside your art folder; the folder name `assets-cozy-v4` is the constant `COZY` in `space.ts`):

| File | What it is | Read by |
| --- | --- | --- |
| `assets-cozy-v4/room-v4.png` | The office's walls and floor. | `scene-art.ts` |
| `assets-walls/plaster-two-doors-v3.png` | The waiting room's walls. | `scene-art.ts` |
| `assets-cozy-v4/lounge-v4.png`, `assets-space/atlas.json` | The lounge furniture (sofa, coffee corner, plant, shelf) and where each piece is on the picture (`frames`). | `scene-art.ts` |
| `assets-cozy-v4/waiting-v4.png`, `assets-waiting/reception.json` | The benches and the coat rack, and their frames. | `scene-art.ts` |
| `assets-cozy-v4/office.json` and the picture it names | The desk and the chair: each piece's rectangle on the picture, the desk's drawn height, its `groundBottom` anchor and its top as a polygon (`sourceSurfacePolygon`), the chair's drawn size and its `seat` and `groundBottom` anchors. | `workstation.ts` (`OfficeArt`) |
| `assets-cozy-v4/tools-v4.png` | The paper tools (sketchbook, notebook, drawings), cropped by `TOOL_CROPS` in `workstation.ts`. | `workstation.ts` |
| `assets-workstation/parts.json`, `back.json` and their pictures | The laptop seen from behind: its key points, its screen outline and its back lid. | `workstation.ts` |
| `assets-cozy-v4/forest.png`, `ocean.png` | The two views outside the window, in clear weather. | `windows.ts` |
| `assets-cozy-v4/forest-cloudy.png`, `-rain.png`, `-dark.png` and the same for `ocean` | The same views under cloud, in rain and at night, at the same size, painted so the hills and the horizon lie where they do in the clear view. The office chooses the weather; the moon of the night pictures is kept whole in one pane (`MOON` in `windows.ts`, `paneViewRect` in `scene-layout.ts`). | `windows.ts` |
| `assets-cozy-v4/parts.json` and the pictures it names | The board's and the rewards cabinet's frames on the wall. | `wall.ts` |

The lounge picture is drawn with the frames measured on the earlier sheet of the same size, so a replacement must keep each piece where the frames say. Coordinates in these files are source pixels of their picture. If any file is missing or fails to load, the whole office falls back to plain shapes; there is no per-file fallback.

**The window** is drawn by code, not from a picture: one arched opening across the back wall, its frame and bars (`windows.ts`, with the arch and the bars' spacing in `scene-layout.ts`). Only the view behind it is a picture. Its colours are in `windows.ts`.

**Where things stand** (`packages/ui/src/space.ts`, in room units at a character height of 220):

- `SEAT_FROM_CENTRE` and `SEAT_BEHIND`: how far each desk seat is from its desk's centre and behind it.
- `CORE_DESKS` and `CORE_FURNISHINGS`: the core's desks and its plants, shelf, coffee corner and sofa.
- `wing(k)`: the desks, coffee corner and extra plant or shelf of each wing; `FIRST_WING` and `WING_STEP` set how wide wings are.

A piece of furniture beside a row of desks must stay clear of the desks' pictures once the wings beside the core open; the maintainers' tests check this at every room size, so check it on screen at several sizes.

**At the desk** (`packages/ui/src/workstation.ts`): `ART_HEIGHT` (220) is the character height the numbers below are measured at; `HAND` (where the paws go on the keys), `NOTE` (the small note beside a laptop), `CHAIR` (the chair under the seat), `PAPER` (a paper tool's place and size), and the laptop stand in `placeLaptopStand` (6 high in front, 24 behind for the cat and 36 for the fox). `TOOL_OF` says which species uses a laptop and which a paper tool.

**Colours of the page** are CSS custom properties at the top of `packages/ui/static/style.css` (`--ink`, `--muted`, `--line`, `--paper`, `--sage`, `--sage-soft`, `--wood`) and the status tones (`[data-tone="calm"]`, `"long"`, `"needs"`, `"unknown"`). Markers, glows and the sweat bubble of a long turn are also styled there or drawn by code; they are engine-wide, so keep their meaning when you restyle them: needs-you stays the strongest, a long turn is never a warning colour.

## 5. Your art folder

The art folder is `packages/ui/art-preview` (`npm run build:ui` copies it to `dist/art`). It already contains the bundled office and the eight bundled species (`otter`, `cat`, `bird` under `assets-rig/` and `assets-identity/`, and `dog`, `rabbit`, `fox`, `panda`, `hedgehog` under `assets-cast/`). You can inspect any existing file there as a working reference, replace individual sheets, or add a new species folder under `assets-cast/<species>/`. The TypeScript types next to each `loadJson(...)` call (`OfficeArt`, `Atlas`, `CastPack`, `CastProfile`, `PropAtlas`, `FaceAtlas` and the others) say which fields of each JSON file are read; other fields are ignored.

There is no tool that measures anchors for you: pivots, joints, seat points and grips are numbers you take from your own pictures.

## 6. The cast of characters

**The species list** is `Species` and `SPECIES` in `packages/ui/src/model.ts`: `otter`, `cat`, `bird`, `dog`, `rabbit`, `fox`, `panda`, `hedgehog`. `speciesOf` in the same file gives each session its species (the card's choice, else `scene.cast`). With `per-session` and `per-project` the species comes from the position in `SPECIES`, so **adding, removing or reordering species changes which animal existing sessions get**.

**How a character is drawn.** Each species is six parts — `head`, `torso`, `nearArm`, `farArm`, `nearLeg`, `farLeg` — cut from one picture and joined at registered points; the engine moves them (walking, turning, sitting, routines). For each part the code reads:

- `rect`: where the part is on the picture; `solidBounds`: its opaque area.
- `pivot`: the point it turns about, as a fraction of `rect`.
- `suggestedWidth`: its drawn width at a character height of 220.
- optional `mirrorX`, `perspectiveScale`, and on the torso `seatSupport`: the point of the torso that sits on a chair's seat, as a fraction of `rect`.

and per species `joints`: where the head, arms and legs attach to the torso.

The species come from two places in the art folder, both read in `createRigs` (`packages/ui/src/rig.ts`):

- `otter`, `cat` and `bird` (`FIRST` in `rig.ts`): `assets-rig/atlas.json` (parts and joints), `assets-rig/expression-atlas.json` (a blink head and a front head), `assets-rig/front-body-atlas.json` (the body seen from the front, mid-turn) and clothing masks listed in `assets-identity/manifest.json`.
- every other species (`CAST` in `rig.ts`): a folder `assets-cast/<species>/` with `parts.json` (its picture, its clothing mask and the frames of the six parts plus `blink`, `front` and `frontBody`), and the species' entry in `assets-cast/rig-profile.json` (pivots, widths, `seatSupport`, joints, `frontHeight`, `frontHeadWidth`, `coloredParts`).

**Shared by every species:**

- Faces: `assets-expression/expression-v2.json` holds, per species, the `blank` face shown when a session has sent no signal. It is the only alternative face; a long turn shows a sweat bubble above the head instead.
- Props: `assets-interaction/parts.json` holds the cup, the newspaper and the notepad with their grip points (`handle`, `handleLower`, `lip`, `leftGrip`, `rightGrip`, `writingSurface` and others).
- Clothing colour: each session's colour (`packages/ui/src/identity.ts`) tints the clothing selected by the species' mask and by a colour range written for each species in `clothingWeight` (`packages/ui/src/material.ts`); `WARDROBE` and the details in `packages/ui/src/wardrobe.ts` add pockets and patterns.

**Tables per species in the source.** The compiler lists the ones you miss when you add a species:

| Where | What |
| --- | --- |
| `anatomy.ts`: `FAR_LIMBS` | The elbow's place along each arm, wrist curves and the mouth point (for the cup). |
| `anatomy.ts`: `CUSHION_FEET` | Where the feet go when the character sits, on a sofa, a stool or a desk chair. |
| `anatomy.ts`: `NECKS` | Optional: a shorter neck for species that need one. |
| `temperament.ts`: `TEMPERAMENTS` | How it walks and strolls, its stops, habits, its slump in a long turn and its blank pose. |
| `workstation.ts`: `TOOL_OF` | Laptop or paper tool. |
| `routines.ts` | Some routines have per-species shapes (the stretch, the drinking nod). |
| `i18n/ko.ts`, `i18n/en.ts`: `format.species` | The species' name on screen. |
| `packages/ui/static/sounds/<species>.wav` | Its cry for `notifications.sound: animal`; without it the chime plays (see that folder's README for the format). |

**Not caught by the compiler.** `rig.ts`, `routines.ts` and `material.ts` also contain checks on particular species names with values fitted to the maintainers' drawings (`clothingWeight` throws for a species it does not know). Search those files for your species' name, or the one you replace, and read each case.

### Recipe: new drawings for an existing species

1. Draw the six parts (and, for `otter`/`cat`/`bird`, the blink and front heads and the front body; for the others the `blink`, `front` and `frontBody` frames) and a clothing mask the same size as the picture.
2. Write its frames, pivots, widths, joints and `seatSupport` into the files above.
3. Check the per-species values in `FAR_LIMBS`, `CUSHION_FEET`, `NECKS`, `clothingWeight` and the species checks in `rig.ts` against your drawing; they were fitted to the old one.
4. Build and look (section 7).

### Recipe: a new species

1. Add its id to `Species` and `SPECIES` in `model.ts`. It is not one of `FIRST`, so its art goes in `assets-cast/<species>/` and `rig-profile.json`.
2. Run `npx tsc -p packages/ui/tsconfig.json` and fill every table it reports (the ones above, the names in both languages).
3. Add its case to `clothingWeight` and, if you want garment details, `WARDROBE`.
4. Add its `blank` face to `expression-v2.json`, and its cry if you want one.
5. Remember that existing sessions may change animal (see "The species list").

Removing a species is the same in reverse. `bird` is also the fallback for unmapped agent kinds in `speciesOf`; keep it, or change that fallback.

## 7. Prompts for generating your own character set

Every cast species under `packages/ui/art-preview/assets-cast/<species>/` uses **two pixel-aligned 1536 × 1536 transparent PNG sheets** — a **3×3 cut-out rig atlas** and a **garment mask** — plus `parts.json` and an entry in `assets-cast/rig-profile.json`. Because the engine drives all walking, turning, sitting and desk/lounge routines procedurally from these nine cut-out pieces, you do not need to draw multi-frame animation sheets.

You can use the prompts below with any image-generation tool that supports transparent PNG output and image-to-image editing. Replace `<SPECIES DESCRIPTION>` and `<OUTFIT DESCRIPTION>` with the character you want.

### Step 1 — Generate the 3×3 cut-out rig atlas (`atlas.png`)

```text
Produce a true-alpha square 3-by-3 cut-out character rig atlas (1536 x 1536 transparent PNG) for a round, chibi office colleague: <SPECIES DESCRIPTION, e.g. "a cream-and-caramel lop-eared dog with warm brown ears"> wearing <OUTFIT DESCRIPTION, e.g. "a sage-green work jacket with flap pockets over a cream shirt">.

Style: warm matte painted 2.5D storybook illustration, soft natural shading, clean silhouettes, no pixel-art jagging, no harsh black outlines.

Layout — 3 rows by 3 columns on an invisible grid. Each piece must fit inside a 300 x 300 pixel box with at least 100 pixels of fully transparent margin all around it:
- Row 1, Column 1 (head): normal head with open eyes in three-quarter right view (no neck/shoulders).
- Row 1, Column 2 (torso): headless, limbless torso in three-quarter right view wearing the outfit, including the tail attached to the back.
- Row 1, Column 3 (nearArm): near (left/front) arm sleeve and paw in three-quarter right view.
- Row 2, Column 1 (farArm): far (right/back) arm sleeve and paw in three-quarter right view.
- Row 2, Column 2 (nearLeg): near leg and foot/paw in three-quarter right view.
- Row 2, Column 3 (farLeg): far leg and foot/paw in three-quarter right view.
- Row 3, Column 1 (blink): blink head (closed eyes) in the exact same three-quarter right view, size and silhouette as Row 1 Column 1.
- Row 3, Column 2 (front): front-facing head with open eyes.
- Row 3, Column 3 (frontBody): front-facing headless body with both arms and both legs attached in a neutral standing pose, wearing the same outfit.

Joint and alpha rules:
- Use rounded overlaps at the neck, shoulder and hip joints so pieces rotate cleanly without gaps.
- Every pixel outside the nine silhouettes must have alpha 0 (no background, no drop shadows, no glow, no grid lines, no text labels, no checkerboard).
- Inside each silhouette use opaque alpha 255 except for smooth antialiased edge pixels.
```

### Step 2 — Optional spacing and transparency cleanup pass

If the generated sheet has tight margins, stray shadow pixels, or parts touching cell borders, run an image-edit pass on the sheet with this prompt:

```text
Edit target: the attached 3x3 character rig sheet. Keep the exact same nine parts, character identity, clothing, views, cell order, paint style and anatomy.
Make ONLY a spacing and transparency correction. Output a square 1536 x 1536 transparent PNG with the same invisible 3x3 layout:
- Scale each part uniformly inside its own cell so every part (including ears and tail) fits within a maximum 300 x 300 pixel box with at least 100 pixels of fully transparent margin on all sides.
- Keep the normal head (row 1 col 1) and blink head (row 3 col 1) at the exact same size.
- Clear all ghost pixels, speckles, glow and shadows: every pixel outside the nine silhouettes must have alpha 0, and interiors must have alpha 255. Do not draw a background or grid.
```

### Step 3 — Generate the pixel-aligned garment mask (`garment-mask.png`)

The engine tints each session's clothing in its own colour by multiplying where the garment mask is white AND the source pixel matches the garment's base colour (`clothingWeight` in `packages/ui/src/material.ts`). Pass your finished `atlas.png` to an image-edit tool with this prompt:

```text
Edit target: the exact attached 3x3 character rig atlas. Create a pixel-aligned GARMENT-ONLY MASK for this exact raster, not a new illustration.
Keep the exact same canvas dimensions (1536 x 1536), exact source coordinates, garment silhouettes and seam locations. Do NOT shift, scale, repaint, deform or recenter any part.

Rules:
- For EVERY outer garment fabric pixel (<OUTFIT DESCRIPTION>) on the side torso (row 1 middle), near arm (row 1 right), far arm (row 2 left) and front headless body (row 3 right): replace its colour with pure white RGB(255, 255, 255) and alpha 255.
- For EVERY fur, skin, head, ear, face, tail, paw, leg, foot, inner cream undershirt/cuff and background pixel: set complete alpha 0.
- The cells holding the 3 heads (row 1 left, row 3 left, row 3 middle) and the 2 legs (row 2 middle, row 2 right) must be completely transparent.
- Output a true-alpha PNG with only the four white garment regions visible, overlaying the input atlas pixel for pixel.
```

### Step 4 — Wire `parts.json` and `rig-profile.json`

1. Put your two PNGs in `packages/ui/art-preview/assets-cast/<species>/` (see `packages/ui/art-preview/assets-cast/dog/parts.json` for a complete working example) and list the bounding boxes of the nine cells in `parts.json`:

   ```json
   {
     "version": 1,
     "species": "dog",
     "image": "atlas-v2.png",
     "mask": "garment-mask-v1.png",
     "width": 1536,
     "height": 1536,
     "frames": {
       "head":      { "rect": { "x": 115, "y": 100, "width": 292, "height": 300 }, "solidBounds": { "x": 123, "y": 108, "width": 276, "height": 284 } },
       "torso":     { "rect": { "x": 625, "y": 135, "width": 275, "height": 278 }, "solidBounds": { "x": 633, "y": 143, "width": 259, "height": 262 } },
       "nearArm":   { "rect": { "x": 1165, "y": 155, "width": 210, "height": 235 }, "solidBounds": { "x": 1173, "y": 163, "width": 194, "height": 219 } },
       "farArm":    { "rect": { "x": 155, "y": 635, "width": 210, "height": 235 }, "solidBounds": { "x": 163, "y": 643, "width": 194, "height": 219 } },
       "nearLeg":   { "rect": { "x": 665, "y": 650, "width": 205, "height": 230 }, "solidBounds": { "x": 673, "y": 658, "width": 189, "height": 214 } },
       "farLeg":    { "rect": { "x": 1170, "y": 650, "width": 205, "height": 230 }, "solidBounds": { "x": 1178, "y": 658, "width": 189, "height": 214 } },
       "blink":     { "rect": { "x": 115, "y": 1120, "width": 292, "height": 300 }, "solidBounds": { "x": 123, "y": 1128, "width": 276, "height": 284 } },
       "front":     { "rect": { "x": 620, "y": 1120, "width": 295, "height": 300 }, "solidBounds": { "x": 628, "y": 1128, "width": 279, "height": 284 } },
       "frontBody": { "rect": { "x": 1135, "y": 1110, "width": 275, "height": 320 }, "solidBounds": { "x": 1143, "y": 1118, "width": 259, "height": 304 } }
     }
   }
   ```

2. Add or update the species' pivots, widths, `seatSupport`, `joints` and `coloredParts` in `packages/ui/art-preview/assets-cast/rig-profile.json` (copy one of the five existing entries in that file as a starting point, then tune `joints` and `seatSupport` while looking at the character in the browser).
3. Follow the "Recipe: new drawings for an existing species" or "Recipe: a new species" in section 6 above, then run `npm run build:ui` and reload.

## 8. Looking at the result

Things worth checking by eye, in the browser and the desktop app:

- Every species sitting at a desk on its chair (not floating above or sunk into it), facing both ways; its shoulders joined to its body; its far hand showing a little beside the body when it stands.
- A colleague getting up and sitting down, walking, turning toward you and back, resting on the sofa and a stool, drinking tea and reading the paper.
- The office at several sizes: send it many sessions, or watch it grow as sessions start; furniture beside the desks stays clear of them.
- A phone-width window, and the markers (needs you, a long turn's sweat bubble, no signal) readable over your characters.

When the pictures did not load, the top bar says so with the reason the browser gave; for a JSON file that is its name.

