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

- `src/main.ts`: scene types, YAML parsing, geometry resolution, UI creation,
  rendering, quality presets, cancellation, and progress.
- `src/examples.ts`: built-in example registry and metadata.
- `src/examples/*.yaml`: loadable example scene definitions.
- `src/style.css`: full-window layout, overlay panel, controls, animations,
  and canvas presentation.
- `index.html`: application shell.
- `vite.config.ts`: static-host-friendly Vite configuration.

This is still a compact prototype. Make surgical changes in the existing
files unless extracting a module clearly reduces complexity.

## Scene language invariants

- The top-level model contains `frame`, `view`, `seed`, and `scene`.
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

### Rectangles

- `rect` is borderless by default and uses `color` (default black) plus
  optional `opacity`.
- Geometry may be determined from a sufficient combination of `centre`,
  width, height, named corners, and rotation.
- Numeric rotations are degrees, and positive rotations are clockwise.
  Explicit `deg`, `rad`, and unit-object forms are supported. Internal
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
- Keep quality controls out of the scene definition. Recursion depth, render
  passes, supersampling, leaf-size thresholds, and leaf budgets are application
  quality settings.

## Rendering invariants

- The visible canvas backing resolution must exactly match `view.resolution`.
  Scale it with CSS to fit the window without changing intrinsic pixel size.
- The canvas remains centred and independent of the overlay panel width.
- Rendering is progressive: display each completed pass before preparing the
  next capture.
- Long renders must yield between passes and mip levels so progress can paint.
- Changing settings invalidates obsolete work. Cancel at safe boundaries and
  finish only the newest requested render.
- Keep the progress bar fixed at the panel bottom so showing it never moves
  controls.
- Captures must exclude the host background and preserve transparency.
- Downsampling must weight colours by alpha and prioritise non-transparent
  coverage so fine recursive details do not disappear prematurely.
- Terminal bitmap leaves use projected-size, transform-aware rasterisation and
  cache equivalent leaf transforms.
- Dynamic recursion stops before leaves become smaller than the selected
  quality threshold or another level would exceed its leaf budget.
- Be mindful of multiplicative cost: zoom count, recursion depth, passes,
  supersampling, mip generation, and temporary canvas size all compound.
- Edit mode is an application setting, not scene syntax. It fades top-level
  zoom contents and outlines each zoom, marking its top-left corner and any
  `align` target points. Captures
  used for recursion must stay unfaded, so edit mode renders a separate
  display-only pass and draws outlines on the display canvas.

## Panel behaviour

- The panel overlays the canvas from the left; it must never shift the image.
- Hiding it must leave no gutter or visible residue.
- The single corner control is an X while open. It moves left and morphs into
  three lines before fading. Hovering near the top-left reveals it; reopening
  reverses the transition.
- The right panel edge is draggable. The corner control must track resizing
  immediately, without its normal horizontal animation.
- Keep the YAML editor monospace and tall enough to show useful context.

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
- Progressive passes visibly differ and the final pass remains displayed.
- Progress appears during slow work and disappears after completion.
- Fast, Balanced, High, and Proof presets resolve sensible dynamic depths.
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
