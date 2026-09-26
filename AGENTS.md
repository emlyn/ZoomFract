# ZoomFract agent guide

## Project

ZoomFract is a dependency-light browser application for defining recursive
graphics in YAML and rendering them on an HTML canvas. It uses Vite,
TypeScript, plain DOM APIs, CSS, and the `yaml` package. There is no framework,
backend, test runner, linter, or formatter configured yet.

Keep the implementation simple and functional. Reuse small pure helpers for
parsing, geometry, transforms, and render settings instead of duplicating
logic or introducing classes without a clear need.

## Commands

- Install dependencies: `npm install`
- Start development: `npm run dev -- --host 127.0.0.1 --port 5177`
- Build and type-check: `npm run build`
- Preview a production build: `npm run preview`

Prefer leaving one Vite development server running. Vite watches source files
and reloads the existing page automatically. Reuse an existing browser page
instead of opening new windows or tabs. Only add a cache-busting query string
when a normal reload does not pick up an update.

Do not commit generated or local artifacts:

- `node_modules/`
- `dist/`
- `.playwright-mcp/`
- `zoomfract-*.png`

## Repository layout

- `src/main.ts`: UI creation, definition loading, render-worker orchestration,
  progress, and edit-mode outlines on the display canvas.
- `src/scene.ts`: scene types, YAML parsing, and geometry resolution.
- `src/expression.ts`: arithmetic expression parser and evaluator.
- `src/guide.html`: user guide for the definition language, shown from the
  panel. Keep it in simple English and update it whenever the scene language
  changes.
- `src/render/common.ts`: quality modes, render settings, renderer names,
  worker message types, and scene-to-pixel helpers.
- `src/render/worker.ts`: render worker entry; picks a renderer, falls back
  from WebGL2 to Canvas 2D in Auto mode, and posts frames as `ImageBitmap`s.
- `src/render/webgl.ts`: WebGL2 feedback renderer.
- `src/render/unroll.ts`: exact clipped geometry for unrolled WebGL2 zooms.
- `src/render/canvas2d.ts`: reference Canvas 2D renderer.
- `src/examples.ts`: built-in example registry and metadata.
- `src/examples/*.yaml`: loadable example scene definitions.
- `src/style.css`: full-window layout, overlay panel, controls, animations,
  and canvas presentation.
- `index.html`: application shell.
- `vite.config.ts`: static-host-friendly Vite configuration.

This is still a compact prototype. Make surgical changes in the existing
files unless extracting a module clearly reduces complexity.

## Scene language invariants

- The top-level model contains `variables`, `frame`, `view`, `seed`,
  `shading`, and `scene`.
- `frame` controls presentation in CSS pixels: border `width`, corner `radius`,
  border `color`, outer `wall`, inner `background`, canvas `padding`, and
  window-edge `margin`.
- `view.aspect` is width divided by height.
- Resolution may specify `width`, `height`, or both. Infer the missing
  dimension from `aspect`; infer `aspect` when both dimensions are present.
- If resolution is omitted, default to height `1200` and infer width.
- `view.coordinates.x` runs left to right.
- `view.coordinates.y` runs bottom to top, following mathematical convention.
- Axis ranges accept `[from, to]` and object forms such as
  `{ from: -1, to: 1 }`.
- The frame wall belongs to `.canvas-host`, and the frame background belongs
  to `.canvas-frame`, not the canvas bitmap. Canvas pixels must remain
  transparent where no element is drawn.
- Elements may have an optional `name`. Names must be unique, non-blank,
  contain no dots or spaces, and cannot be the reserved name `view`.
- `scene` is an ordered list of typed items. Every item has a `type`, currently
  `rect` or `zoom`, and later items draw on top of earlier items.
- Anywhere a point is accepted, it may be `[x, y]`, `{ x, y }`, or a
  `name.part` reference. Parts are `topLeft`, `topRight`, `bottomLeft`,
  `bottomRight`, `centre`, `top`, `bottom`, `left`, and `right`; `view.<part>`
  refers to the view rectangle. References resolve on demand, so they may
  point forward in the list; self-references and loops are errors.
- Do not add or preserve legacy configuration aliases unless explicitly
  requested. This is a lightweight prototype, so prefer one clear current
  syntax over migration machinery.
- Built-in examples use stable IDs and ordinary YAML files. Keep the registry
  metadata in `src/examples.ts`.
- `?example=<id>` loads a built-in definition. `?source=<http-url>` loads a
  remote YAML definition; never add credentials or a server-side proxy.
- Invalid, ambiguous, conflicting, or underdetermined definitions must produce
  a visible error. Do not silently invent missing geometry.
- Any numeric value may be a number or an expression string such as
  `1/sqrt(2)`, using the infix syntax of emlyn/PowerPointFractals:
  `+ - * / ^`, parentheses, `sqrt`, `root(n, x)`, `log`/`ln` (natural),
  `exp`, `abs`, radian trigonometry including `atan2`, and constants `pi`,
  `e`, `phi`. There is no implicit multiplication. Expressions parse to a
  syntax tree (`src/expression.ts`) so they can later be displayed as maths
  from the same tree; invalid or non-finite expressions are errors.
  Expressions containing commas need quotes inside YAML flow lists.
