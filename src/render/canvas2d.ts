import {
  scaleVector,
  subtract,
  vectorLength,
  type RectElement,
  type SceneDefinition,
  type Vec2,
  type ZoomElement,
} from '../scene';
import {
  changedFraction,
  CONVERGED_FRACTION,
  EDIT_MODE_ZOOM_OPACITY,
  elementCorners,
  type FrameCallbacks,
  type RenderOutcome,
  type RenderResult,
  type RenderSettings,
} from './common';

type CapturedScene = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  levels: OffscreenCanvas[];
  leafRasters: Map<string, OffscreenCanvas>;
};

const LEAF_RASTER_OVERSAMPLING = 2;

let ctx: OffscreenCanvasRenderingContext2D;

function tracePolygon(points: Vec2[]) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.closePath();
}

function drawRectElement(element: RectElement, scene: SceneDefinition) {
  const corners = elementCorners(element, scene);

  ctx.save();
  ctx.globalAlpha *= element.opacity;
  ctx.fillStyle = element.color;
  tracePolygon(corners);
  ctx.fill();
  ctx.restore();
}

function drawSeedElement(element: ZoomElement, scene: SceneDefinition) {
  ctx.save();
  ctx.globalAlpha *= scene.seed.opacity * element.opacity;
  ctx.fillStyle = scene.seed.color;
  tracePolygon(elementCorners(element, scene));
  ctx.fill();
  ctx.restore();
}

function drawCapturedElement(
  element: ZoomElement,
  scene: SceneDefinition,
  capturedScene: CapturedScene,
) {
  const [topLeft, topRight, bottomRight, bottomLeft] = elementCorners(element, scene);
  const transform = ctx.getTransform();
  const transformPoint = (point: Vec2): Vec2 => ({
    x: transform.a * point.x + transform.c * point.y + transform.e,
    y: transform.b * point.x + transform.d * point.y + transform.f,
  });
  const displayTopLeft = transformPoint(topLeft);
  const displayTopRight = transformPoint(topRight);
  const displayBottomLeft = transformPoint(bottomLeft);
  const displayBottomRight = transformPoint(bottomRight);
  const displayWidth = vectorLength(subtract(displayTopRight, displayTopLeft));
  const displayHeight = vectorLength(subtract(displayBottomLeft, displayTopLeft));
  const targetScale = Math.max(
    displayWidth * LEAF_RASTER_OVERSAMPLING / capturedScene.width,
    displayHeight * LEAF_RASTER_OVERSAMPLING / capturedScene.height,
  );
  const targetLevel = targetScale >= 1
    ? 0
    : Math.max(0, Math.floor(Math.log2(1 / targetScale)));
  const source = capturedScene.levels[Math.min(targetLevel, capturedScene.levels.length - 1)];
  const projectedCorners = [
    displayTopLeft,
    displayTopRight,
    displayBottomRight,
    displayBottomLeft,
  ];
  const left = Math.max(0, Math.floor(Math.min(...projectedCorners.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...projectedCorners.map((point) => point.y))));
  const right = Math.min(ctx.canvas.width, Math.ceil(Math.max(...projectedCorners.map((point) => point.x))));
  const bottom = Math.min(ctx.canvas.height, Math.ceil(Math.max(...projectedCorners.map((point) => point.y))));
  if (right <= left || bottom <= top) {
    return;
  }
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const relativeCorners = projectedCorners.map((point) => ({
    x: point.x - left,
    y: point.y - top,
  }));
  const cacheKey = [
    source.width,
    source.height,
    width,
    height,
    ...relativeCorners.flatMap((point) => [
      Math.round(point.x * 1000),
      Math.round(point.y * 1000),
    ]),
  ].join(':');
  let raster = capturedScene.leafRasters.get(cacheKey);

  if (!raster) {
    const oversampled = new OffscreenCanvas(
      width * LEAF_RASTER_OVERSAMPLING,
      height * LEAF_RASTER_OVERSAMPLING,
    );
    const rasterContext = oversampled.getContext('2d')!;
    const [rasterTopLeft, rasterTopRight, , rasterBottomLeft] = relativeCorners
      .map((point) => scaleVector(point, LEAF_RASTER_OVERSAMPLING));

    rasterContext.imageSmoothingEnabled = true;
    rasterContext.imageSmoothingQuality = 'high';
    rasterContext.beginPath();
    rasterContext.moveTo(
      relativeCorners[0].x * LEAF_RASTER_OVERSAMPLING,
      relativeCorners[0].y * LEAF_RASTER_OVERSAMPLING,
    );
    relativeCorners.slice(1).forEach((point) => rasterContext.lineTo(
      point.x * LEAF_RASTER_OVERSAMPLING,
      point.y * LEAF_RASTER_OVERSAMPLING,
    ));
    rasterContext.closePath();
    rasterContext.clip();
    rasterContext.transform(
      (rasterTopRight.x - rasterTopLeft.x) / source.width,
      (rasterTopRight.y - rasterTopLeft.y) / source.width,
      (rasterBottomLeft.x - rasterTopLeft.x) / source.height,
      (rasterBottomLeft.y - rasterTopLeft.y) / source.height,
      rasterTopLeft.x,
      rasterTopLeft.y,
    );
    rasterContext.drawImage(source, 0, 0);
    raster = downsampleAlphaPreserving(oversampled);
    capturedScene.leafRasters.set(cacheKey, raster);
  }

  const inheritedAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = inheritedAlpha * element.opacity;
  ctx.drawImage(raster, left, top);
  ctx.restore();
}

