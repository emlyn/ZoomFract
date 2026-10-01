import {
  type DrawableElement,
  rectCorner,
  type CornerName,
  type RectGeometry,
  type ResolvedSceneDefinition,
  scaleVector,
  type Vec2,
  type ZoomElement,
} from '../scene';

export type QualityMode = 'fast' | 'display' | 'high' | 'print' | 'custom';

export type RendererName = 'webgl' | 'canvas2d';

export type RenderOptions = {
  renderer: RendererName;
  supersampling: number;
  // Maximum generations of zooms drawn as exact geometry.
  recursionDepth: number;
  // Total recursion including texture feedback; 'auto' runs to the fixed point.
  levels: number | 'auto';
};

export type ResolutionSetting =
  | { mode: 'display'; scale: number; maxSide: number }
  | { mode: 'fixed'; width?: number; height?: number };

export type QualityOptions = RenderOptions & {
  resolution: ResolutionSetting;
};

export type RenderSettings = {
  recursionDepth: number;
  levels: number;
  autoLevels: boolean;
  autoLevelLimitReached: boolean;
  renderPasses: number;
  supersampling: number;
};

export type RenderRequest = {
  scene: ResolvedSceneDefinition;
  options: RenderOptions;
  editMode: boolean;
  // Extra generations requested after automatic levels hit their limit.
  additionalLevels?: number;
  // Why WebGL2 must not be used, once the GPU has stopped responding.
  webglDisabled?: string;
};

// Retrying WebGL2 after a GPU reset tends to reset it again, and Chrome turns
// the GPU off for every page after a few resets.
export const GPU_LOST_MESSAGE = 'The GPU stopped responding, so WebGL2 is off until the page is reloaded';
// About an 8000 x 6000 working image. WebGL uses several full-size buffers,
// so a dimension-only limit can still request far too much GPU memory.
export const MAX_WEBGL_WORKING_PIXELS = 48_000_000;
// An automatic WebGL failure must not start an enormous CPU render. Canvas
// 2D remains available when the user explicitly chooses it.
export const MAX_CANVAS_FALLBACK_PIXELS = 4_000_000;

// Fraction of pixels that changed between two images, and how many levels
// apart they were.
export type StepChange = { fraction: number; levels: number };

export type RenderMessage =
  | { type: 'start'; renderer: RendererName; settings: RenderSettings; fallbackReason?: string }
  | { type: 'progress'; progress: number }
  | { type: 'frame'; bitmap: ImageBitmap }
  | {
    type: 'done';
    levels: number;
    // Set when fewer passes were needed than announced at the start.
    renderPasses?: number;
    milliseconds: number;
    stepMilliseconds?: number;
    stepChange?: StepChange;
    details: string[];
  }
  | { type: 'error'; message: string };

export type FrameCallbacks = {
  // `levels` is the total recursion shown by the image.
  frame: (canvas: OffscreenCanvas, levels: number) => void;
  // An image one step before the final one, used only for comparison.
  reference: (canvas: OffscreenCanvas, levels: number) => void;
  progress: (progress: number) => void;
};

// Automatic levels may stop before the estimate, so renders report the
// levels and passes they reached. Renderers that detect convergence report its
// change.
export type RenderOutcome = {
  details: string[];
  levels: number;
  renderPasses?: number;
  stepChange?: StepChange;
};

// A finished render keeps its working state so fixed levels can be extended
// without starting again.
export type RenderResult = {
  outcome: RenderOutcome;
  continueTo: (settings: RenderSettings, callbacks: FrameCallbacks) => RenderOutcome;
  dispose: () => void;
};

// Channel differences up to this are rounding noise between equivalent renders.
const CHANGE_THRESHOLD = 2;
// Automatic levels stop once fewer than one pixel in 10,000 changes; exact
// zero is rarely reached because resampling keeps nudging a few pixels.
export const CONVERGED_FRACTION = 0.0001;