- Optional top-level `variables` is a list of `{ name, value }` items. Names
  are unique identifiers that must not shadow built-in constants or
  functions; values are numbers or expressions and may reference other
  variables in any order. Expressions anywhere in the scene may use them.
  Unknown names, reference loops, and errors in unused variables are all
  reported.
- Expressions may also use dotted view values: `view.left`, `view.right`
  (x), `view.bottom`, `view.top` (y), `view.width`, `view.height`,
  `view.centre.x`, `view.centre.y` (coordinate units), `view.aspect`,
  `view.pixels.width`, `view.pixels.height` (resolved resolution), and
  `view.pixel.width`, `view.pixel.height` (size of one pixel in coordinate
  units; they differ when the axes are scaled differently). Variables and
  view values
  resolve lazily through one lookup, so the x range can use `view.aspect`
  but not `view.width`. Dotted names are reserved for scene values; future
  element references should follow the same `name.property` form.

### Rectangles

- `rect` is borderless by default and uses `color` (default black) plus
  optional `opacity`.
- Geometry may be determined from a sufficient combination of `centre`,
  width, height, named corners, and rotation.
- Numeric rotations are degrees, and positive rotations are clockwise.
  Rotation expressions are degrees unless suffixed with `deg` or `rad`, and
  unit-object forms are supported. Internal
  geometry uses anticlockwise radians; only `parseRotation` flips the sign.

### Zooms and seeds

- `zoom` uses the rectangle constraint model.
- A missing zoom dimension is inferred from the view aspect.
- A zoom draws a transformed replica of the transparent scene.
- `scale: s` makes a zoom `s` times the view size and cannot be combined with
  `width` or `height`.
- `align: [from, to]` places a zoom so that `from`, a point in the unzoomed
  scene, lands on `to` in the parent scene. It needs a known size; rotation
  defaults to 0. Pairs may also be written `{ from, to }`.
- `align` with a list of two pairs determines scale, rotation, and position
  together. Any other constraints given alongside it must agree.
- Terminal zoom leaves use top-level `seed`; the seed may be a colour string
  or an object containing colour and opacity. Without a seed colour, terminal
  leaves are transparent.
- Keep quality controls out of the scene definition. Renderer, max
  recursion, levels, and supersampling are application quality settings.

### Density shading

- Optional top-level `shading` has `mode: paint` (default, normal
  compositing) or `mode: density`. Density also accepts `scale` (`log`
  default, `sqrt`, `linear`) and `colors` (2 to 8 stops, few hits to many);
  these are errors in paint mode. `colors` is a list (spread evenly) or a
  mapping from positions to colours, where a number is an absolute hit count
  and `N%` is a fraction of the scaled range up to the normalising count.
  Count positions are converted after normalisation and all stops are
  sorted by position; colours clamp beyond the first and last stops.
- Density counts how many rects and copies cover each working pixel, maps
  the count through the scale, normalised by the 99.9th percentile of
  covered pixels, onto the gradient. Zero-hit pixels stay transparent;
  counts below one fade out.
- In density mode rects use `weight` (positive, default 1) instead of
  `color`/`opacity`; zoom `opacity` and `seed` are errors. `weight` in
  paint mode is an error.
- Density is WebGL2 only and needs `EXT_color_buffer_float`. It draws
  straight into R32F (or R16F without float blending/filtering) textures
  with additive blending, uses plain-average mips, and has no Canvas 2D
  fallback; selecting Canvas 2D is an error. Edit mode keeps outlines but
  does not fade copies.

## Rendering invariants

- The visible canvas backing resolution must exactly match `view.resolution`.
  Scale it with CSS to fit the window without changing intrinsic pixel size.
- The canvas remains centred and independent of the overlay panel width.
- Rendering runs in a Web Worker on `OffscreenCanvas`, so the UI thread only
  displays finished frames. Each render uses a fresh worker; starting a new
  render terminates the old one, which cancels obsolete work immediately.
- Quality is an application setting with three modes. Fast (one exact
  recursion, 2x supersampling) and High quality (up to 14 exact recursions,
  4x) always use WebGL2 with automatic levels. A collapsible Render settings
  section shows renderer (WebGL2 or Canvas 2D), supersampling, max recursion
  and a levels slider whose rightmost position is Auto; they are read-only
  except in Custom. Custom is initialised from the first mode it is opened
  from, then remembered.
  WebGL2 falls back to Canvas 2D only if it is unavailable or fails.
- Levels count generations of zooms, with the seed at the last generation.
  Automatic levels are estimated as where the largest zoom falls below half a
  working pixel, i.e. the fixed point. Canvas 2D treats that as an upper bound
  and stops early once a pass changes under 0.01% of its captured pixels;
  WebGL2 always renders the estimate, because per-level readbacks stall the
  GPU and feedback resampling keeps nudging pixels. Max recursion bounds how
  many generations are exact geometry; the rest come from feedback or earlier
  Canvas 2D passes.
