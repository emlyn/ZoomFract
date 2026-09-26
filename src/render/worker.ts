import { renderCanvas2d } from './canvas2d';
import {
  resolveRenderSettings,
  type FrameCallbacks,
  type RenderMessage,
  type RendererName,
  type RenderRequest,
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

function render(request: RenderRequest) {
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
      const details = draw(request.scene, settings, request.editMode, frameCallbacks(width, height));
      post({ type: 'done', milliseconds: performance.now() - startedAt, details });
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