// Inputs are unpremultiplied ImageData pixels. Colours are compared
// premultiplied so rounding in nearly transparent pixels is not counted.
export function changedFraction(before: ArrayLike<number>, after: ArrayLike<number>): number {
  let changed = 0;
  for (let index = 0; index < before.length; index += 4) {
    const beforeAlpha = before[index + 3];
    const afterAlpha = after[index + 3];
    const channelChanged = (offset: number) => Math.abs(
      before[index + offset] * beforeAlpha - after[index + offset] * afterAlpha,
    ) > CHANGE_THRESHOLD * 255;
    if (
      Math.abs(beforeAlpha - afterAlpha) > CHANGE_THRESHOLD
      || channelChanged(0)
      || channelChanged(1)
      || channelChanged(2)
    ) {
      changed += 1;
    }
  }
  return changed / (before.length / 4);
}

// Requests with equal keys differ only in levels, so a render can continue
// from an earlier one with fewer fixed levels.
export const continuationKey = ({ scene, options, editMode }: RenderRequest) =>
  JSON.stringify([scene, options.renderer, options.supersampling, options.recursionDepth, editMode]);

export const canContinue = (from: RenderRequest, to: RenderRequest) =>
  continuationKey(from) === continuationKey(to)
  && (
    (typeof from.options.levels === 'number'
      && typeof to.options.levels === 'number'
      && to.options.levels > from.options.levels)
    || (from.options.levels === 'auto'
      && to.options.levels === 'auto'
      && (to.additionalLevels ?? 0) > (from.additionalLevels ?? 0))
  );

export const RENDERER_LABELS: Record<RendererName, string> = {
  webgl: 'WebGL2',
  canvas2d: 'Canvas 2D',
};

export const EDIT_MODE_ZOOM_OPACITY = 0.6;

export const MAXIMUM_LEVELS = 256;
export const EXTRA_LEVELS_STEP = 256;
// Non-shrinking zooms never reach a pixel-size stopping point. Keep their
// previous bound rather than spending four times as long on an infinite scene.
const NON_SHRINKING_LEVELS = 64;
const FIXED_POINT_LEAF_PIXELS = 0.5;
// Canvas 2D recursion is exponential, so its geometric depth stays bounded.
const CANVAS2D_MINIMUM_LEAF_PIXELS = 2;
const CANVAS2D_MAXIMUM_LEAVES = 10000;

export const QUALITY_LABELS: Record<QualityMode, string> = {
  fast: 'Fast',
  display: 'Display',
  high: 'High quality',
  print: 'Print',
  custom: 'Custom',
};

export const QUALITY_MODES: Record<Exclude<QualityMode, 'custom'>, QualityOptions> = {
  fast: {
    renderer: 'webgl', supersampling: 2, recursionDepth: 1, levels: 'auto',
    resolution: { mode: 'display', scale: 0.5, maxSide: 1500 },
  },
  display: {
    renderer: 'webgl', supersampling: 2, recursionDepth: 8, levels: 'auto',
    resolution: { mode: 'display', scale: 1, maxSide: 3000 },
  },
  high: {
    renderer: 'webgl', supersampling: 4, recursionDepth: 14, levels: 'auto',
    resolution: { mode: 'fixed', height: 1200 },
  },
  print: {
    renderer: 'webgl', supersampling: 2, recursionDepth: 16, levels: 'auto',
    resolution: { mode: 'fixed', height: 3000 },
  },
};

export const SUPERSAMPLING_CHOICES = [1, 2, 3, 4];
export const MAXIMUM_RECURSION_CHOICE = 16;

export function scenePointToCanvas(point: Vec2, scene: ResolvedSceneDefinition): Vec2 {
  const view = scene.view;
  const width = view.resolution.width;
  const height = view.resolution.height;
  const xScale = width / (view.coordinates.x.to - view.coordinates.x.from);
  const yScale = height / (view.coordinates.y.to - view.coordinates.y.from);
  return {
    x: (point.x - view.coordinates.x.from) * xScale,
    y: height - (point.y - view.coordinates.y.from) * yScale,
  };
}

