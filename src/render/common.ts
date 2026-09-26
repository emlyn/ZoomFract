import {
  rectCorner,
  type CornerName,
  type RectGeometry,
  type SceneDefinition,
  type Vec2,
  type ZoomElement,
} from '../scene';

export type QualityMode = 'fast' | 'high' | 'custom';

export type RendererName = 'webgl' | 'canvas2d';

export type RenderOptions = {
  renderer: RendererName;
  supersampling: number;
  // Maximum generations of zooms drawn as exact geometry.
  recursionDepth: number;
  // Total recursion including texture feedback; 'auto' runs to the fixed point.
  levels: number | 'auto';
};

export type RenderSettings = {
  recursionDepth: number;
  levels: number;
  autoLevels: boolean;
  renderPasses: number;
  supersampling: number;
};

export type RenderRequest = {
  scene: SceneDefinition;
  options: RenderOptions;
  editMode: boolean;
};

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
  typeof from.options.levels === 'number'
  && typeof to.options.levels === 'number'
  && to.options.levels > from.options.levels
  && continuationKey(from) === continuationKey(to);

export const RENDERER_LABELS: Record<RendererName, string> = {
  webgl: 'WebGL2',
  canvas2d: 'Canvas 2D',
};

export const EDIT_MODE_ZOOM_OPACITY = 0.6;

export const MAXIMUM_LEVELS = 64;
const FIXED_POINT_LEAF_PIXELS = 0.5;
// Canvas 2D recursion is exponential, so its geometric depth stays bounded.
const CANVAS2D_MINIMUM_LEAF_PIXELS = 2;
const CANVAS2D_MAXIMUM_LEAVES = 10000;

export const QUALITY_LABELS: Record<QualityMode, string> = {
  fast: 'Fast',
  high: 'High quality',
  custom: 'Custom',
};

export const QUALITY_MODES: Record<Exclude<QualityMode, 'custom'>, RenderOptions> = {
  fast: { renderer: 'webgl', supersampling: 2, recursionDepth: 1, levels: 'auto' },
  high: { renderer: 'webgl', supersampling: 4, recursionDepth: 14, levels: 'auto' },
};

export const SUPERSAMPLING_CHOICES = [1, 2, 3, 4];
export const MAXIMUM_RECURSION_CHOICE = 16;

export function scenePointToCanvas(point: Vec2, scene: SceneDefinition): Vec2 {
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

export function elementCorners(element: RectGeometry, scene: SceneDefinition): Vec2[] {
  return (['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as CornerName[])
    .map((name) => scenePointToCanvas(rectCorner(element, name), scene));
}

// Levels count generations of zooms: generation `levels` is the terminal seed,
// and earlier generations are drawn as exact geometry or by sampling an
// earlier rendering. Automatic levels are estimated as the point where the
// largest zoom is below half a working pixel. Canvas 2D treats that as an upper
// bound and stops sooner once a pass barely changes its captured pixels.
export function resolveRenderSettings(
  scene: SceneDefinition,
  options: RenderOptions,
  renderer: RendererName,
): RenderSettings {
  const { supersampling } = options;
  const zooms = scene.elements.filter((element): element is ZoomElement => element.kind === 'zoom');
  if (zooms.length === 0) {
    return { recursionDepth: 0, levels: 0, autoLevels: options.levels === 'auto', renderPasses: 1, supersampling };
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
  const levels = options.levels === 'auto'
    ? Math.min(MAXIMUM_LEVELS, generationsAbove(FIXED_POINT_LEAF_PIXELS, MAXIMUM_LEVELS) + 1)
    : options.levels;
  // Generation `levels` holds the terminal seed, so geometry stops one short.
  const requestedDepth = Math.min(options.recursionDepth, levels - 1);
  if (renderer === 'webgl') {
    return { recursionDepth: requestedDepth, levels, autoLevels, renderPasses: 1, supersampling };
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
    renderPasses: Math.max(1, Math.ceil(levels / (recursionDepth + 1))),
    supersampling,
  };
}
