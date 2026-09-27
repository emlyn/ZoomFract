import { renderCanvas2d } from './canvas2d';
import {
  changedFraction,
  continuationKey,
  resolveRenderSettings,
  type FrameCallbacks,
  type RenderMessage,
  type RendererName,
  type RenderRequest,
  type RenderResult,
  type RenderSettings,
  type StepChange,
} from './common';
import { renderWebgl } from './webgl';

const post = (message: RenderMessage, transfer: Transferable[] = []) => {
  self.postMessage(message, { transfer });
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

type Snapshot = { pixels: Uint8ClampedArray; levels: number };

// Frames and comparison references are read back at display resolution, so
// the final image can be compared with the one before it.
function frameCallbacks(width: number, height: number, initial: Snapshot | null) {
  const display = new OffscreenCanvas(width, height);
  const context = display.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  let previous: Snapshot | null = null;
  let current = initial;
  const snapshot = (source: OffscreenCanvas, levels: number) => {
    context.clearRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
    previous = current;
    current = { pixels: context.getImageData(0, 0, width, height).data, levels };
  };
  const callbacks: FrameCallbacks = {
    frame: (source, levels) => {
      snapshot(source, levels);
      const bitmap = display.transferToImageBitmap();
      post({ type: 'frame', bitmap }, [bitmap]);
    },
    reference: snapshot,
    progress: (progress) => post({ type: 'progress', progress }),
  };
  const stepChange = (): StepChange | undefined => previous && current && current.levels > previous.levels
    ? { fraction: changedFraction(previous.pixels, current.pixels), levels: current.levels - previous.levels }
    : undefined;
  return { callbacks, current: () => current, stepChange };
}

type Session = {
  key: string;
  renderer: RendererName;
  settings: RenderSettings;
  fallbackReason?: string;
  result: RenderResult;
  // Total time spent on this image, including continuations.
  milliseconds: number;
  snapshot: Snapshot | null;
};

// The latest completed render, kept so fixed levels can be extended.
let session: Session | null = null;

function continueSession(current: Session, request: RenderRequest): boolean {
  if (current.key !== continuationKey(request) || current.settings.autoLevels || request.options.levels === 'auto') {
    return false;
  }
  const resolved = resolveRenderSettings(request.scene, request.options, current.renderer);
  const addedLevels = resolved.levels - current.settings.levels;
  if (addedLevels <= 0) {
    return false;
  }

  const startedAt = performance.now();
  const settings: RenderSettings = current.renderer === 'webgl'
    // WebGL keeps the exact geometry from the render being continued.
    ? { ...resolved, recursionDepth: current.settings.recursionDepth }
    : { ...resolved, renderPasses: Math.ceil(addedLevels / (resolved.recursionDepth + 1)) };
  post({ type: 'start', renderer: current.renderer, settings, fallbackReason: current.fallbackReason });
  const { width, height } = request.scene.view.resolution;
  const frames = frameCallbacks(width, height, current.snapshot);
  const outcome = current.result.continueTo(settings, frames.callbacks);
  const stepMilliseconds = performance.now() - startedAt;
  current.settings = settings;
  current.milliseconds += stepMilliseconds;
  current.snapshot = frames.current();
  post({
    type: 'done',
    levels: outcome.levels,
    renderPasses: outcome.renderPasses,
    milliseconds: current.milliseconds,
    stepMilliseconds,
    stepChange: outcome.stepChange ?? frames.stepChange(),
    details: outcome.details,
  });
  return true;
}

function render(request: RenderRequest) {
  if (session) {
    try {
      if (continueSession(session, request)) {
        return;
      }
    } catch (error) {
      session.result.dispose();
      session = null;
      post({ type: 'error', message: errorMessage(error) });
      return;
    }
    session.result.dispose();
    session = null;
  }

  const startedAt = performance.now();
  const { width, height } = request.scene.view.resolution;
  const density = request.scene.shading.mode === 'density';
  const glow = request.scene.elements.some((element) => element.glow);
  const webgl = request.options.renderer === 'webgl' && !request.webglDisabled;
  const disabled = request.webglDisabled ? `. ${request.webglDisabled}` : '';
  if (density && !webgl) {
    post({ type: 'error', message: `Density shading needs the WebGL2 renderer${disabled}` });
    return;
  }
  if (glow && !webgl) {
    post({ type: 'error', message: `Glows need the WebGL2 renderer${disabled}` });
    return;
  }
  const candidates: RendererName[] = density || glow
    ? ['webgl']
    : webgl
      ? ['webgl', 'canvas2d']
      : ['canvas2d'];
  let fallbackReason = request.options.renderer === 'webgl' ? request.webglDisabled : undefined;

  for (const renderer of candidates) {
    try {
      const settings = resolveRenderSettings(request.scene, request.options, renderer);
      post({ type: 'start', renderer, settings, fallbackReason });
      const draw = renderer === 'webgl' ? renderWebgl : renderCanvas2d;
      const frames = frameCallbacks(width, height, null);
      const { outcome, ...result } = draw(request.scene, settings, request.editMode, frames.callbacks);
      const milliseconds = performance.now() - startedAt;
      session = {
        key: continuationKey(request),
        renderer,
        settings: { ...settings, levels: outcome.levels },
        fallbackReason,
        result: { outcome, ...result },
        milliseconds,
        snapshot: frames.current(),
      };
      post({
        type: 'done',
        levels: outcome.levels,
        renderPasses: outcome.renderPasses,
        milliseconds,
        stepChange: outcome.stepChange ?? frames.stepChange(),
        details: outcome.details,
      });
      return;
    } catch (error) {
      fallbackReason = errorMessage(error);
    }
  }

  post({ type: 'error', message: fallbackReason ?? 'Rendering failed' });
}

self.addEventListener('message', (event: MessageEvent<RenderRequest>) => {
  render(event.data);
});
