# ZoomFract agent guide

## Project

ZoomFract is a dependency-light browser application for defining recursive
graphics in YAML and rendering them on an HTML canvas. It uses Vite,
TypeScript, plain DOM APIs, CSS, the `yaml` package, and CodeMirror 6 for the
definition editor. There is no framework,
backend, test runner, linter, or formatter configured yet.

Keep the implementation simple and functional. Reuse small pure helpers for
parsing, geometry, transforms, and render settings instead of duplicating
logic or introducing classes without a clear need.

## Commands

- Install dependencies: `npm install`
- Start development: `npm run dev -- --host 127.0.0.1 --port 5177`
- Build and type-check: `npm run build`
- Preview a production build: `npm run preview`
- Deployment: `.github/workflows/pages.yml` builds and deploys to GitHub
  Pages (https://emlyn.github.io/ZoomFract/) on every push to `main`. Keep
  Vite's `base: './'` so the app works under the `/ZoomFract/` subpath.

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
  progress, and edit-mode outlines on a separate transparent overlay canvas.
- `src/scene.ts`: scene types, YAML parsing, error locations, and geometry
  resolution.
- `src/editor.ts`: CodeMirror definition editor with inline diagnostics.
- `src/definition-form.ts`: primary graphical definition editor, using YAML
  document nodes so expressions, references and comments survive form edits.
- `src/share.ts`: shared-link encoding, loaded on demand with its dictionary.
- `src/share-dialog.ts`: the Share dialog for images, links, QR codes,
  definition files and PowerPoint files.
- `src/service-worker.js`: production-only offline cache behavior. The Vite
  plugin in `vite.config.ts` prepends the complete built-file list and a
  content-derived cache name to `dist/sw.js`.
- `src/pptx.ts`: PowerPoint export, a hand-written OOXML package in an
  uncompressed zip with no dependencies.
- `src/expression.ts`: arithmetic expression parser and evaluator.
- `src/dimension.ts`: fractal dimension of the zooms for the wall label.
- `src/guide.html`: user guide for the definition language, shown from the
  panel. Keep it in simple English and update it whenever the scene language
  changes.
- `src/render/common.ts`: quality modes, render settings, worker message
  types, and scene-to-pixel helpers.
- `src/render/worker.ts`: render worker entry; runs the WebGL2 renderer and
  posts frames as `ImageBitmap`s.
- `src/render/webgl.ts`: WebGL2 feedback renderer.
- `src/render/unroll.ts`: exact clipped geometry for unrolled WebGL2 zooms.
- `src/examples.ts`: built-in example registry (IDs and file imports).
- `public/`: favicon, home-screen icons and web app manifest. The icons
  are the Sierpinski carpet rendered by the app at powers of 3 (81, 243
  and 729 px) so its holes stay pixel-aligned, on white.
- `src/examples/*.yaml`: loadable example scene definitions.
- `src/style.css`: full-window layout, overlay panel, controls, animations,
  and canvas presentation.
- `index.html`: application shell.
- `vite.config.ts`: static-host-friendly Vite configuration.

This is still a compact prototype. Make surgical changes in the existing
files unless extracting a module clearly reduces complexity.

## Scene language invariants

- The top-level model contains `info`, `variables`, `frame`, `view`, `seed`,
  `shading`, and `scene`.
- Optional `info` holds text-only `title`, `author`, `date`, `description`,
  and `links` (http(s) URL strings or `{ title, url }`). It never affects
  rendering. It is shown on a gallery-style wall label beside the frame,
  together with generated medium paragraphs: "Digital image, W × H pixels",
  then contents and levels ("1 rectangle, 3 zooms; 23 levels"), then the
  fractal dimension. The label is hidden when `info` is empty or "Show label" is off.
- The medium lines include the fractal dimension of the zooms' attractor
  (`src/dimension.ts`, main thread, memoised per scene; previews keep the
  last value). Exactly coinciding maps merge first. Copies covering the
  attractor hull give 2. Similarities solve Moran's equation, capped at 2,
  shown as a formula when one scale (log n / log(1/r)) or scales r and r^2
  fit, else to 3 decimals. That is exact for separated copies and, by
  Hochman, for overlaps unless deeper compositions coincide exactly; then
  the growth of distinct compositions is the estimate. Non-similar maps use
  box counting. Estimates show 2 decimals. For similarities, the similarity
  (Moran) dimension follows in brackets when it exceeds the picture's
  dimension, e.g. a projected 3D Menger sponge.
- `frame` controls presentation in CSS pixels: border `width`, corner `radius`,
  border `colour`, outer `wall`, inner `background`, canvas `padding`, and
  window-edge `margin`.
- `view.aspect` is width divided by height of the view, excluding overflow.
  `aspect: auto` derives it from the coordinates, making scene units square.
- Pixel resolution is an application quality setting, not scene syntax.
- Optional `view.overflow` (scene units, default 0, non-negative) adds a
  border on every side that catches anything drawn past the view edge, such
  as glows. After all geometry and references resolve, `buildScene` sets the
  output coordinates to the shown area and re-describes every zoom with
  `reframeZoom` so it copies that area with an unchanged transform; renderers
  need no special handling, except that seed leaves fill only the declared
  view within each copy (`seed` on unrolled leaves, `seedBounds` in the glow
  dilate). `view.declared` keeps the written coordinates.
  Edit mode outlines the declared view and zooms.
- `overflow: auto` fits the shown area to the content: `contentBounds`
  iterates hull(shapes + each zoom's copy of the hull) to its fixed point, and
  `fittedView` scales the declared view evenly about it (each axis
  separately with `aspect: auto`, so the picture takes the content's shape).
  Because pixel sizes
  depend on the fit, `sceneFromValue` rebuilds until it settles. Zooms that
  do not shrink are an error. The source content hull is clipped to the shown
  view before each zoom copy contributes to the fit. `view.overflow` is not a
  variable in auto mode.
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
  `rect`, `circle`, `polygon` or `zoom`, and later items draw on top of earlier items. Planned
  syntax (more shapes, images, groups, gradients, zoom colour changes,
  repeats) is described in the guide's "Coming soon" section and baked into
  the v1 share dictionary; implement it with those exact names.
- Anywhere a point is accepted, it may be `[x, y]`, `{ x, y }`, or a
  `name.part` reference. Parts are `topLeft`, `topRight`, `bottomLeft`,
  `bottomRight`, `centre`, `top`, `bottom`, `left`, and `right`; `view.<part>`
  refers to the view rectangle. References resolve on demand, so they may
  point forward in the list; self-references and loops are errors.
- Do not add or preserve legacy configuration aliases unless explicitly
  requested. This is a lightweight prototype, so prefer one clear current
  syntax over migration machinery.
- British and American spellings are both accepted for `colour`/`color`,
  `colours`/`colors`, and `centre`/`center` (`SPELLINGS` in `scene.ts`,
  applied before parsing). The parser reads the British names, which are
  also the ones suggested for misspellings. Using both in one place is an
  error.
- Every setting name is checked against the `DEFINITION` shape in `scene.ts`;
  unknown keys are errors with a closest-name suggestion. Add new settings
  there as well as in the parser.
- Line endings are LF everywhere (enforced by `.gitattributes`).
- Built-in examples use stable IDs and ordinary YAML files. Their dropdown
  label comes from each file's `info` (a title is required);
  `src/examples.ts` only lists IDs and imports.
- `?example=<id>` loads a built-in definition. `?source=<http-url>` loads a
  remote YAML definition; never add credentials or a server-side proxy.
- If a remote or encoded shared definition is readable but invalid, put its
  text in the editor, clear the example selection, open the panel and show
  the parse error while keeping the last valid picture. This lets the user
  repair definitions made with old or mistaken syntax. Shared app settings
  take effect immediately; shared input values wait separately from the
  visible scene and are applied when the repaired definition succeeds.
- `#<code>` (made by the Share dialog) or `?q=<code>` loads a shared link: a
  version character, then base64url of deflate (fflate) of the definition
  text. When there are extras, the text is followed by `\0` and a JSON object
  documented in `src/share.ts` (input values and app settings). It is
  compressed against a preset dictionary, `src/share/dictionary-<version>.txt`,
  made of the planned syntax snippets from the guide's "Coming soon" section,
  the examples, guide snippets and sample extras JSON (the most
  likely matches go last, where deflate references them most cheaply).
  Released dictionaries are frozen: never edit one, or old links break. To
  improve compression, add a new dictionary under a new version character and
  keep the old ones decodable. Only one of `example`, `source`, `q` and a
  fragment may be given.
- Invalid, ambiguous, conflicting, or underdetermined definitions must produce
  a visible error. Do not silently invent missing geometry.
- Any numeric value may be a number or an expression string such as
  `1/sqrt(2)`, using the infix syntax of emlyn/PowerPointFractals:
  `+ - * / ^`, parentheses, `sqrt`, `root(n, x)`, `log`/`ln` (natural),
  `exp`, `abs`, `min`/`max` (one or more arguments), radian trigonometry including `atan2`, and constants `pi`,
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
- A variable may have an `input`: `{ type: slider, min, max, step?, label? }`
  sets a number (the definition's value must lie in range; values set while
  viewing are clamped), and `click` or `drag` (string shorthand allowed) set a
  point whose `value` is `[x, y]` and which expressions use as `name.x` and
  `name.y`. `checkbox` toggles a variable whose `value` is `true` or `false`;
  any variable may be boolean, counting as 1 or 0 in expressions.
  `parseScene(text, inputValues)` replaces input values and returns
  them in `scene.inputs`. Values are kept when the edited definition is
  applied and reset when another definition loads.
- Expressions may also use dotted view values: `view.left`, `view.right`
  (x), `view.bottom`, `view.top` (y), `view.width`, `view.height`,
  `view.centre.x`, `view.centre.y` (coordinate units), `view.aspect`,
  and `view.overflow` (numeric overflow only). Variables and view values
  resolve lazily through one lookup, so the x range can use `view.aspect`
  but not `view.width`. Dotted names are reserved for scene values; future
  element references should follow the same `name.property` form.

### Rectangles

- `rect` is borderless by default and uses `colour` (default black) plus
  optional `opacity`.
- `circle` uses either `centre` and positive `radius`, or exactly three
  non-collinear `points`. `polygon` uses an ordered list of at least three
  simple, non-crossing `points`, or `sides` (3-256), `centre`, and one
  `vertex` to define a regular polygon. Filled shapes share colour, opacity,
  transparency and density `weight` behaviour.
- Named polygon points can be referenced as `name.points.0`; circle points
  used to define a three-point circle can be referenced the same way. Named
  shape parts such as `centre` and corners refer to the shape's bounding box.
- Every colour (items, glows, seed, frame, shading stops) is any colour the
  canvas accepts: names, `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and
  functions such as `rgb()`, `hsl()`, `hwb()`, `lab()` and `oklch()`. The
  parser validates each against a canvas, so unknown colours are errors.
  Colour alpha multiplies with opacity.
  Comma-separated `rgb()` channels also accept numeric expressions (including
  variables, nested function calls and trailing percentages); resolve them in
  `asColour` before canvas validation. All colour settings use this helper.
- Wherever `opacity` is accepted (items, glows, seed), `transparency`
  (1 - opacity) may be used instead, but not both. Either may be a number
  from 0 to 1, an expression, or a percentage such as `40%`; values are
  clamped to 0..1.
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
- Zoom `blend` is `normal` (default), `multiply`, `screen`, `add`, `darken`
  or `lighten` (`BLEND_MODES`), paint mode only. A copy is the scene
  composited on its own, then blended onto what is below, including seed
  leaves. Exact recursion draws copies item by item, which only matches
  that for normal, so when any zoom blends no zooms are unrolled. The
  renderer copies the current tile to a backdrop texture before each blended
  copy and blends premultiplied colours in the scene shader.
- Keep quality controls out of the scene definition. Resolution,
  max recursion, levels, and supersampling are application quality settings.

### Shading

- Optional top-level `shading` has `mode: paint` (default, normal
  compositing) or `mode: density`. Paint mode accepts `detail`, a number
  from -1 to 1 (or percentage or expression; `average` is 0, the default,
  and `preserve` is 1), choosing how mips shrink sub-pixel copies; it is
  an error in density mode. Density also accepts `scale` (`log`
  default, `sqrt`, `linear`) and `colours` (2 to 8 stops, few hits to many);
  these are errors in paint mode. `colours` is a list (spread evenly) or a
  mapping from positions to colours, where a number is an absolute hit count
  and `N%` is a fraction of the scaled range up to the normalising count.
  Count positions are converted after normalisation and all stops are
  sorted by position; colours clamp beyond the first and last stops.
- Density counts how many filled shapes and copies cover each working pixel, maps
  the count through the scale, normalised by the 99.9th percentile of
  covered pixels, onto the gradient. Zero-hit pixels stay transparent;
  counts below one fade out.
- In density mode filled shapes use `weight` (positive, default 1) instead of
  `colour`/`opacity`; zoom `opacity` and `seed` are errors. `weight` in
  paint mode is an error.
- Density needs `EXT_color_buffer_float`. It draws
  straight into R32F (or R16F without float blending/filtering) textures
  with additive blending and uses plain-average mips. Edit mode keeps outlines but
  does not fade copies.

### Glow

- Rects and zooms accept `glow: { colour, opacity, size, softness }`.
  `colour` and `size` (a non-negative scene-unit distance) are required;
  `opacity` defaults to 1; `softness` is 0 to 1 and defaults to 1. Glows
  are errors in density mode. Zoom glows also accept
  `sourceOpacity` (0 to 1, default 0) to blend between ignoring source alpha
  and weighting the glow by it.
- Grow the shape by size * (1 - softness/2), then Gaussian blur with
  sigma = size * softness / 6, so the glow always reaches about `size`.
  Softness 1 matches LibreOffice's glow. The glow draws just before (under)
  its item and is copied into zooms like any other item.
- Rect glows are analytic in the scene shader. Zoom glows sample glow fields
  built once per render from a coverage mask of the fully recursed image
  (shapes only, no glows, maximum-alpha mips so any visible detail glows),
  dilated at the coarsest mip where the blur still spans a texel (bounded
  by the dilation radius) then separably blurred, deduplicated by margin and
  softness (at most 8 fields). A shallower mask shows seeds as blocks that
  the glow would outline as steps. Masks are single-channel R8 (read `.r`;
  WebGL2 has no swizzle), and only the latest is kept, for continuations.

## Rendering invariants

- The visible canvas backing resolution must exactly match the selected
  quality output. Scale it with CSS to fit the window without changing its
  aspect.
- The framed canvas and wall label are centred together as one group,
  independent of the overlay panel width. The label sits beside the frame,
  bottom-aligned, or below it, right-aligned, when that gives a larger picture.
  Input controls are a matching card, stacked above the label beside the
  frame or to its left below it. Pressing the picture moves the nearest point
  input; drag inputs follow the pointer until release.
  At widths up to 700 px, the picture, input card and label stack vertically
  in that order. The artwork host scrolls vertically when they do not fit;
  picture-only mode keeps its screen-fitting, non-scrolling layout.
- While inputs change, previews render at Fast quality with 1x supersampling
  and at most 0.5 megapixels, scaled up for display, without progress. A
  running preview finishes before the newest starts instead of restarting
  the worker. The selected quality renders once values settle (400 ms, or on
  drag release). Image sharing stays disabled while a preview is displayed.
- Rendering runs in a Web Worker on `OffscreenCanvas`, so the UI thread only
  displays finished frames. Starting a new render while one is running
  terminates the busy worker, which cancels obsolete work immediately.
- Quality is an application setting with five modes. Fast renders at half
  the display's physical resolution (one exact recursion, 2x supersampling);
  Display matches physical resolution (up to 8 exact recursions, 2x); High
  is 1500 px high (up to 14, 4x); Print is 3600 px high (up to 16, 2x).
  They use WebGL2 with automatic levels. Display modes are capped at 1500
  and 3000 px on the longest side respectively. A collapsible Render
  settings section also shows width, height, supersampling, max
  recursion and a levels slider whose rightmost position is Auto; they are
  read-only except in Custom. Custom accepts either width or height and
  infers the other from the full output aspect, showing that calculated value
  in grey; editing it swaps the controlling dimension. The quality select
  sits on the right of the Render quality summary, whose disclosure triangle
  opens the full settings. Custom is initialised from the first mode it is
  opened from, then remembered.
  When a WebGL working dimension (`output * supersampling`) exceeds the
  smaller of `MAX_TEXTURE_SIZE` and `MAX_RENDERBUFFER_SIZE`, both output
  dimensions shrink proportionally. A warning beside Render quality reports
  the requested size, actual size and device limit.
  WebGL2 is required; there is no other renderer. If it is unavailable or
  fails, the render error says why.
- Windows resets a GPU that spends about two seconds on one submission, and
  Chrome disables the GPU for every page after a few resets. WebGL scene
  draws are split, per tile, into batches of at most 8 million working pixels, and the
  renderer calls `gl.finish()` after each batch and each feedback level. Once
  a context is lost, the page stops requesting WebGL2 until it is reloaded,
  and says why.
- Levels count generations of zooms, with the seed at the last generation.
  Automatic levels are estimated as where the largest zoom falls below half a
  working pixel, i.e. the fixed point, up to 256 levels. Non-shrinking zooms
  retain the earlier 64-level cap because they cannot reach that threshold.
  When an auto render reaches its limit, the collapsed settings header shows
  a warning icon and a +256 levels button, and a highlighted note is appended
  to the end of the render details line. Each click extends the auto limit,
  continuing the existing worker render until the picture settles or the new
  limit is reached. There is no arbitrary manual-extension ceiling;
  changing the picture or quality clears the extension. The estimate is a
  minimum: translucent items let deeper levels show, so in paint mode auto
  renders then measure convergence. They compare consecutive feedback levels
  by the largest 15x15-block average difference (per-pixel maxima are
  dominated by rounding nudges), at the output's mip level, with one small
  readback. Two measurements give a geometric rate r; rendering stops when
  the predicted remaining change d*r/(1-r) is under 1/255, the change is under
  0.2/255, or r >= 1. Otherwise it jumps ahead by the levels r predicts, at
  most doubling, and measures again, so readbacks stay few. Only reaching the
  limit while still changing counts as hitting it. Density mode keeps the
  estimate. Max recursion bounds how many generations are exact geometry; the
  rest come from feedback.
- WebGL2 renders recursion by texture feedback: each level draws the scene
  once, with zooms as quads sampling the previous level's texture. Cost is
  linear in depth. Rect edges use MSAA at low supersampling. Each level is
  drawn in tiles of at most 2048 px (`TILE_SIZE`), each with its own batches
  that skip triangles outside it, so the MSAA renderbuffer, its resolve
  texture and the blend backdrop are tile-sized rather than full-size. Tile
  viewport offsets can move sub-pixel edge snapping slightly; that is not a
  seam or quality loss. Textures that
  are first written by a blit (level textures, glow masks, the blend
  backdrop) are cleared, every mip level, before each use: Chrome otherwise
  zero-fills new ones on first use, which took about 0.3 s each at Print
  quality, and reused ones still hold the last render.
- The final WebGL2 level is unrolled into exact geometry
  (`src/render/unroll.ts`), with every item clipped to its ancestor zoom
  quads, up to max recursion and an internal item budget. With fixed levels,
  whole generations are unrolled so every leaf sits at the same depth and the
  seed lands exactly at the requested level on every branch; the details line
  reports when the budget caps recursion. With Auto levels, zooms are
  expanded largest first until they fall below a small pixel size. Remaining
  zooms become leaves sampling the feedback texture; the shallowest leaf
  determines how many feedback levels are needed.
- Progress appears only after a short delay, so fast renders do not flash it,
  and hides as soon as the final frame is shown, before change statistics.
- A fresh render (not a continuation, blended scene, or max recursion of 0
  or 1) posts an early preview: it queues at least 6 feedback levels
  (no more than levels - 1) and draws them with the top level's items, then
  unrolls the exact geometry on the CPU while the GPU works. Only then does
  it call `gl.getError()` (in `checkErrors`) and post the preview, because
  `getError` and `transferToImageBitmap` wait for queued GPU work. Auto
  levels keep any extra preview levels; fixed levels restart if the preview
  went past them, so the result stays exact. Progress is weighted between
  the preview, feedback levels and the reference draw (`*_PROGRESS` in
  `webgl.ts`).
- Frame messages say whether they are final. `resizeCanvas` redraws the
  current frame, stretched, whenever it changes the resolution (which clears
  the bitmap), with edit outlines at the new size. Picture-only toggles
  that start or end fullscreen hold the layout (ignoring resize events)
  until the fullscreen promise settles and, because Chrome reports
  fullscreen before resizing the window, the window size has changed (at
  most 500 ms), then lay out once in that resize event, before it paints.
  Resizes and toggles
  share one 150 ms render debounce and only render if the resolution then
  differs from the shown or rendering one. Those renders keep the stretched
  image until their final frame; the early preview is skipped unless the
  shown frame is itself a preview.
- Loading another definition clears the picture straight away, so the old
  image is never shown stretched to a new shape. Applying an edit keeps the
  old picture until the new one renders, unless the output aspect changed.
- Frames are posted with `transferToImageBitmap` straight from the GL
  canvas, after a blit from the resolved output texture; there are no pixel
  readbacks.
- The render worker is kept while idle and holds the last render's working
  state. A request that differs only by more fixed levels continues from it:
  it adds feedback levels and redraws the kept exact geometry (identical
  to a full render). A
  level increase that arrives while busy waits and replaces any earlier
  waiting increase; any other change terminates the busy worker. The Custom
  Levels row has a +1 button that uses this path.
- An idle worker keeps its WebGL context (module-level `gpu` in
  `webgl.ts`) for the next render: compiled programs, the vertex buffer and
  array, and pools of textures, renderbuffers and framebuffers keyed by size
  and format. Disposing a render gives its resources back to the pools;
  spares of other sizes are freed before allocating and unused spares after.
  Each render resets the bound framebuffer, blending and texture units, and
  clears what it takes, so output matches a new context exactly. A failed
  render loses the context. This saves about 0.3 s per Print render.
- Every render reports the fraction of display pixels that changed, compared
  premultiplied by more than rounding noise, between the final image and one
  step before it: the previous level (an extra output draw before the last
  feedback level), including continuations. A compare shader counts changed
  pixels (any channel over 2.5/255) per 15x15 block on the GPU, so only the
  small count texture is read back.
- The progress bar is a thin overlay along the bottom of the window, outside
  the panel, so it stays visible when the panel is hidden and never moves
  controls. Render details live inside the Render settings section and list
  only what the inputs do not show; the resolved supersampling,
  recursion and levels are hover text on the Quality row and settings header.
- Captures must exclude the host background and preserve transparency.
- Downsampling must weight colours by alpha. Each 2x2 block's alpha is its
  average moved towards its maximum (`shading.detail` > 0) or minimum
  (< 0) by |detail|, with the alpha-weighted colour. Detail 0 (default) is a
  plain premultiplied average, matching ordinary scaling and PowerPoint, so
  stacked translucent copies do not darken; 1 keeps fine recursive details
  bold. Glow masks always use 1. WebGL2 stores premultiplied texels.
- Dynamic recursion stops before leaves become smaller than the selected
  quality threshold.
- Be mindful of multiplicative cost: zoom count, recursion depth,
  supersampling, mip generation, and texture size all compound.
  Working images are limited by both the device texture size and a
  96-million-pixel practical allocation budget (Print at 16:9 fits).
- Edit mode follows expanded items in the Visual editor, not a checkbox or
  scene syntax. The expanded Scene items heading holds a compact + menu.
  Expanded items get outlines on a separate transparent, pointer-transparent
  overlay, marking their top-left corner and any `align` target points.
  Selection changes never redraw or fade the artwork or affect worker requests.
  The overlay follows display resizing and picture transforms and stays out of
  captures and exports.
  When declared view and output bounds differ, selected zooms show the
  transformed declared view dashed and the transformed full canvas dotted in
  the same colour; the corner marker stays on the declared view.

## Panel behaviour

- The panel overlays the canvas from the right, covering the wall label
  before the picture; it must never shift the image.
- Hiding it must leave no gutter or visible residue.
- It starts hidden when the address chooses a picture (`example`, `source`,
  `q` or a fragment), and open otherwise. Definition errors open it so the
  message is visible.
- The single corner control sits in the window's top-right corner. It is an
  X while open and morphs into three lines before fading. Hovering near the
  top-right reveals it; on touch screens, tapping the bare wall (not the
  picture or its cards) reveals or hides it, and it fades after 3 s if
  unused. Reopening reverses the transition.
- Tapping or clicking the picture (not when it has point inputs) shows
  it alone: no border, margin, label or toggle, filling the window (and the
  screen, where fullscreen is allowed) on the frame background, keeping the
  frame padding around it. An input card stays beside or below it, as on
  the wall, with a small margin; using it never exits or pans. There,
  touch pinches zoom (up to 8x) and drags pan, and scrolling down zooms in
  (up zooms out) about the mouse, via a CSS transform on the frame. It is
  clamped to keep covering the on-screen area it fills unzoomed, so zooming
  in never slides the point being zoomed; it resets on exit
  or resize. A tap without a gesture, or leaving fullscreen, returns to
  the wall. It works with the panel open, which hides for it and reopens
  on return.
- Keyboard shortcuts live in one capture-phase `keydown` handler in
  `main.ts` and are listed in the guide's Keyboard shortcuts section. Letter
  keys are ignored while typing in a field or the editor; Ctrl/Cmd combos
  (Enter applies, S downloads the definition) work everywhere. All are off
  while the Share dialog is open. The canvas is focusable (`role="img"`,
  labelled from the title and description) so Enter toggles picture-only.
  When the scene has point inputs, arrows on the focused canvas move the
  last-pressed one (1% of the view, Shift 10%) and Space picks the next.
- The toggle has a constant label with `aria-expanded`. The wall label has a
  share button in its top-right corner. The panel header has a matching share
  icon beside the close control instead of a full-width Share button.
  Show label is an app setting inside the Visual editor's Frame and wall
  section, not a scene definition key.
  Render quality sits with the Visual definition sections and above the YAML
  editor in YAML mode; the same controls move between them, retaining their
  settings and disclosure state. Quality stays out of scene syntax.
- Share dialog tabs use a roving tabindex: one Tab stop, arrows and
  Home/End move between tabs.
- `viewport-fit=cover` lets the page reach under notches; the toggle,
  panel, guide and wall margin add `env(safe-area-inset-*)`. The
  `theme-color` meta follows the frame wall. Forced-colors mode keeps the
  toggle, resize edge and progress bar visible with system colours and
  leaves the wall and label as the artwork defines them.
- The left panel edge is draggable, and focusable: Left/Right arrows resize
  it, Home/End jump to the limits.
- Below 700 px wide the panel and guide fill the screen and the resize edge
  is hidden. Coarse pointers get 44 px touch targets. Reduced-motion
  preferences switch transitions off. Heights use `dvh` so mobile toolbars
  do not clip the page.
- Production registers `sw.js`; development does not. The build lists and
  precaches every output file. Navigations try the network first and fall
  back to the cached app, while content-hashed assets use the cache first.
  This keeps bundled examples, rendering and exports available offline;
  remote `?source=` definitions and external links still need a connection.
- The controls scroll within the panel when the window is too short.
- Share opens a modal dialog (`src/share-dialog.ts`) with Image (preview,
  size, transparency, copy and download), Link (optional input values and app
  settings, copy), QR code (the same link options plus a centred preview,
  on by default, copy and download), Definition (download the applied
  definition as YAML, or open a saved one) and PowerPoint (download) tabs. A YAML file dropped anywhere on
  the window loads the same way. Image and PowerPoint actions stay disabled until the latest full
  render has finished. Ctrl+C copies whatever the open tab shows, unless text is
  selected, in which case the browser's own copy is left alone. Clicking either
  preview enlarges it and widens the dialog; clicking again goes back.
  A seed-only scene that may fade while PowerPoint updates its Slide Zooms
  also carries the same warning in the slide's speaker notes.
  QR codes use `qrcode-generator`, loaded on demand, with
  error correction H when the preview covers the middle (at most 30% of the
  width) and M otherwise. The QR square size is rounded up to a multiple of 4
  pixels so the preview, which shows the code at exactly a quarter of full size,
  keeps sharp edges; clicking it toggles to a half.
  The preview is the transparent picture cropped to its
  non-transparent pixels. It sits on a white backing that follows its shape with
  narrow gaps filled in (a morphological closing using distance transforms),
  with a thin fading halo, and is drawn with slightly offset copies beneath it
  to thicken very thin lines.
- The PowerPoint export is one slide of the top level only. Filled shapes become
  `p:sp` vector shapes; each zoom is an `mc:AlternateContent` holding a
  self-referencing Slide Zoom (`pslz:sldZmObj` whose `sldId` is the slide's own
  ID and whose `cId` equals the slide's `p14:creationId`, with `showBg="0"` so
  copies stay transparent) and a fallback picture. Both use the rendered canvas
  (at most 1920 px) as the zoom's cached image; PowerPoint redraws the
  recursion itself. Frames are placed by mapping each element's rotated edges
  onto the slide and decomposing into `rot` (60000ths of a degree, clockwise)
  plus `flipV`, which PowerPoint applies before rotating. Scene units that are
  not square on the slide would slant rotated frames, so that is an error.
  Glows go in the zoom's `p166:spPr` effect list and on the fallback picture;
  PowerPoint draws them around the shapes the zoom shows. The seed needs no
  export because the zooms bottom out in the cached picture.
  `powerPointLimits` lists what cannot be carried over (density shading, zoom
  opacity and glow softness), and warns when nothing but the seed draws: with no
  visible rect or glow, PowerPoint's repeated cache updates can fade the picture out. Colours are normalised by drawing them to a 1x1
  canvas.
- Keep the YAML editor monospace and tall enough to show useful context.
- Visual is the default definition editor; YAML is the secondary view of the
  same draft. Visual changes auto-apply after 500 ms; YAML waits for Apply or
  switching back to Visual. Invalid drafts retain the last valid picture.
  Collapsible sections edit every top-level setting, including variables and view.
  Scene cards have subtle type-specific tints and arrow/bin controls in their
  headings. Headings drag via mouse/touch with a horizontal insertion marker.
  Touch requires a one-second hold that lifts the card; earlier swipes scroll normally.
  Cards expand, add/remove and reorder via headings, buttons or
  Alt+Up/Down on their headings. Form edits have Undo/Redo. Do not resolve
  expressions into numbers or discard unsupported settings when switching modes.
- Editor wrapping is on by default with a "Wrap lines" toggle. Long unbroken
  runs such as URLs may break at any character; prose wraps between words.
- Blocks and list items can be folded from the gutter or with Ctrl+Shift+[ / ].
- The editor (`src/editor.ts`) is CodeMirror 6 with YAML highlighting,
  space-only Tab indenting, indent markers, hanging indents for wrapped
  lines (so continuation rows stay right of the guides), and a linter that runs
  `parseSceneWithDiagnostics` as you type. Scene errors are tagged with the
  definition path being parsed (`atPath`, innermost wins) and mapped to text
  ranges with the `yaml` document, so new checks should throw inside the
  right `atPath` or throw a `PathError` for the offending key.
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

- Canvas intrinsic dimensions match the selected quality resolution.
- Transparent areas still have zero alpha.
- Progress appears during slow work and disappears after completion.
- Fast, Display, High and Print quality resolve automatic levels where the
  picture settles, at or beyond the fixed point.
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