function drawZoomElement(
  element: ZoomElement,
  scene: SceneDefinition,
  depth: number,
  recursionLevel: number,
  capturedScene: CapturedScene | null,
) {
  const [topLeft, topRight, bottomRight, bottomLeft] = elementCorners(element, scene);
  const sourceWidth = scene.view.resolution.width;
  const sourceHeight = scene.view.resolution.height;

  ctx.save();
  ctx.globalAlpha *= element.opacity;
  tracePolygon([topLeft, topRight, bottomRight, bottomLeft]);
  ctx.clip();
  ctx.transform(
    (topRight.x - topLeft.x) / sourceWidth,
    (topRight.y - topLeft.y) / sourceWidth,
    (bottomLeft.x - topLeft.x) / sourceHeight,
    (bottomLeft.y - topLeft.y) / sourceHeight,
    topLeft.x,
    topLeft.y,
  );
  drawScene(scene, depth, recursionLevel + 1, capturedScene);
  ctx.restore();
}

function drawScene(
  scene: SceneDefinition,
  depth: number,
  recursionLevel: number,
  capturedScene: CapturedScene | null,
  fadeZooms = false,
) {
  for (const element of scene.elements) {
    if (element.kind === 'rect') {
      drawRectElement(element, scene);
      continue;
    }

    ctx.save();
    if (fadeZooms) {
      ctx.globalAlpha *= EDIT_MODE_ZOOM_OPACITY;
    }
    if (recursionLevel < depth) {
      drawZoomElement(element, scene, depth, recursionLevel, capturedScene);
    } else if (capturedScene) {
      drawCapturedElement(element, scene, capturedScene);
    } else {
      drawSeedElement(element, scene);
    }
    ctx.restore();
  }
}


function downsamplePixels(source: ImageData): ImageData {
  const width = Math.max(1, Math.ceil(source.width / 2));
  const height = Math.max(1, Math.ceil(source.height / 2));
  const output = new ImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let maxAlpha = 0;
      let alphaTotal = 0;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (let sourceY = y * 2; sourceY < Math.min(y * 2 + 2, source.height); sourceY += 1) {
        for (let sourceX = x * 2; sourceX < Math.min(x * 2 + 2, source.width); sourceX += 1) {
          const sourceIndex = (sourceY * source.width + sourceX) * 4;
          const alpha = source.data[sourceIndex + 3];
          maxAlpha = Math.max(maxAlpha, alpha);
          alphaTotal += alpha;
          red += source.data[sourceIndex] * alpha;
          green += source.data[sourceIndex + 1] * alpha;
          blue += source.data[sourceIndex + 2] * alpha;
        }
      }

      const outputIndex = (y * width + x) * 4;
      if (alphaTotal > 0) {
        output.data[outputIndex] = Math.round(red / alphaTotal);
        output.data[outputIndex + 1] = Math.round(green / alphaTotal);
        output.data[outputIndex + 2] = Math.round(blue / alphaTotal);
        output.data[outputIndex + 3] = maxAlpha;
      }
    }
  }

  return output;
}

function canvasFromPixels(pixels: ImageData): OffscreenCanvas {
  const output = new OffscreenCanvas(pixels.width, pixels.height);
  output.getContext('2d')!.putImageData(pixels, 0, 0);
  return output;
}

function readPixels(source: OffscreenCanvas): ImageData {
  return source.getContext('2d')!.getImageData(0, 0, source.width, source.height);
}

