import {
  continuationKey,
  resolveRenderSettings,
  type FrameCallbacks,
  type RenderMessage,
  type RenderRequest,
  type RenderResult,
  type RenderSettings,
} from './common';
import { renderWebgl } from './webgl';

const post = (message: RenderMessage, transfer: Transferable[] = []) => {
  self.postMessage(message, { transfer });
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

// The renderer draws each frame onto its canvas, which is posted as is.
const frameCallbacks: FrameCallbacks = {
  frame: (canvas, final) => {
    const bitmap = canvas.transferToImageBitmap();
    post({ type: 'frame', bitmap, final }, [bitmap]);
  },
  progress: (progress) => post({ type: 'progress', progress }),
};

type Session = {
  key: string;
  settings: RenderSettings;
  result: RenderResult;
  // Total time spent on this image, including continuations.
  milliseconds: number;
};

// The latest completed render, kept so fixed levels can be extended.
let session: Session | null = null;

function continueSession(current: Session, request: RenderRequest): boolean {
  if (current.key !== continuationKey(request)
    || (current.settings.autoLevels !== (request.options.levels === 'auto'))) {
    return false;
  }
  const resolved = resolveRenderSettings(request.scene, request.options, request.additionalLevels);
  if (resolved.levels <= current.settings.levels) {
    return false;
  }

  const startedAt = performance.now();
  // The exact geometry from the render being continued is kept.
  const settings: RenderSettings = { ...resolved, recursionDepth: current.settings.recursionDepth };
  post({ type: 'start', settings });
  const outcome = current.result.continueTo(settings, frameCallbacks);
  const stepMilliseconds = performance.now() - startedAt;
  current.settings = settings;
  current.milliseconds += stepMilliseconds;
  post({
    type: 'done',
    levels: outcome.levels,
    milliseconds: current.milliseconds,
    stepMilliseconds,
    stepChange: outcome.stepChange,
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

  if (request.webglDisabled) {
    post({ type: 'error', message: request.webglDisabled });
    return;
  }
  const startedAt = performance.now();
  try {
    const settings = resolveRenderSettings(request.scene, request.options, request.additionalLevels);
    post({ type: 'start', settings });
    const result = renderWebgl(request.scene, settings, request.editMode, frameCallbacks);
    const { outcome } = result;
    const milliseconds = performance.now() - startedAt;
    session = {
      key: continuationKey(request),
      settings: { ...settings, levels: outcome.levels },
      result,
      milliseconds,
    };
    post({
      type: 'done',
      levels: outcome.levels,
      milliseconds,
      stepChange: outcome.stepChange,
      details: outcome.details,
    });
  } catch (error) {
    post({ type: 'error', message: errorMessage(error) });
  }
}

self.addEventListener('message', (event: MessageEvent<RenderRequest>) => {
  render(event.data);
});