- WebGL2 renders recursion by texture feedback: each level draws the scene
  once, with zooms as quads sampling the previous level's texture. Cost is
  linear in depth. Rect edges use MSAA at low supersampling.
- The final WebGL2 level is unrolled into exact geometry
  (`src/render/unroll.ts`), with every item clipped to its ancestor zoom
  quads, up to max recursion and an internal item budget. With fixed levels,
  whole generations are unrolled so every leaf sits at the same depth and the
  seed lands exactly at the requested level on every branch; the details line
  reports when the budget caps recursion. With Auto levels, zooms are
  expanded largest first until they fall below a small pixel size. Remaining
  zooms become leaves sampling the feedback texture; the shallowest leaf
  determines how many feedback levels are needed.
- Canvas 2D is the reference renderer. Its geometric recursion is also capped
  by leaf size and a leaf count, and it adds progressive passes, each posted
  before preparing the next capture, until the requested levels are reached.
  The first pass absorbs any remainder so the total is exact.
- Progress appears only after a short delay, so fast renders do not flash it.
- The render worker is kept while idle and holds the last render's working
  state. A request that differs only by more fixed levels continues from it:
  WebGL2 adds feedback levels and redraws the kept exact geometry (identical
  to a full render); Canvas 2D captures the kept image and adds passes. A
  level increase that arrives while busy waits and replaces any earlier
  waiting increase; any other change terminates the busy worker. The Custom
  Levels row has a +1 button that uses this path.
- Every render reports the fraction of display pixels that changed, compared
  premultiplied by more than rounding noise, between the final image and one
  step before it: the previous level for WebGL2 (an extra output draw before
  the last feedback level) and the previous pass for Canvas 2D, including
  continuations.
- The progress bar is a thin overlay along the bottom of the window, outside
  the panel, so it stays visible when the panel is hidden and never moves
  controls. Render details live inside the Render settings section and list
  only what the inputs do not show; the resolved renderer, supersampling,
  recursion and levels are hover text on the Quality row and settings header.
- Captures must exclude the host background and preserve transparency.
- Downsampling must weight colours by alpha and prioritise non-transparent
  coverage so fine recursive details do not disappear prematurely. Both
  renderers build their mip chains this way; WebGL2 stores premultiplied
  texels.
- Canvas 2D terminal bitmap leaves use projected-size, transform-aware
  rasterisation and cache equivalent leaf transforms.
- Dynamic recursion stops before leaves become smaller than the selected
  quality threshold.
- Be mindful of multiplicative cost: zoom count, recursion depth, passes,
  supersampling, mip generation, and temporary canvas size all compound.
  WebGL2 working textures are limited by `MAX_TEXTURE_SIZE`.
- Edit mode is an application setting, not scene syntax. It fades top-level
  zoom contents and outlines each zoom, marking its top-left corner and any
  `align` target points. Levels used for recursion must stay unfaded, so only
  the final displayed level is faded, and outlines are drawn on the display
  canvas.

## Panel behaviour

- The panel overlays the canvas from the left; it must never shift the image.
- Hiding it must leave no gutter or visible residue.
- The single corner control is an X while open. It moves left and morphs into
  three lines before fading. Hovering near the top-left reveals it; reopening
  reverses the transition.
- The right panel edge is draggable. The corner control must track resizing
  immediately, without its normal horizontal animation.
- Keep the YAML editor monospace and tall enough to show useful context.
- The Guide link beside the scene definition label opens the definition guide
  in a floating panel beside the sidebar. Escape or its close button hides it.
  It hides with the sidebar and reappears with it if it was open.

## TypeScript and CSS

- TypeScript is strict and rejects unused locals and parameters.
- Avoid `any`, broad casts, silent fallbacks, and swallowed errors.
- Prefer immutable object updates and pure calculations where practical.
- Keep coordinate-space conversions explicit: scene units, declared pixels,
  supersampled working pixels, and CSS display pixels are distinct spaces.
- Use ASCII by default.
- Match the existing neutral grey panel palette and restrained animations.

## Validation

For every code change:

1. Run `npm run build`.
2. Reuse the live Vite page and wait for rendering to finish.
3. Check the browser console for errors.
4. Verify the exact affected behaviour, not just page load.

For rendering changes, also check as applicable:

- Canvas intrinsic dimensions match the resolved view resolution.
- Transparent areas still have zero alpha.
- Progressive Canvas 2D passes visibly differ and the final pass remains
  displayed.
- Progress appears during slow work and disappears after completion.
- Fast and High quality resolve automatic levels at the fixed point.
- WebGL2 and Canvas 2D output agree closely with equal Custom settings;
  compare pixel differences and timings when changing either.
- Rotated and asymmetric zooms render without clipping or allocation errors.
- Rapid setting changes leave the latest requested result on screen.

For panel changes, verify open, close, hover reveal, animation sequencing,
drag-resize, and width preservation after reopening.

There is currently no automated test suite. Browser checks are required for UI
or rendering work; `npm run build` alone is not sufficient.

## Git

- Do not commit unless explicitly requested.
- Do not commit generated files or local browser artifacts.
- Keep commit subjects under 50 characters.
- Use concise, informal commit messages and list significant changes in the
  body when useful.