function downsampleAlphaPreserving(source: OffscreenCanvas): OffscreenCanvas {
  return canvasFromPixels(downsamplePixels(readPixels(source)));
}

// One readback per capture; the mip chain is then built from pixel arrays.
function captureCanvas(source: OffscreenCanvas, onLevel: () => void): CapturedScene {
  const pixelLevels = [readPixels(source)];
  while (pixelLevels.at(-1)!.width > 1 || pixelLevels.at(-1)!.height > 1) {
    pixelLevels.push(downsamplePixels(pixelLevels.at(-1)!));
    onLevel();
  }

  return {
    width: source.width,
    height: source.height,
    pixels: pixelLevels[0].data,
    levels: pixelLevels.map(canvasFromPixels),
    leafRasters: new Map(),
  };
}

function renderPass(
  target: OffscreenCanvas,
  scene: SceneDefinition,
  settings: RenderSettings,
  depth: number,
  capturedScene: CapturedScene | null,
  fadeZooms = false,
) {
  ctx = target.getContext('2d')!;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.save();
  ctx.scale(settings.supersampling, settings.supersampling);

  drawScene(scene, depth, 0, capturedScene, fadeZooms);
  ctx.restore();
}

function mipLevelCount(width: number, height: number): number {
  return Math.ceil(Math.log2(Math.max(width, height)));
}

export function renderCanvas2d(
  scene: SceneDefinition,
  settings: RenderSettings,
  editMode: boolean,
  callbacks: FrameCallbacks,
): RenderResult {
  const width = scene.view.resolution.width * settings.supersampling;
  const height = scene.view.resolution.height * settings.supersampling;
  const workingCanvas = new OffscreenCanvas(width, height);
  // Captures feed deeper recursion, so edit-mode fading uses a separate display-only pass.
  const editCanvas = editMode ? new OffscreenCanvas(width, height) : null;

  // State after the latest pass, kept so later calls can add more levels.
  let completedLevels = 0;
  let capturedScene: CapturedScene | null = null;
  let lastDepth = 0;
  let workingIsCurrent = true;

  const renderLevels = (
    levels: number,
    depthLimit: number,
    stopWhenConverged: boolean,
    frameCallbacks: FrameCallbacks,
  ): RenderOutcome => {
    const count = levels - completedLevels;
    const passes = Math.max(1, Math.ceil(count / (depthLimit + 1)));
    const captures = completedLevels > 0 ? passes : passes - 1;
    const totalSteps = passes + captures * mipLevelCount(width, height);
    let completedSteps = 0;
    const advance = () => {
      completedSteps += 1;
      frameCallbacks.progress(completedSteps / totalSteps);
    };

    for (let pass = 0; pass < passes; pass += 1) {
      if (completedLevels > 0) {
        if (!workingIsCurrent) {
          renderPass(workingCanvas, scene, settings, lastDepth, capturedScene);
        }
        const previousPixels = capturedScene?.pixels;
        capturedScene = captureCanvas(workingCanvas, advance);
        // Captures are already read back, so automatic levels can stop as
        // soon as a whole pass barely changes anything.
        const fraction = previousPixels ? changedFraction(previousPixels, capturedScene.pixels) : 1;
        if (stopWhenConverged && fraction < CONVERGED_FRACTION) {
          frameCallbacks.progress(1);
          return { details: [], levels: completedLevels, renderPasses: pass, stepChange: { fraction, levels: lastDepth + 1 } };
        }
      }
      // Each pass adds depth + 1 generations; the first pass absorbs any
      // remainder so the seed lands exactly at the requested level.
      const depth = pass === 0 ? Math.max(0, count - (passes - 1) * (depthLimit + 1) - 1) : depthLimit;
      workingIsCurrent = !editCanvas || pass < passes - 1;
      if (workingIsCurrent) {
        renderPass(workingCanvas, scene, settings, depth, capturedScene);
      }
      if (editCanvas) {
        renderPass(editCanvas, scene, settings, depth, capturedScene, true);
      }
      lastDepth = depth;
      completedLevels += depth + 1;
      frameCallbacks.frame(editCanvas ?? workingCanvas, completedLevels);
      advance();
    }
    return { details: [], levels: completedLevels };
  };

  return {
    outcome: renderLevels(settings.levels, settings.recursionDepth, settings.autoLevels, callbacks),
    continueTo: (next, frameCallbacks) => renderLevels(next.levels, next.recursionDepth, false, frameCallbacks),
    dispose: () => {},
  };
}
