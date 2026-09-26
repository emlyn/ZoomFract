import { renderCanvas2d } from './canvas2d';
import {
  continuationKey,
  resolveRenderSettings,
  type FrameCallbacks,
  type RenderMessage,
  type RendererName,
  type RenderRequest,
  type RenderResult,
  type RenderSettings,
} from './common';
import { isWebglAvailable, renderWebgl } from './webgl';

const post = (message: RenderMessage, transfer: Transferable[] = []) => {
  self.postMessage(message, { transfer });
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function frameCallbacks(width: number, height: number): FrameCallbacks {
  const display = new OffscreenCanvas(width, height);
  const context = display.getContext('2d')!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return {
    frame: (source) => {
      context.clearRect(0, 0, width, height);
      context.drawImage(source, 0, 0, width, height);
      const bitmap = display.transferToImageBitmap();
      post({ type: 'frame', bitmap }, [bitmap]);
    },
    progress: (progress) => post({ type: 'progress', progress }),
  };
}

type Session = {
  key: string;
  renderer: RendererName;
  settings: RenderSettings;
  fallbackReason?: string;
  result: RenderResult;
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
  const details = current.result.continueTo(settings, frameCallbacks(width, height));
  const from = current.settings.levels;
  current.settings = settings;
  post({
    type: 'done',
    milliseconds: performance.now() - startedAt,
    details: [...details, `continued from ${from}`],
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
  const candidates: RendererName[] = request.options.renderer === 'webgl'
    ? ['webgl', 'canvas2d']
    : ['canvas2d'];
  let fallbackReason: string | undefined;

  for (const renderer of candidates) {
    try {
      if (renderer === 'webgl' && !isWebglAvailable()) {
        throw new Error('WebGL2 is not available in workers');
      }
      const settings = resolveRenderSettings(request.scene, request.options, renderer);
      post({ type: 'start', renderer, settings, fallbackReason });
      const draw = renderer === 'webgl' ? renderWebgl : renderCanvas2d;
      const result = draw(request.scene, settings, request.editMode, frameCallbacks(width, height));
      session = { key: continuationKey(request), renderer, settings, fallbackReason, result };
      post({ type: 'done', milliseconds: performance.now() - startedAt, details: result.details });
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
