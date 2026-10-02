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

export type RenderOptions = {
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
// About a 12800 x 7200 working image (Print at 16:9). WebGL keeps two
// full-size level textures with mips (four with zoom glows), about 1 GB at
// this size, so a dimension-only limit can still request far too much GPU
// memory.
export const MAX_WEBGL_WORKING_PIXELS = 96_000_000;

// Fraction of pixels that changed between two images, and how many levels
// apart they were.
export type StepChange = { fraction: number; levels: number };

export type RenderMessage =
  | { type: 'start'; settings: RenderSettings }
  | { type: 'progress'; progress: number }
  | { type: 'frame'; bitmap: ImageBitmap; final: boolean }
  | {
    type: 'done';
    levels: number;
    milliseconds: number;
    stepMilliseconds?: number;
    stepChange?: StepChange;
    details: string[];
  }
  | { type: 'error'; message: string };

export type FrameCallbacks = {
  // Earlier frames are rougher previews of the final one.
  frame: (canvas: OffscreenCanvas, final: boolean) => void;
  progress: (progress: number) => void;
};

export type RenderOutcome = {
  details: string[];
  levels: number;
  stepChange?: StepChange;
};

// A finished render keeps its working state so fixed levels can be extended
// without starting again.
export type RenderResult = {
  outcome: RenderOutcome;
  continueTo: (settings: RenderSettings, callbacks: FrameCallbacks) => RenderOutcome;
  dispose: () => void;
};

// Requests with equal keys differ only in levels, so a render can continue
// from an earlier one with fewer fixed levels.
export const continuationKey = ({ scene, options, editMode }: RenderRequest) =>
  JSON.stringify([scene, options.supersampling, options.recursionDepth, editMode]);

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

export const EDIT_MODE_ZOOM_OPACITY = 0.6;

export const MAXIMUM_LEVELS = 256;
export const EXTRA_LEVELS_STEP = 256;
// Non-shrinking zooms never reach a pixel-size stopping point. Keep their
// previous bound rather than spending four times as long on an infinite scene.
const NON_SHRINKING_LEVELS = 64;
const FIXED_POINT_LEAF_PIXELS = 0.5;

export const QUALITY_LABELS: Record<QualityMode, string> = {
  fast: 'Fast',
  display: 'Display',
  high: 'High quality',
  print: 'Print',
  custom: 'Custom',
};

export const QUALITY_MODES: Record<Exclude<QualityMode, 'custom'>, QualityOptions> = {
  fast: {
    supersampling: 2, recursionDepth: 1, levels: 'auto',
    resolution: { mode: 'display', scale: 0.5, maxSide: 1500 },
  },
  display: {
    supersampling: 2, recursionDepth: 8, levels: 'auto',
    resolution: { mode: 'display', scale: 1, maxSide: 3000 },
  },
  high: {
    supersampling: 4, recursionDepth: 14, levels: 'auto',
    resolution: { mode: 'fixed', height: 1500 },
  },
  print: {
    supersampling: 2, recursionDepth: 16, levels: 'auto',
    resolution: { mode: 'fixed', height: 3600 },
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
// largest zoom is below half a working pixel.
export function resolveRenderSettings(
  scene: ResolvedSceneDefinition,
  options: RenderOptions,
  additionalLevels = 0,
): RenderSettings {
  const { supersampling } = options;
  const zooms = scene.elements.filter((element): element is ZoomElement => element.kind === 'zoom');
  if (zooms.length === 0) {
    return {
      recursionDepth: 0, levels: 0, autoLevels: options.levels === 'auto',
      autoLevelLimitReached: false, supersampling,
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
  const recursionDepth = Math.min(options.recursionDepth, levels - 1);
  return { recursionDepth, levels, autoLevels, autoLevelLimitReached, supersampling };
}