export function elementCorners(element: RectGeometry, scene: ResolvedSceneDefinition): Vec2[] {
  return (['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as CornerName[])
    .map((name) => scenePointToCanvas(rectCorner(element, name), scene));
}

export function elementPoints(element: DrawableElement, scene: ResolvedSceneDefinition, factor = 1): Vec2[] {
  if (element.kind === 'rect' || element.kind === 'zoom') {
    return elementCorners(element, scene).map((point) => scaleVector(point, factor));
  }
  if (element.kind === 'polygon') {
    return element.points.map((point) => scaleVector(scenePointToCanvas(point, scene), factor));
  }
  const xScale = scene.view.resolution.width / Math.abs(scene.view.coordinates.x.to - scene.view.coordinates.x.from);
  const yScale = scene.view.resolution.height / Math.abs(scene.view.coordinates.y.to - scene.view.coordinates.y.from);
  const projectedRadius = element.radius * Math.max(xScale, yScale) * factor;
  const angleStep = projectedRadius <= 0.25
    ? Math.PI / 6
    : Math.acos(Math.max(-1, 1 - 0.25 / projectedRadius));
  const count = Math.max(12, Math.min(256, Math.ceil(Math.PI / Math.max(angleStep, 1e-6))));
  return Array.from({ length: count }, (_, index) => {
    const angle = index * Math.PI * 2 / count;
    return scaleVector(scenePointToCanvas({
      x: element.center.x + Math.cos(angle) * element.radius,
      y: element.center.y + Math.sin(angle) * element.radius,
    }, scene), factor);
  });
}

// Levels count generations of zooms: generation `levels` is the terminal seed,
// and earlier generations are drawn as exact geometry or by sampling an
// earlier rendering. Automatic levels are estimated as the point where the
// largest zoom is below half a working pixel. Canvas 2D treats that as an upper
// bound and stops sooner once a pass barely changes its captured pixels.
export function resolveRenderSettings(
  scene: ResolvedSceneDefinition,
  options: RenderOptions,
  renderer: RendererName,
  additionalLevels = 0,
): RenderSettings {
  const { supersampling } = options;
  const zooms = scene.elements.filter((element): element is ZoomElement => element.kind === 'zoom');
  if (zooms.length === 0) {
    return {
      recursionDepth: 0, levels: 0, autoLevels: options.levels === 'auto',
      autoLevelLimitReached: false, renderPasses: 1, supersampling,
    };
  }

  const coordinateWidth = Math.abs(scene.view.coordinates.x.to - scene.view.coordinates.x.from);
  const coordinateHeight = Math.abs(scene.view.coordinates.y.to - scene.view.coordinates.y.from);
  const largestZoomScale = Math.max(...zooms.map((zoom) => Math.max(
    zoom.width / coordinateWidth,
    zoom.height / coordinateHeight,
  )));
  const largestZoomPixels = Math.max(
    scene.view.resolution.width,
    scene.view.resolution.height,
  ) * supersampling * largestZoomScale;
  // Generations until the largest zoom falls below the given size.
  const generationsAbove = (pixels: number, maximum: number) => {
    let generations = 0;
    let size = largestZoomPixels;
    while (generations < maximum && size > pixels && largestZoomScale < 1) {
      generations += 1;
      size *= largestZoomScale;
    }
    return largestZoomScale < 1 ? generations : maximum;
  };

  const autoLevels = options.levels === 'auto';
  const limit = (largestZoomScale < 1 ? MAXIMUM_LEVELS : NON_SHRINKING_LEVELS) + additionalLevels;
  const estimatedLevels = generationsAbove(FIXED_POINT_LEAF_PIXELS, limit) + 1;
  const autoLevelLimitReached = autoLevels && estimatedLevels > limit;
  const levels = options.levels === 'auto'
    ? Math.min(limit, estimatedLevels)
    : options.levels;
  // Generation `levels` holds the terminal seed, so geometry stops one short.
  const requestedDepth = Math.min(options.recursionDepth, levels - 1);
  if (renderer === 'webgl') {
    return { recursionDepth: requestedDepth, levels, autoLevels, autoLevelLimitReached, renderPasses: 1, supersampling };
  }

  const leafLimitedDepth = Math.floor(Math.log(CANVAS2D_MAXIMUM_LEAVES) / Math.log(Math.max(2, zooms.length)));
  const recursionDepth = Math.min(
    requestedDepth,
    generationsAbove(CANVAS2D_MINIMUM_LEAF_PIXELS, requestedDepth),
    leafLimitedDepth,
  );
  return {
    recursionDepth,
    levels,
    autoLevels,
    autoLevelLimitReached,
    renderPasses: Math.max(1, Math.ceil(levels / (recursionDepth + 1))),
    supersampling,
  };
}
