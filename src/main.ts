import './style.css';
import { createSceneEditor } from './editor';
import { createShareDialog, type LinkOptions } from './share-dialog';
import GUIDE_HTML from './guide.html?raw';
import {
  DEFAULT_EXAMPLE,
  EXAMPLES,
  findExample,
} from './examples';
import {
  EXTRA_LEVELS_STEP,
  GPU_LOST_MESSAGE,
  MAX_WEBGL_WORKING_PIXELS,
  MAXIMUM_LEVELS,
  MAXIMUM_RECURSION_CHOICE,
  QUALITY_LABELS,
  QUALITY_MODES,
  SUPERSAMPLING_CHOICES,
  canContinue,
  continuationKey,
  elementCorners,
  scenePointToCanvas,
  type QualityMode,
  type QualityOptions,
  type RenderMessage,
  type RenderOptions,
  type RenderRequest,
  type RenderSettings,
  type StepChange,
} from './render/common';
import {
  clamp,
  parseScene,
  reframeZoom,
  viewFrame,
  withResolution,
  type InputValue,
  type InputValues,
  type ResolvedSceneDefinition,
  type SceneDefinition,
  type SceneInput,
  type Vec2,
  type ZoomElement,
} from './scene';

type DefinitionLocation =
  | { kind: 'example'; id: string }
  | { kind: 'source'; url: string }
  | { kind: 'shared'; code: string }
  | { kind: 'custom' };

const DEFAULT_SCENE_TEXT = DEFAULT_EXAMPLE.text;
const REMOTE_DEFINITION_TIMEOUT_MS = 10_000;
const REMOTE_DEFINITION_MAX_BYTES = 512 * 1024;
const EDIT_MODE_OUTLINE_CSS_PIXELS = 1.5;
const WALL_LABEL_GAP_PX = 24;

function selectRow<T extends string | number>(
  className: string,
  label: string,
  choices: [T, string][],
  onChange: (value: T) => void,
) {
  const row = document.createElement('label');
  row.className = `select-row ${className}`;
  row.innerHTML = `<span>${label}</span>`;
  const select = document.createElement('select');
  select.name = className.replace(/-row$/, '');
  for (const [value, text] of choices) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = text;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(choices[select.selectedIndex][0]));
  row.append(select);
  const setValue = (value: T) => {
    select.selectedIndex = choices.findIndex(([choice]) => choice === value);
  };
  return { row, select, setValue };
}

function normalizeRemoteDefinitionUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Source must be a valid HTTP or HTTPS URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Source must use HTTP or HTTPS');
  }

  if (url.hostname === 'github.com') {
    const segments = url.pathname.split('/').filter(Boolean);
    const blobIndex = segments.indexOf('blob');
    if (blobIndex === 2 && segments.length > 4) {
      url = new URL(`https://raw.githubusercontent.com/${[
        segments[0],
        segments[1],
        segments[3],
        ...segments.slice(4),
      ].join('/')}`);
    }
  }

  return url;
}

async function fetchRemoteDefinition(source: string): Promise<string> {
  const url = normalizeRemoteDefinitionUrl(source);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REMOTE_DEFINITION_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Could not load source: HTTP ${response.status}`);
    }

    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > REMOTE_DEFINITION_MAX_BYTES) {
      throw new Error('Remote definition is larger than 512 KiB');
    }

    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > REMOTE_DEFINITION_MAX_BYTES) {
      throw new Error('Remote definition is larger than 512 KiB');
    }
    return text;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Remote definition request timed out');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

// Shared links put their code in the fragment, or in `q` in the query.
function definitionLocationFromUrl(): DefinitionLocation {
  const parameters = new URLSearchParams(window.location.search);
  const example = parameters.get('example');
  const source = parameters.get('source');
  const fragment = window.location.hash.slice(1);
  const shared = [parameters.get('q'), fragment === '' ? null : fragment]
    .filter((code) => code !== null);

  if ([example, source].filter(Boolean).length + shared.length > 1) {
    throw new Error('Use only one of "example", "source", "q" or a shared link fragment');
  }
  if (example) {
    return { kind: 'example', id: example };
  }
  if (source) {
    return { kind: 'source', url: source };
  }
  if (shared.length > 0) {
    return { kind: 'shared', code: shared[0] };
  }
  return { kind: 'example', id: DEFAULT_EXAMPLE.id };
}

function updateDefinitionUrl(location: DefinitionLocation) {
  const url = new URL(window.location.href);
  url.searchParams.delete('example');
  url.searchParams.delete('source');
  url.searchParams.delete('q');
  url.hash = '';

  if (location.kind === 'example') {
    url.searchParams.set('example', location.id);
  } else if (location.kind === 'source') {
    url.searchParams.set('source', location.url);
  } else if (location.kind === 'shared') {
    url.hash = location.code;
  }

  window.history.replaceState(null, '', url);
}

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App root not found');
}

// The built app caches itself to work offline; development is always live.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .catch((error: unknown) => console.warn('Offline support unavailable', error));
}

const shell = document.createElement('div');
shell.className = 'app-shell';

// Phone browsers tint their toolbars to match the wall.
const themeColour = document.querySelector('meta[name="theme-color"]');

const panel = document.createElement('aside');
panel.className = 'sidebar';
panel.id = 'panel';
panel.setAttribute('aria-label', 'Settings');

const panelResizeHandle = document.createElement('div');
panelResizeHandle.className = 'panel-resize-handle';
panelResizeHandle.setAttribute('role', 'separator');
panelResizeHandle.setAttribute('aria-label', 'Resize panel');
panelResizeHandle.setAttribute('aria-orientation', 'vertical');

const panelToggle = document.createElement('button');
panelToggle.className = 'panel-toggle';
panelToggle.type = 'button';
panelToggle.setAttribute('aria-label', 'Settings panel');
panelToggle.setAttribute('aria-controls', panel.id);
panelToggle.setAttribute('aria-expanded', 'true');

const panelToggleIcon = document.createElement('span');
panelToggleIcon.className = 'panel-toggle-icon';
panelToggle.append(panelToggleIcon);

const canvasHost = document.createElement('div');
canvasHost.className = 'canvas-host';

const canvasFrame = document.createElement('div');
canvasFrame.className = 'canvas-frame';

const canvas = document.createElement('canvas');
canvas.tabIndex = 0;
canvas.setAttribute('role', 'img');
const displayContext = canvas.getContext('2d')!;

// A gallery-style label beside the framed picture, centred with it as a group.
// Controls for the definition's inputs sit on a matching card next to it.
const wallLabel = document.createElement('aside');
wallLabel.className = 'wall-label';
wallLabel.setAttribute('aria-label', 'Label');
const wallLabelShare = document.createElement('button');
wallLabelShare.type = 'button';
wallLabelShare.className = 'wall-label-share';
wallLabelShare.title = 'Share (S)';
wallLabelShare.setAttribute('aria-label', 'Share');
wallLabelShare.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
wallLabelShare.addEventListener('click', () => shareDialog.open());
const inputPanel = document.createElement('aside');
inputPanel.className = 'wall-label input-panel';
inputPanel.setAttribute('aria-label', 'Inputs');
const artworkSide = document.createElement('div');
artworkSide.className = 'artwork-side';
artworkSide.style.gap = `${WALL_LABEL_GAP_PX}px`;
const artwork = document.createElement('div');
artwork.className = 'artwork';
artwork.style.gap = `${WALL_LABEL_GAP_PX}px`;

canvasFrame.append(canvas);
artworkSide.append(inputPanel, wallLabel);
artwork.append(canvasFrame, artworkSide);
canvasHost.append(artwork);

let panelIsOpen = true;
let panelIsResizing = false;

function setPanelOpen(isOpen: boolean) {
  panelIsOpen = isOpen;
  panel.classList.toggle('collapsed', !isOpen);
  shell.classList.toggle('panel-collapsed', !isOpen);
  shell.classList.remove('panel-handle-visible');
  panelToggle.setAttribute('aria-expanded', String(isOpen));
}

panelToggle.addEventListener('click', () => {
  setPanelOpen(!panelIsOpen);
});

// A picture chosen in the address opens with the panel out of the way.
const urlChoosesPicture = ['example', 'source', 'q'].some((key) => new URLSearchParams(window.location.search).has(key))
  || window.location.hash.length > 1;
if (urlChoosesPicture) {
  setPanelOpen(false);
}

const PANEL_MIN_WIDTH = 240;
const PANEL_KEY_STEP = 16;
panelResizeHandle.tabIndex = 0;
panelResizeHandle.setAttribute('aria-valuemin', String(PANEL_MIN_WIDTH));

const panelMaxWidth = () => Math.max(PANEL_MIN_WIDTH, Math.min(560, window.innerWidth * 0.6));

function setPanelWidth(width: number) {
  const clamped = Math.round(clamp(width, PANEL_MIN_WIDTH, panelMaxWidth()));
  shell.style.setProperty('--panel-width', `${clamped}px`);
  panelResizeHandle.setAttribute('aria-valuenow', String(clamped));
}

panelResizeHandle.addEventListener('pointerdown', (event) => {
  panelIsResizing = true;
  panelResizeHandle.setPointerCapture(event.pointerId);
  shell.classList.add('panel-resizing');
});

panelResizeHandle.addEventListener('pointermove', (event) => {
  if (!panelIsResizing) {
    return;
  }

  setPanelWidth(window.innerWidth - event.clientX);
});

// The panel sits on the right, so Left widens it and Right narrows it.
panelResizeHandle.addEventListener('keydown', (event) => {
  const width = panel.getBoundingClientRect().width;
  const next = {
    ArrowLeft: width + PANEL_KEY_STEP,
    ArrowRight: width - PANEL_KEY_STEP,
    Home: PANEL_MIN_WIDTH,
    End: panelMaxWidth(),
  }[event.key];
  if (next !== undefined) {
    event.preventDefault();
    setPanelWidth(next);
  }
});

panelResizeHandle.addEventListener('focus', () => {
  panelResizeHandle.setAttribute('aria-valuemax', String(Math.round(panelMaxWidth())));
  panelResizeHandle.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
});

panelResizeHandle.addEventListener('pointerup', (event) => {
  panelIsResizing = false;
  panelResizeHandle.releasePointerCapture(event.pointerId);
  shell.classList.remove('panel-resizing');
});

window.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'mouse') {
    return;
  }
  if (panelIsOpen) {
    shell.classList.remove('panel-handle-visible');
    return;
  }

  const nearTopRight = event.clientX > window.innerWidth - 72 && event.clientY < 72;
  shell.classList.toggle('panel-handle-visible', nearTopRight);
});

// Touch screens cannot hover, so tapping the bare wall reveals or hides the
// toggle, which fades again if left unused. Tapping the picture shows it alone,
// filling the screen, and another tap anywhere brings the wall back.
const TOGGLE_REVEAL_MS = 3000;
let toggleHideTimer: number | undefined;
let pictureOnly = false;

// Alone, the picture can be pinched to zoom and dragged to pan, so details
// are visible on small screens. A tap without a gesture still exits.
type PictureZoom = { scale: number; x: number; y: number };
const IDENTITY_ZOOM: PictureZoom = { scale: 1, x: 0, y: 0 };
const MAXIMUM_PICTURE_ZOOM = 8;
const TAP_SLOP_PX = 8;
let pictureZoom = IDENTITY_ZOOM;
let pictureGestured = false;
const picturePointers = new Map<number, Vec2>();
let pictureGesture: { zoom: PictureZoom; origin: Vec2; centre: Vec2; spread: number } | null = null;

const midpoint = (points: Vec2[]): Vec2 => ({
  x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
});
const spread = (points: Vec2[]) =>
  points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);

function setPictureZoom(zoom: PictureZoom) {
  pictureZoom = zoom;
  canvasFrame.style.transform = zoom.scale === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}

// The untransformed top-left corner of the frame, in client pixels.
function frameOrigin(): Vec2 {
  const rect = canvasFrame.getBoundingClientRect();
  return { x: rect.left - pictureZoom.x, y: rect.top - pictureZoom.y };
}

// The picture always covers the area it fills unzoomed (within the screen).
// Zooming in about a point on it only grows it past that area, so the point
// stays put; zooming out and panning are held to it.
function clampPictureZoom(zoom: PictureZoom, origin: Vec2): PictureZoom {
  if (zoom.scale <= 1) {
    return IDENTITY_ZOOM;
  }
  const host = canvasHost.getBoundingClientRect();
  const axis = (offset: number, start: number, size: number, hostStart: number, hostSize: number) => {
    const from = Math.max(start, hostStart);
    const to = Math.min(start + size, hostStart + hostSize);
    return clamp(offset, to - start - size * zoom.scale, from - start);
  };
  return {
    scale: zoom.scale,
    x: axis(zoom.x, origin.x, canvasFrame.offsetWidth, host.left, host.width),
    y: axis(zoom.y, origin.y, canvasFrame.offsetHeight, host.top, host.height),
  };
}

function startPictureGesture() {
  const points = [...picturePointers.values()];
  pictureGesture = points.length === 0
    ? null
    : { zoom: pictureZoom, origin: frameOrigin(), centre: midpoint(points), spread: spread(points) };
}

canvasHost.addEventListener('pointerdown', (event) => {
  if (!pictureOnly || event.pointerType === 'mouse') {
    return;
  }
  if (picturePointers.size === 0) {
    pictureGestured = false;
  }
  picturePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  canvasHost.setPointerCapture(event.pointerId);
  startPictureGesture();
});

canvasHost.addEventListener('pointermove', (event) => {
  if (!pictureGesture || !picturePointers.has(event.pointerId)) {
    return;
  }
  picturePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const points = [...picturePointers.values()];
  const centre = midpoint(points);
  const { zoom, origin } = pictureGesture;
  const moved = Math.hypot(centre.x - pictureGesture.centre.x, centre.y - pictureGesture.centre.y);
  pictureGestured ||= points.length > 1 || moved > TAP_SLOP_PX;
  if (!pictureGestured) {
    return;
  }
  const scale = pictureGesture.spread > 0
    ? clamp(zoom.scale * spread(points) / pictureGesture.spread, 1, MAXIMUM_PICTURE_ZOOM)
    : zoom.scale;
  // The picture point that started under the fingers stays under them.
  const ratio = scale / zoom.scale;
  setPictureZoom(clampPictureZoom({
    scale,
    x: centre.x - origin.x - (pictureGesture.centre.x - origin.x - zoom.x) * ratio,
    y: centre.y - origin.y - (pictureGesture.centre.y - origin.y - zoom.y) * ratio,
  }, origin));
});

const endPicturePointer = (event: PointerEvent) => {
  if (picturePointers.delete(event.pointerId)) {
    startPictureGesture();
  }
};
canvasHost.addEventListener('pointerup', endPicturePointer);
canvasHost.addEventListener('pointercancel', endPicturePointer);

// Scrolling down zooms in and up zooms out, about the mouse.
const WHEEL_ZOOM_PER_PIXEL = 0.002;
canvasHost.addEventListener('wheel', (event) => {
  if (!pictureOnly) {
    return;
  }
  event.preventDefault();
  const pixels = event.deltaY * (
    event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvasHost.clientHeight
        : 1);
  const scale = clamp(pictureZoom.scale * Math.exp(pixels * WHEEL_ZOOM_PER_PIXEL), 1, MAXIMUM_PICTURE_ZOOM);
  const origin = frameOrigin();
  const ratio = scale / pictureZoom.scale;
  setPictureZoom(clampPictureZoom({
    scale,
    x: event.clientX - origin.x - (event.clientX - origin.x - pictureZoom.x) * ratio,
    y: event.clientY - origin.y - (event.clientY - origin.y - pictureZoom.y) * ratio,
  }, origin));
}, { passive: false });

let panelBeforePicture = false;
// Chrome reports fullscreen a frame or two before the window resizes, so the
// layout waits for the resize itself and then changes once, before the browser
// paints the resized window.
let layoutHeld = false;

function windowResized(width: number, height: number) {
  return new Promise<void>((resolve) => {
    if (window.innerWidth !== width || window.innerHeight !== height) {
      resolve();
      return;
    }
    // A window that is already screen-sized never resizes.
    const done = () => {
      window.clearTimeout(cap);
      window.removeEventListener('resize', done);
      resolve();
    };
    const cap = window.setTimeout(done, 500);
    window.addEventListener('resize', done);
  });
}

function setPictureOnly(on: boolean) {
  if (on === pictureOnly) {
    return;
  }
  pictureOnly = on;
  setPictureZoom(IDENTITY_ZOOM);
  if (on) {
    panelBeforePicture = panelIsOpen;
    setPanelOpen(false);
  }
  shell.classList.remove('panel-handle-visible');
  const apply = () => {
    layoutHeld = false;
    shell.classList.toggle('picture-only', pictureOnly);
    if (!pictureOnly && panelBeforePicture) {
      setPanelOpen(true);
    }
    if (!resizeCanvas()) {
      drawDisplay();
    }
    renderAfterResize();
  };
  // Fullscreen is a bonus; without it the picture still fills the window.
  const fullscreen = on && !document.fullscreenElement
    ? shell.requestFullscreen?.()
    : !on && document.fullscreenElement ? document.exitFullscreen() : undefined;
  if (!fullscreen) {
    apply();
    return;
  }
  layoutHeld = true;
  const { innerWidth, innerHeight } = window;
  void fullscreen.then(() => windowResized(innerWidth, innerHeight), () => undefined).then(apply);
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && pictureOnly) {
    setPictureOnly(false);
  }
});

canvasHost.addEventListener('click', (event) => {
  if (pictureOnly) {
    if (!pictureGestured) {
      setPictureOnly(false);
    }
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const byMouse = event instanceof PointerEvent && event.pointerType === 'mouse';
  if (target?.closest('canvas') && !state.scene.inputs.some(isPointInput)) {
    setPictureOnly(true);
  } else if (panelIsOpen) {
    return;
  } else if (!byMouse && !target?.closest('.canvas-frame, .wall-label')) {
    window.clearTimeout(toggleHideTimer);
    const visible = shell.classList.toggle('panel-handle-visible');
    if (visible) {
      toggleHideTimer = window.setTimeout(() => shell.classList.remove('panel-handle-visible'), TOGGLE_REVEAL_MS);
    }
  }
});

const panelHeader = document.createElement('div');
panelHeader.className = 'panel-header';
panelHeader.innerHTML = '<h1>ZoomFract</h1>';

const controls = document.createElement('div');
controls.className = 'controls';

// The slider's rightmost position selects automatic levels.
const AUTO_LEVELS_POSITION = MAXIMUM_LEVELS + 1;

const renderOptions = (): QualityOptions =>
  state.quality === 'custom' ? customOptions() : QUALITY_MODES[state.quality];

// Custom starts from the first mode it is opened from, then keeps its own values.
const customOptions = (): QualityOptions => {
  const source = state.quality === 'custom' ? QUALITY_MODES.high : QUALITY_MODES[state.quality];
  state.custom ??= {
    ...source,
    resolution: { mode: 'fixed', height: Math.max(1, canvas.height) },
  };
  return state.custom;
};

const updateCustomOptions = (update: Partial<QualityOptions>) => {
  state.custom = { ...customOptions(), ...update };
  syncQualityControls();
  render();
};

const updateCustomResolution = (width: number | undefined, height: number | undefined) => {
  state.custom = { ...customOptions(), resolution: { mode: 'fixed', width, height } };
  syncQualityControls();
  render();
};

const qualityControl = selectRow<QualityMode>(
  'quality-row',
  'Render quality',
  Object.entries(QUALITY_LABELS) as [QualityMode, string][],
  (quality) => {
    if (quality === 'custom') {
      customOptions();
      customSettings.open = true;
    }
    state.quality = quality;
    syncQualityControls();
    render();
  },
);
qualityControl.select.className = 'quality-select';
qualityControl.select.setAttribute('aria-label', 'Render quality');

const supersamplingControl = selectRow<number>(
  'supersampling-row',
  'Supersampling',
  SUPERSAMPLING_CHOICES.map((factor) => [factor, `${factor}×`]),
  (supersampling) => updateCustomOptions({ supersampling }),
);
supersamplingControl.row.title = 'Draws the image this many times larger in each direction, then shrinks it '
  + 'down. Higher values give smoother edges and finer detail, but take longer.';

const recursionControl = selectRow<number>(
  'recursion-row',
  'Max recursion',
  Array.from({ length: MAXIMUM_RECURSION_CHOICE + 1 }, (_, depth): [number, string] => [depth, String(depth)]),
  (recursionDepth) => updateCustomOptions({ recursionDepth }),
);
recursionControl.row.title = 'How many levels of zooms are drawn precisely as shapes. Deeper levels reuse '
  + 'an earlier picture, which is faster but slightly blurrier. Higher values are sharper but slower.';

function resolutionInput(label: string) {
  const row = document.createElement('label');
  row.className = 'select-row resolution-row';
  const caption = document.createElement('span');
  caption.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.name = label.toLowerCase();
  input.min = '1';
  input.step = '1';
  input.inputMode = 'numeric';
  row.append(caption, input);
  return { row, input };
}

const widthControl = resolutionInput('Width');
const heightControl = resolutionInput('Height');
widthControl.row.title = 'Output width in pixels. Leave blank to infer it from height and the scene aspect.';
heightControl.row.title = 'Output height in pixels. Leave blank to infer it from width and the scene aspect.';
const updateResolutionInput = (changed: 'width' | 'height') => {
  const input = changed === 'width' ? widthControl.input : heightControl.input;
  const other = changed === 'width' ? heightControl.input : widthControl.input;
  const value = input.valueAsNumber;
  if (!Number.isFinite(value) || value < 1) {
    input.value = '';
    return;
  }
  other.value = '';
  updateCustomResolution(changed === 'width' ? Math.round(value) : undefined, changed === 'height' ? Math.round(value) : undefined);
};
widthControl.input.addEventListener('change', () => updateResolutionInput('width'));
heightControl.input.addEventListener('change', () => updateResolutionInput('height'));

const levelsRow = document.createElement('label');
levelsRow.className = 'levels-row';
levelsRow.title = 'How many times the picture repeats inside itself. More levels add finer detail. '
  + 'Auto (far right) keeps going until extra levels would be too small to see.';
levelsRow.innerHTML = '<span>Levels</span>';
const levelsSlider = document.createElement('input');
levelsSlider.type = 'range';
levelsSlider.name = 'levels';
levelsSlider.min = '1';
levelsSlider.max = String(AUTO_LEVELS_POSITION);
levelsSlider.step = '1';
const levelsValue = document.createElement('span');
levelsValue.className = 'value';
const addLevelButton = document.createElement('button');
addLevelButton.type = 'button';
addLevelButton.className = 'add-level';
addLevelButton.textContent = '+1';
addLevelButton.title = 'Render one more level, continuing from the current image';
levelsRow.append(levelsSlider, levelsValue, addLevelButton);
levelsSlider.addEventListener('input', () => updateCustomOptions({
  levels: levelsSlider.valueAsNumber === AUTO_LEVELS_POSITION ? 'auto' : levelsSlider.valueAsNumber,
}));
addLevelButton.addEventListener('click', () => {
  const { levels } = customOptions();
  if (typeof levels === 'number' && levels < MAXIMUM_LEVELS) {
    updateCustomOptions({ levels: levels + 1 });
  }
});

const customSettings = document.createElement('details');
customSettings.className = 'render-settings';
const customSettingsSummary = document.createElement('summary');
const renderSettingsLabel = document.createElement('span');
renderSettingsLabel.textContent = 'Render quality';
const levelLimitWarning = document.createElement('span');
levelLimitWarning.className = 'level-limit-warning';
levelLimitWarning.innerHTML = '&#9888;';
levelLimitWarning.setAttribute('role', 'img');
levelLimitWarning.setAttribute('aria-label', 'Automatic level limit reached; more detail may be visible');
levelLimitWarning.title = 'Automatic level limit reached; more detail may be visible';
levelLimitWarning.hidden = true;
const textureLimitWarning = document.createElement('span');
textureLimitWarning.className = 'level-limit-warning texture-limit-warning';
textureLimitWarning.innerHTML = '&#9888;';
textureLimitWarning.setAttribute('role', 'img');
textureLimitWarning.hidden = true;
const extendLevelsButton = document.createElement('button');
extendLevelsButton.type = 'button';
extendLevelsButton.className = 'add-level extend-levels';
extendLevelsButton.textContent = `+${EXTRA_LEVELS_STEP} levels`;
extendLevelsButton.title = 'Continue the current image with more iterations';
extendLevelsButton.hidden = true;
extendLevelsButton.addEventListener('click', () => {
  if (!activeRequest && renderOptions().levels === 'auto' && state.resolvedLevels !== null) {
    extraAutoLevels += EXTRA_LEVELS_STEP;
    render();
  }
});
customSettingsSummary.append(renderSettingsLabel);
// Controls inside a summary are not allowed, so these sit beside its row instead.
const renderSettingsActions = document.createElement('div');
renderSettingsActions.className = 'render-settings-actions';
renderSettingsActions.append(levelLimitWarning, textureLimitWarning, extendLevelsButton, qualityControl.select);
const renderSettingsGroup = document.createElement('div');
renderSettingsGroup.className = 'render-settings-group';
const customSettingsBody = document.createElement('div');
customSettingsBody.className = 'render-settings-body';
const qualityDetails = document.createElement('div');
qualityDetails.className = 'quality-details';

// The auto-stop note goes last, highlighted, because it is the only part
// asking for a decision rather than reporting what happened.
function setQualityDetails(parts: string[], note: string | null) {
  qualityDetails.textContent = parts.join(' · ');
  if (note === null) {
    return;
  }
  const highlight = document.createElement('span');
  highlight.className = 'details-note';
  highlight.textContent = note;
  qualityDetails.append(' · ', highlight);
}
customSettingsBody.append(
  widthControl.row,
  heightControl.row,
  supersamplingControl.row,
  recursionControl.row,
  levelsRow,
  qualityDetails,
);
customSettings.append(customSettingsSummary, customSettingsBody);
renderSettingsGroup.append(renderSettingsActions, customSettings);

// The collapsed settings header shows what the latest render actually used.
const setSettingsTitle = (text: string) => {
  customSettingsSummary.title = text;
  qualityControl.select.title = text;
};

// Presets show their fixed settings read-only.
function syncQualityControls() {
  qualityControl.setValue(state.quality);
  const isCustom = state.quality === 'custom';
  const options = renderOptions();
  const isAuto = options.levels === 'auto';
  supersamplingControl.setValue(options.supersampling);
  recursionControl.setValue(options.recursionDepth);
  const resolution = isCustom
    ? outputResolution(state.scene, { width: canvas.width, height: canvas.height }, options)
    : null;
  widthControl.input.value = String(resolution?.requestedWidth ?? canvas.width);
  heightControl.input.value = String(resolution?.requestedHeight ?? canvas.height);
  const inferredWidth = isCustom && options.resolution.mode === 'fixed' && options.resolution.width === undefined;
  const inferredHeight = isCustom && options.resolution.mode === 'fixed' && options.resolution.height === undefined;
  widthControl.input.classList.toggle('inferred', inferredWidth);
  heightControl.input.classList.toggle('inferred', inferredHeight);
  widthControl.input.title = inferredWidth ? 'Calculated from height and the scene aspect' : 'Output width in pixels';
  heightControl.input.title = inferredHeight ? 'Calculated from width and the scene aspect' : 'Output height in pixels';
  levelsSlider.value = String(options.levels === 'auto' ? AUTO_LEVELS_POSITION : options.levels);
  levelsValue.textContent = isAuto
    ? `Auto${state.resolvedLevels === null ? '' : ` (${state.resolvedLevels})`}`
    : String(options.levels);
  for (const control of [
    widthControl.input,
    heightControl.input,
    supersamplingControl.select,
    recursionControl.select,
    levelsSlider,
  ]) {
    control.disabled = !isCustom;
  }
  addLevelButton.disabled = !isCustom || options.levels === 'auto' || options.levels >= MAXIMUM_LEVELS;
  customSettingsBody.classList.toggle('read-only', !isCustom);
}

const editModeRow = document.createElement('label');
editModeRow.className = 'edit-mode-row';
editModeRow.innerHTML = '<span>Edit mode</span>';

const editModeToggle = document.createElement('input');
editModeToggle.type = 'checkbox';
editModeToggle.name = 'edit-mode';
editModeRow.append(editModeToggle);

editModeToggle.addEventListener('change', () => {
  state.editMode = editModeToggle.checked;
  render();
});

const exampleRow = document.createElement('label');
exampleRow.className = 'example-row';
exampleRow.innerHTML = '<span>Example</span>';

const exampleSelect = document.createElement('select');
exampleSelect.name = 'example';
const customExampleOption = document.createElement('option');
customExampleOption.value = '';
customExampleOption.textContent = 'Custom';
exampleSelect.append(customExampleOption);
for (const example of EXAMPLES) {
  const option = document.createElement('option');
  option.value = example.id;
  option.textContent = example.label;
  exampleSelect.append(option);
}
exampleSelect.value = DEFAULT_EXAMPLE.id;
exampleRow.append(exampleSelect);

const renderProgress = document.createElement('div');
renderProgress.className = 'render-progress';
renderProgress.hidden = true;
renderProgress.setAttribute('role', 'progressbar');
renderProgress.setAttribute('aria-label', 'Rendering scene');
renderProgress.setAttribute('aria-valuemin', '0');
renderProgress.setAttribute('aria-valuemax', '100');

const renderProgressBar = document.createElement('div');
renderProgressBar.className = 'render-progress-bar';
renderProgress.append(renderProgressBar);

const sceneInputLabel = document.createElement('label');
sceneInputLabel.className = 'scene-label';
sceneInputLabel.textContent = 'Scene definition';

const guideButton = document.createElement('button');
guideButton.type = 'button';
guideButton.className = 'guide-button';
guideButton.textContent = 'Guide';
guideButton.title = 'How to write a scene definition';
guideButton.setAttribute('aria-expanded', 'false');

const sceneLabelRow = document.createElement('div');
sceneLabelRow.className = 'scene-label-row';
sceneLabelRow.append(sceneInputLabel, guideButton);

const guide = document.createElement('aside');
guide.className = 'guide';
guide.hidden = true;
guide.setAttribute('aria-label', 'Definition guide');

const guideHeader = document.createElement('div');
guideHeader.className = 'guide-header';
const guideTitle = document.createElement('h2');
guideTitle.textContent = 'Definition guide';
const guideClose = document.createElement('button');
guideClose.type = 'button';
guideClose.className = 'guide-close';
guideClose.setAttribute('aria-label', 'Close guide');
guideClose.textContent = '\u00d7';
guideHeader.append(guideTitle, guideClose);

const guideBody = document.createElement('div');
guideBody.className = 'guide-body';
guideBody.innerHTML = GUIDE_HTML;
guide.append(guideHeader, guideBody);

const setGuideOpen = (open: boolean) => {
  guide.hidden = !open;
  guideButton.setAttribute('aria-expanded', String(open));
};
guideButton.addEventListener('click', () => setGuideOpen(guide.hidden));
guideClose.addEventListener('click', () => setGuideOpen(false));
guide.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setGuideOpen(false);
    guideButton.focus();
  }
});
// Contents links scroll within the guide instead of changing the page URL.
guideBody.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
  if (link) {
    event.preventDefault();
    const target = guideBody.querySelector(link.getAttribute('href')!);
    if (target) {
      const top = target.getBoundingClientRect().top - guideBody.getBoundingClientRect().top + guideBody.scrollTop;
      guideBody.scrollTo({ top, behavior: 'smooth' });
    }
  }
});

const sceneEditor = createSceneEditor(DEFAULT_SCENE_TEXT, () => {
  exampleSelect.value = '';
});
// Input values from an invalid shared definition wait here until its text is
// repaired. The visible controls continue to belong to the last valid scene.
let pendingEditorInputValues: InputValues | null = null;

const wrapRow = document.createElement('label');
wrapRow.className = 'edit-mode-row';
wrapRow.innerHTML = '<span>Wrap lines</span>';

const wrapToggle = document.createElement('input');
wrapToggle.type = 'checkbox';
wrapToggle.name = 'wrap-lines';
wrapToggle.checked = true;
wrapRow.append(wrapToggle);
wrapToggle.addEventListener('change', () => {
  sceneEditor.setWrap(wrapToggle.checked);
});

const applySceneButton = document.createElement('button');
applySceneButton.type = 'button';
applySceneButton.className = 'apply-scene';
applySceneButton.textContent = 'Apply scene';

const sceneStatus = document.createElement('div');
sceneStatus.className = 'scene-status';
sceneStatus.setAttribute('role', 'status');

applySceneButton.addEventListener('click', () => {
  definitionLoadRevision += 1;
  applyDefinition(
    sceneEditor.text(),
    { kind: 'custom' },
    true,
    pendingEditorInputValues ?? state.inputValues,
    false,
    true,
  );
});

const labelRow = document.createElement('label');
labelRow.className = 'edit-mode-row';
labelRow.innerHTML = '<span>Show label</span>';

const labelToggle = document.createElement('input');
labelToggle.type = 'checkbox';
labelToggle.name = 'show-label';
labelToggle.checked = true;
labelRow.append(labelToggle);
labelToggle.addEventListener('change', () => {
  updateWallLabel();
  render();
});

const shareButton = document.createElement('button');
shareButton.type = 'button';
shareButton.className = 'apply-scene share-button';
shareButton.textContent = 'Share';

// The link holds the applied definition, with the current input values and
// app settings when they are chosen.
async function shareLink({ inputs, settings }: LinkOptions): Promise<string> {
  const { encodeSharedDefinition } = await import('./share');
  const url = new URL(window.location.pathname, window.location.origin);
  url.hash = encodeSharedDefinition({
    text: state.definitionText,
    inputs: inputs ? state.inputValues : new Map(),
    settings: settings ? { quality: state.quality, custom: state.custom, label: labelToggle.checked } : null,
  });
  return url.href;
}

// A definition dropped on the window or opened from the Share dialog
// replaces the current one, as if it had been typed in and applied.
function loadDefinitionFile(text: string): boolean {
  definitionLoadRevision += 1;
  return applyDefinition(text, { kind: 'custom' }, true);
}

const shareDialog = createShareDialog({
  canvas,
  scene: () => state.scene,
  fileName: () => state.definitionLocation.kind === 'example' ? state.definitionLocation.id : 'custom',
  hasInputs: () => state.scene.inputs.length > 0,
  hasUnappliedEdits: () => sceneEditor.text().trim() !== state.definitionText.trim(),
  link: shareLink,
  definition: () => state.definitionText,
  loadDefinition: loadDefinitionFile,
});
shareButton.addEventListener('click', () => shareDialog.open());

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

document.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) {
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
  shell.classList.add('dropping');
});
// Leaving for a child element reports a target; leaving the window does not.
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) {
    shell.classList.remove('dropping');
  }
});
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) {
    return;
  }
  event.preventDefault();
  shell.classList.remove('dropping');
  const file = event.dataTransfer?.files[0];
  if (file) {
    void file.text()
      .then((text) => {
        if (loadDefinitionFile(text)) {
          shareDialog.close();
        }
      })
      .catch(() => showSceneStatus(`Could not read ${file.name}`, true));
  }
});

exampleSelect.addEventListener('change', () => {
  const example = findExample(exampleSelect.value);
  if (!example) {
    return;
  }
  void loadDefinitionLocation({ kind: 'example', id: example.id }, true);
});

const toggleCheckbox = (checkbox: HTMLInputElement) => {
  checkbox.checked = !checkbox.checked;
  checkbox.dispatchEvent(new Event('change'));
};

const setQuality = (quality: QualityMode) => {
  qualityControl.select.value = quality;
  qualityControl.select.dispatchEvent(new Event('change'));
};

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || target.closest('input, textarea, select, .cm-editor') !== null);

// Single keys act only when nothing is being typed; Ctrl combinations work
// everywhere, including the editor, so they are caught before it sees them.
const LETTER_SHORTCUTS: Record<string, () => void> = {
  f: () => setPictureOnly(!pictureOnly),
  p: () => setPanelOpen(!panelIsOpen),
  s: () => shareDialog.open(),
  '?': () => {
    setPanelOpen(true);
    setGuideOpen(guide.hidden);
  },
  l: () => toggleCheckbox(labelToggle),
  e: () => toggleCheckbox(editModeToggle),
  '+': () => setQuality('high'),
  '=': () => setQuality('high'),
  '-': () => setQuality('fast'),
};

window.addEventListener('keydown', (event) => {
  if (shareDialog.element.open || event.altKey) {
    return;
  }
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === 'enter') {
      applySceneButton.click();
    } else if (key === 's') {
      shareDialog.downloadDefinition();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (key === 'escape') {
    if (pictureOnly) {
      setPictureOnly(false);
    } else if (!guide.hidden && panelIsOpen) {
      setGuideOpen(false);
    } else if (panelIsOpen && !isTyping(event.target)) {
      setPanelOpen(false);
    } else {
      return;
    }
    event.preventDefault();
    return;
  }
  if (key === 'enter' && event.target === canvas) {
    setPictureOnly(!pictureOnly);
    event.preventDefault();
    return;
  }
  const action = LETTER_SHORTCUTS[key];
  if (action && !isTyping(event.target)) {
    action();
    event.preventDefault();
  }
}, { capture: true });

controls.append(
  renderSettingsGroup,
  exampleRow,
  sceneLabelRow,
  sceneEditor.element,
  wrapRow,
  editModeRow,
  labelRow,
  applySceneButton,
  shareButton,
  sceneStatus,
);
panel.append(panelHeader, controls, panelResizeHandle);
shell.append(panel, panelToggle, guide, canvasHost, renderProgress, shareDialog.element);
app.append(shell);

const baseScene = parseScene(DEFAULT_SCENE_TEXT);
const state = {
  quality: 'display' as QualityMode,
  custom: null as QualityOptions | null,
  resolvedLevels: null as number | null,
  editMode: false,
  offsetX: 0,
  offsetY: -10,
  scene: baseScene,
  definitionText: DEFAULT_SCENE_TEXT,
  // Values set with the input controls, replacing those in the definition.
  inputValues: new Map<string, InputValue>() as ReadonlyMap<string, InputValue>,
  rendered: null as { levels: number } | null,
  definitionLocation: { kind: 'example', id: DEFAULT_EXAMPLE.id } as DefinitionLocation,
};
let definitionLoadRevision = 0;
syncQualityControls();

function showSceneStatus(message: string, isError = false) {
  sceneStatus.textContent = message;
  sceneStatus.classList.toggle('error', isError);
  // The panel starts hidden for preloaded pictures, so reveal problems.
  if (isError) {
    setPanelOpen(true);
  }
}

// Input values are kept when the edited definition is applied, as long as it
// still has a matching input, but reset when another definition is loaded
// unless it comes with its own, as shared links do.
function applyDefinition(
  text: string,
  location: DefinitionLocation,
  updateUrl: boolean,
  inputValues: InputValues = new Map(),
  keepInvalidText = false,
  // Applying an edit keeps showing the old picture until the new one
  // renders, unless its shape changed; other definitions start blank.
  keepPicture = false,
): boolean {
  try {
    const nextScene = parseScene(text, inputValues);
    // Info only changes the label, so the current picture can stay.
    const pictureChanged = JSON.stringify({ ...state.scene, info: null }) !== JSON.stringify({ ...nextScene, info: null });
    if (pictureChanged && (!keepPicture || outputAspect(nextScene) !== outputAspect(state.scene))) {
      clearDisplay();
    }
    state.scene = nextScene;
    state.definitionText = text;
    state.inputValues = new Map(nextScene.inputs.flatMap((input) => {
      const value = inputValues.get(input.name);
      return value !== undefined && typeof value === typeof input.value ? [[input.name, value]] : [];
    }));
    state.definitionLocation = location;
    pendingEditorInputValues = null;
    sceneEditor.setText(text.trim());

    exampleSelect.value = location.kind === 'example' ? findExample(location.id)?.id ?? '' : '';

    showSceneStatus('');
    if (updateUrl) {
      updateDefinitionUrl(location);
    }
    buildInputPanel();
    updateWallLabel();
    if (pictureChanged) {
      render();
    }
    return true;
  } catch (error) {
    if (keepInvalidText) {
      pendingEditorInputValues = inputValues;
      sceneEditor.setText(text.trim());
      exampleSelect.value = '';
      if (updateUrl) {
        updateDefinitionUrl(location);
      }
    }
    showSceneStatus(error instanceof Error ? error.message : 'Invalid scene definition', true);
    return false;
  }
}

async function loadDefinitionLocation(location: DefinitionLocation, updateUrl: boolean) {
  const revision = ++definitionLoadRevision;

  if (location.kind === 'example') {
    const example = findExample(location.id);
    if (!example) {
      showSceneStatus(`Unknown example: ${location.id}`, true);
      return;
    }
    if (revision !== definitionLoadRevision) {
      return;
    }
    applyDefinition(example.text, location, updateUrl);
    return;
  }

  if (location.kind === 'source') {
    showSceneStatus('Loading remote definition...');
    try {
      const text = await fetchRemoteDefinition(location.url);
      if (revision !== definitionLoadRevision) {
        return;
      }
      applyDefinition(text, location, updateUrl, new Map(), true);
    } catch (error) {
      if (revision !== definitionLoadRevision) {
        return;
      }
      showSceneStatus(error instanceof Error ? error.message : 'Could not load source', true);
    }
    return;
  }

  if (location.kind === 'shared') {
    try {
      const { decodeSharedDefinition } = await import('./share');
      if (revision !== definitionLoadRevision) {
        return;
      }
      const { text, inputs, settings } = decodeSharedDefinition(location.code);
      const renderChanged = settings !== null && JSON.stringify([settings.quality, settings.custom])
        !== JSON.stringify([state.quality, state.quality === 'custom' ? state.custom : null]);
      if (settings) {
        state.quality = settings.quality;
        state.custom = settings.custom ?? state.custom;
        labelToggle.checked = settings.label;
        syncQualityControls();
      }
      if (applyDefinition(text, location, updateUrl, inputs, true) && renderChanged) {
        render();
      }
    } catch (error) {
      if (revision === definitionLoadRevision) {
        showSceneStatus(error instanceof Error ? error.message : 'Could not read shared link', true);
      }
    }
    return;
  }

  applyDefinition(sceneEditor.text(), location, updateUrl);
}

async function loadDefinitionFromAddressBar() {
  try {
    await loadDefinitionLocation(definitionLocationFromUrl(), false);
  } catch (error) {
    showSceneStatus(error instanceof Error ? error.message : 'Invalid definition location', true);
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The "medium" lines of the label: what the picture is made of and how it was
// rendered, like the materials line on a gallery label.
function describeMedium(scene: SceneDefinition, rendered: typeof state.rendered): string[] {
  const count = (kind: string) => scene.elements.filter((element) => element.kind === kind).length;
  const parts = [
    ...(count('rect') > 0 ? [plural(count('rect'), 'rectangle')] : []),
    ...(count('circle') > 0 ? [plural(count('circle'), 'circle')] : []),
    ...(count('polygon') > 0 ? [plural(count('polygon'), 'polygon')] : []),
    ...(count('zoom') > 0 ? [plural(count('zoom'), 'zoom')] : []),
    ...(scene.elements.some((element) => element.glow) ? ['glow'] : []),
    ...(scene.shading.mode === 'density' ? ['density shading'] : []),
  ];
  const { width, height } = canvas;
  return [
    ...(parts.length > 0 ? [parts.join(', ')] : []),
    `${width} × ${height} px`,
    ...(rendered ? [plural(rendered.levels, 'level')] : []),
  ];
}

function labelElement(tag: string, className: string, text: string) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

// Untitled Wikipedia links show the article name; others show the address.
function linkText(address: string) {
  const url = new URL(address);
  const article = url.hostname.endsWith('.wikipedia.org') && url.pathname.startsWith('/wiki/')
    ? decodeURIComponent(url.pathname.slice('/wiki/'.length)).replaceAll('_', ' ')
    : '';
  return article ? `Wikipedia \u203a ${article}` : address.replace(/^https?:\/\//, '');
}

function updateWallLabel() {
  const { info } = state.scene;
  const byline = [info.author, info.date].filter((text) => text !== undefined).join(', ');
  const links = document.createElement('ul');
  links.className = 'wall-label-links';
  links.append(...info.links.map((link) => {
    const item = document.createElement('li');
    const anchor = document.createElement('a');
    anchor.href = link.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link.title ?? linkText(link.url);
    item.append(anchor);
    return item;
  }));
  wallLabel.replaceChildren(
    ...(info.title ? [labelElement('h2', 'wall-label-title', info.title)] : []),
    ...(byline ? [labelElement('p', 'wall-label-byline', byline)] : []),
    labelElement('p', 'wall-label-medium', describeMedium(state.scene, state.rendered).join('\n')),
    ...(info.description ? [labelElement('p', 'wall-label-description', info.description)] : []),
    ...(info.links.length > 0 ? [links] : []),
    wallLabelShare,
  );
  const hasInfo = Boolean(info.title || info.author || info.date || info.description || info.links.length > 0);
  wallLabel.hidden = !labelToggle.checked || !hasInfo;
  canvas.setAttribute('aria-label', [info.title ?? 'ZoomFract picture', info.description].filter(Boolean).join('. '));
  return resizeCanvas();
}

const formatInputNumber = (value: number) => String(Number(value.toPrecision(4)));

const describeInputValue = (input: SceneInput) => input.type === 'slider'
  ? formatInputNumber(input.value)
  : `(${formatInputNumber(input.value.x)}, ${formatInputNumber(input.value.y)})`;

type PointInput = Extract<SceneInput, { type: 'click' | 'drag' }>;
const isPointInput = (input: SceneInput): input is PointInput => input.type !== 'slider';

const inputReadouts = new Map<string, HTMLOutputElement>();
const inputSliders = new Map<string, HTMLInputElement>();
const inputError = labelElement('p', 'input-error', '');
const inputReset = document.createElement('button');
inputReset.type = 'button';
inputReset.className = 'input-reset';
inputReset.textContent = 'Reset';
inputReset.addEventListener('click', () => {
  updateInputs(new Map(), true);
});

function buildInputPanel() {
  const { inputs } = state.scene;
  inputReadouts.clear();
  inputSliders.clear();
  const rows = inputs.map((input) => {
    const row = document.createElement('label');
    row.className = 'input-control';
    const readout = document.createElement('output');
    inputReadouts.set(input.name, readout);
    row.append(labelElement('span', 'input-name', input.label), readout);
    if (input.type === 'slider') {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.name = input.name;
      slider.min = String(input.min);
      slider.max = String(input.max);
      slider.step = input.step === undefined ? 'any' : String(input.step);
      slider.addEventListener('input', () => setInputValue(input.name, Number(slider.value), true));
      inputSliders.set(input.name, slider);
      row.append(slider);
    } else {
      row.append(labelElement('span', 'input-hint', input.type === 'drag' ? 'Drag on the picture' : 'Click the picture'));
    }
    return row;
  });
  inputPanel.replaceChildren(...rows, inputError, inputReset);
  inputPanel.hidden = inputs.length === 0;
  canvas.classList.toggle('point-input', inputs.some(isPointInput));
  inputError.hidden = true;
  refreshInputPanel();
}

function refreshInputPanel() {
  state.scene.inputs.forEach((input) => {
    inputReadouts.get(input.name)!.textContent = describeInputValue(input);
    const slider = inputSliders.get(input.name);
    if (slider && input.type === 'slider' && Number(slider.value) !== input.value) {
      slider.value = String(input.value);
    }
  });
  inputReset.disabled = state.inputValues.size === 0;
}

// Keeps the last good picture when a value makes the definition invalid.
function updateInputs(inputValues: ReadonlyMap<string, InputValue>, settle: boolean) {
  state.inputValues = inputValues;
  try {
    state.scene = parseScene(state.definitionText, inputValues);
    inputError.hidden = true;
  } catch (error) {
    inputError.textContent = error instanceof Error ? error.message : 'Invalid input value';
    inputError.hidden = false;
    refreshInputPanel();
    return;
  }
  refreshInputPanel();
  renderPreview(settle);
}

function setInputValue(name: string, value: InputValue, settle: boolean) {
  updateInputs(new Map(state.inputValues).set(name, value), settle);
}

// Canvas pixels and scene coordinates of a pointer over the picture.
function pointerPosition(event: PointerEvent): { pixel: Vec2; scene: Vec2 } {
  const rect = canvas.getBoundingClientRect();
  const fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  const { x, y } = state.scene.view.coordinates;
  return {
    pixel: { x: fx * canvas.width, y: fy * canvas.height },
    scene: { x: x.from + fx * (x.to - x.from), y: y.from + (1 - fy) * (y.to - y.from) },
  };
}

// Pressing the picture moves the nearest point input there; drag inputs
// then follow the pointer until it is released.
let draggingInput: string | null = null;
// The arrow keys move the point last pressed, and Space picks the next one.
let keyboardInput: string | null = null;
const KEY_STEP_FRACTION = 0.01;
const KEY_STEP_SHIFT_FRACTION = 0.1;

canvas.addEventListener('keydown', (event) => {
  const pointInputs = state.scene.inputs.filter(isPointInput);
  if (pointInputs.length === 0 || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  const index = Math.max(0, pointInputs.findIndex((input) => input.name === keyboardInput));
  if (event.key === ' ') {
    event.preventDefault();
    const next = pointInputs[(index + 1) % pointInputs.length];
    keyboardInput = next.name;
    showSceneStatus(`Arrow keys move ${next.label}`);
    return;
  }
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
  if (!direction) {
    return;
  }
  event.preventDefault();
  const input = pointInputs[index];
  keyboardInput = input.name;
  const { x, y } = state.scene.view.coordinates;
  const step = event.shiftKey ? KEY_STEP_SHIFT_FRACTION : KEY_STEP_FRACTION;
  const move = (value: number, range: typeof x, sign: number) =>
    clamp(value + sign * step * (range.to - range.from), Math.min(range.from, range.to), Math.max(range.from, range.to));
  setInputValue(input.name, { x: move(input.value.x, x, direction[0]), y: move(input.value.y, y, direction[1]) }, false);
  scheduleSettledRender();
});

canvas.addEventListener('pointerdown', (event) => {
  const pointInputs = state.scene.inputs.filter(isPointInput);
  if (pointInputs.length === 0 || event.button !== 0) {
    return;
  }
  event.preventDefault();
  const { pixel, scene } = pointerPosition(event);
  const distance = (input: PointInput) => {
    const at = scenePointToCanvas(input.value, resolvedScene());
    return Math.hypot(at.x - pixel.x, at.y - pixel.y);
  };
  const nearest = pointInputs.reduce((best, input) => distance(input) < distance(best) ? input : best);
  keyboardInput = nearest.name;
  if (nearest.type === 'drag') {
    draggingInput = nearest.name;
    canvas.setPointerCapture(event.pointerId);
  }
  setInputValue(nearest.name, scene, nearest.type === 'click');
});

canvas.addEventListener('pointermove', (event) => {
  if (draggingInput) {
    setInputValue(draggingInput, pointerPosition(event).scene, false);
  }
});

const endDrag = () => {
  if (draggingInput) {
    draggingInput = null;
    scheduleSettledRender();
  }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

const outputAspect = (scene: SceneDefinition) => {
  const widthGrowth = Math.abs(
    (scene.view.coordinates.x.to - scene.view.coordinates.x.from)
    / (scene.view.declared.x.to - scene.view.declared.x.from),
  );
  const heightGrowth = Math.abs(
    (scene.view.coordinates.y.to - scene.view.coordinates.y.from)
    / (scene.view.declared.y.to - scene.view.declared.y.from),
  );
  return scene.view.aspect * widthGrowth / heightGrowth;
};

const fitAspect = (aspect: number, width: number, height: number) => {
  const fittedWidth = Math.min(width, height * aspect);
  return { width: Math.max(1, fittedWidth), height: Math.max(1, fittedWidth / aspect) };
};

let webglMaximumTextureSize: number | null | undefined;
function maximumTextureSize() {
  if (webglMaximumTextureSize !== undefined) {
    return webglMaximumTextureSize;
  }
  const gl = document.createElement('canvas').getContext('webgl2');
  webglMaximumTextureSize = gl
    ? Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE))
    : null;
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return webglMaximumTextureSize;
}

type OutputResolution = {
  width: number;
  height: number;
  requestedWidth: number;
  requestedHeight: number;
  textureLimit: number | null;
  workingPixelLimit: number;
};

function outputResolution(
  scene: SceneDefinition,
  display: { width: number; height: number },
  options: QualityOptions,
): OutputResolution {
  const aspect = outputAspect(scene);
  let requestedWidth: number;
  let requestedHeight: number;
  if (options.resolution.mode === 'display') {
    const scale = options.resolution.scale * window.devicePixelRatio;
    requestedWidth = Math.max(1, Math.round(display.width * scale));
    requestedHeight = Math.max(1, Math.round(display.height * scale));
    const displayLimit = Math.min(1, options.resolution.maxSide / Math.max(requestedWidth, requestedHeight));
    requestedWidth = Math.max(1, Math.round(requestedWidth * displayLimit));
    requestedHeight = Math.max(1, Math.round(requestedHeight * displayLimit));
  } else {
    const { width, height } = options.resolution;
    if (width !== undefined) {
      requestedWidth = width;
      requestedHeight = Math.max(1, Math.round(width / aspect));
    } else {
      requestedHeight = height ?? 1200;
      requestedWidth = Math.max(1, Math.round(requestedHeight * aspect));
    }
  }
  const textureLimit = maximumTextureSize();
  const factor = options.supersampling;
  const workingSide = Math.max(requestedWidth, requestedHeight) * factor;
  const workingPixels = requestedWidth * requestedHeight * factor * factor;
  const dimensionScale = textureLimit === null ? 1 : textureLimit / workingSide;
  const areaScale = Math.sqrt(MAX_WEBGL_WORKING_PIXELS / workingPixels);
  const scale = Math.min(1, dimensionScale, areaScale);
  return {
    width: Math.max(1, Math.floor(requestedWidth * scale)),
    height: Math.max(1, Math.floor(requestedHeight * scale)),
    requestedWidth,
    requestedHeight,
    textureLimit,
    workingPixelLimit: MAX_WEBGL_WORKING_PIXELS,
  };
}

function showTextureLimit(resolution: OutputResolution, options: QualityOptions) {
  const constrained = resolution.width !== resolution.requestedWidth
    || resolution.height !== resolution.requestedHeight;
  textureLimitWarning.hidden = !constrained;
  if (!constrained) {
    textureLimitWarning.removeAttribute('aria-label');
    textureLimitWarning.removeAttribute('title');
    return;
  }
  const requested = `${resolution.requestedWidth} × ${resolution.requestedHeight}`;
  const actual = `${resolution.width} × ${resolution.height}`;
  const dimensionLimit = resolution.textureLimit === null
    ? 'the available WebGL texture size'
    : `${resolution.textureLimit}px`;
  const message = `Requested ${requested} px output needs `
    + `${Math.max(resolution.requestedWidth, resolution.requestedHeight) * options.supersampling}px textures and `
    + `${Math.round(resolution.requestedWidth * resolution.requestedHeight * options.supersampling ** 2 / 1_000_000)} million working pixels. `
    + `The limits are ${dimensionLimit} and ${Math.round(resolution.workingPixelLimit / 1_000_000)} million pixels. `
    + `Output reduced to ${actual} px.`;
  textureLimitWarning.setAttribute('aria-label', message);
  textureLimitWarning.title = message;
}

// The picture takes the largest size that leaves room for the label and
// inputs, which go beside it or, when that leaves a bigger picture, underneath.
// The preset then chooses the independent bitmap resolution for that CSS size.
function resizeCanvas() {
  const host = canvasHost.getBoundingClientRect();
  const aspect = outputAspect(state.scene);
  // Alone, the picture drops its border, margin and cards but keeps its padding and background.
  const frame = pictureOnly
    ? { ...state.scene.frame, width: 0, margin: 0, radius: 0, wall: state.scene.frame.background }
    : state.scene.frame;
  const frameSpace = 2 * (frame.width + frame.padding);
  // Notched phones add safe-area insets to the margin.
  canvasHost.style.padding = (['top', 'right', 'bottom', 'left'] as const)
    .map((side) => `calc(${frame.margin}px + env(safe-area-inset-${side}))`).join(' ');
  const hostStyle = getComputedStyle(canvasHost);
  const inset = (side: 'Top' | 'Right' | 'Bottom' | 'Left') => parseFloat(hostStyle[`padding${side}`]);
  const availableWidth = Math.max(1, host.width - inset('Left') - inset('Right') - frameSpace);
  const availableHeight = Math.max(1, host.height - inset('Top') - inset('Bottom') - frameSpace);
  // Cards stack beside the picture and sit side by side underneath it.
  const cards = pictureOnly ? [] : [inputPanel, wallLabel].filter((card) => !card.hidden);
  artworkSide.hidden = cards.length === 0;
  const sideWidth = cards.length === 0 ? 0 : Math.max(...cards.map((card) => card.offsetWidth)) + WALL_LABEL_GAP_PX;
  const sideHeight = cards.length === 0 ? 0 : Math.max(...cards.map((card) => card.offsetHeight)) + WALL_LABEL_GAP_PX;
  const beside = fitAspect(aspect, availableWidth - sideWidth, availableHeight);
  const below = fitAspect(aspect, availableWidth, availableHeight - sideHeight);
  const labelBelow = below.width * below.height > beside.width * beside.height;
  const display = labelBelow ? below : beside;
  const options = renderOptions();
  const resolution = outputResolution(state.scene, display, options);
  showTextureLimit(resolution, options);
  artwork.classList.toggle('label-below', labelBelow);

  canvasHost.style.backgroundColor = frame.wall;
  themeColour?.setAttribute('content', frame.wall);
  canvasFrame.style.padding = `${frame.padding}px`;
  canvasFrame.style.borderWidth = `${frame.width}px`;
  canvasFrame.style.borderColor = frame.color;
  canvasFrame.style.borderRadius = `${frame.radius}px`;
  canvasFrame.style.backgroundColor = frame.background;

  const resolutionChanged = canvas.width !== resolution.width || canvas.height !== resolution.height;
  canvas.style.width = `${display.width}px`;
  canvas.style.height = `${display.height}px`;
  if (resolutionChanged) {
    // Resizing clears the bitmap, so stretch the current frame until the
    // new resolution renders.
    canvas.width = resolution.width;
    canvas.height = resolution.height;
    drawDisplay();
  }
  return resolutionChanged;
}

const resolvedScene = (): ResolvedSceneDefinition =>
  withResolution(state.scene, { width: canvas.width, height: canvas.height });
function tracePolygon(points: { x: number; y: number }[]) {
  displayContext.beginPath();
  displayContext.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => displayContext.lineTo(point.x, point.y));
  displayContext.closePath();
}

function drawZoomOutlines(scene: ResolvedSceneDefinition) {
  const cssWidth = canvas.getBoundingClientRect().width;
  const pixelsPerCssPixel = cssWidth > 0 ? canvas.width / cssWidth : 1;
  const lineWidth = EDIT_MODE_OUTLINE_CSS_PIXELS * pixelsPerCssPixel;
  // Zooms and coordinates include the overflow; outline them as declared.
  const { coordinates, declared } = scene.view;
  const zooms = scene.elements
    .filter((element): element is ZoomElement => element.kind === 'zoom')
    .map((zoom) => reframeZoom(zoom, viewFrame(coordinates), viewFrame(declared)));

  displayContext.save();
  displayContext.setTransform(1, 0, 0, 1, 0, 0);
  displayContext.lineJoin = 'miter';
  if (JSON.stringify(coordinates) !== JSON.stringify(declared)) {
    const from = scenePointToCanvas({ x: declared.x.from, y: declared.y.to }, scene);
    const to = scenePointToCanvas({ x: declared.x.to, y: declared.y.from }, scene);
    displayContext.setLineDash([lineWidth * 2, lineWidth * 2]);
    displayContext.strokeStyle = 'rgba(128, 128, 128, 0.9)';
    displayContext.lineWidth = lineWidth;
    displayContext.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
  }
  for (const zoom of zooms) {
    const corners = elementCorners(zoom, scene);
    tracePolygon(corners);
    displayContext.setLineDash([]);
    displayContext.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    displayContext.lineWidth = lineWidth * 3;
    displayContext.stroke();
    displayContext.setLineDash([lineWidth * 4, lineWidth * 3]);
    displayContext.strokeStyle = '#e11d48';
    displayContext.lineWidth = lineWidth;
    displayContext.stroke();

    displayContext.setLineDash([]);
    displayContext.beginPath();
    displayContext.arc(corners[0].x, corners[0].y, lineWidth * 3, 0, Math.PI * 2);
    displayContext.fillStyle = '#e11d48';
    displayContext.fill();
    displayContext.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    displayContext.lineWidth = lineWidth;
    displayContext.stroke();

    for (const target of zoom.alignTargets.map((point) => scenePointToCanvas(point, scene))) {
      const size = lineWidth * 5;
      displayContext.beginPath();
      displayContext.moveTo(target.x - size, target.y);
      displayContext.lineTo(target.x + size, target.y);
      displayContext.moveTo(target.x, target.y - size);
      displayContext.lineTo(target.x, target.y + size);
      displayContext.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      displayContext.lineWidth = lineWidth * 3;
      displayContext.stroke();
      displayContext.strokeStyle = '#2563eb';
      displayContext.lineWidth = lineWidth;
      displayContext.stroke();
    }
  }
  displayContext.restore();
}


const PROGRESS_DELAY_MS = 150;

type DisplayedFrame = {
  bitmap: ImageBitmap;
  scene: ResolvedSceneDefinition;
  editMode: boolean;
  // Previews are reduced, so they are never downloaded.
  preview: boolean;
};

let displayedFrame: DisplayedFrame | null = null;

function clearDisplay() {
  displayedFrame?.bitmap.close();
  displayedFrame = null;
  drawDisplay();
}

function drawDisplay() {
  displayContext.setTransform(1, 0, 0, 1, 0, 0);
  displayContext.clearRect(0, 0, canvas.width, canvas.height);
  if (!displayedFrame) {
    return;
  }
  displayContext.imageSmoothingEnabled = true;
  displayContext.imageSmoothingQuality = 'high';
  displayContext.drawImage(displayedFrame.bitmap, 0, 0, canvas.width, canvas.height);
  if (displayedFrame.editMode) {
    // A frame stretched to a resized canvas keeps outlines at the new size.
    drawZoomOutlines(withResolution(displayedFrame.scene, { width: canvas.width, height: canvas.height }));
  }
}

function setRenderProgress(progress: number | null) {
  renderProgress.hidden = progress === null;
  if (progress === null) {
    renderProgressBar.style.width = '0%';
    renderProgress.removeAttribute('aria-valuenow');
    return;
  }

  const percentage = Math.round(clamp(progress, 0, 1) * 100);
  renderProgressBar.style.width = `${percentage}%`;
  renderProgress.setAttribute('aria-valuenow', String(percentage));
}

// The resolved settings mirror the inputs, so they are shown as hover text
// that stays visible while the settings are collapsed.
function describeSettings(settings: RenderSettings) {
  return [
    `${canvas.width} × ${canvas.height} px`,
    `${settings.supersampling}× supersampling`,
    `Recursion ${settings.recursionDepth}`,
    `Levels ${settings.autoLevels ? `Auto (${settings.levels})` : settings.levels}`,
  ].join(' · ');
}

const formatDuration = (milliseconds: number) => milliseconds < 1000
  ? `${Math.round(milliseconds)} ms`
  : `${(milliseconds / 1000).toFixed(1)} s`;

const formatChange = ({ fraction, levels }: StepChange) => {
  const span = levels === 1 ? 'in last level' : `over last ${levels} levels`;
  if (fraction === 0) {
    return `no pixels changed ${span}`;
  }
  const percentage = fraction * 100;
  const text = percentage >= 10 ? percentage.toFixed(0) : percentage.toPrecision(2);
  return `${text}% of pixels changed ${span}`;
};

// An idle worker keeps its last render so fixed levels can be extended.
// Replacing a busy worker cancels obsolete work immediately, unless the new
// request only adds levels, in which case it waits and continues afterwards.
let renderWorker: Worker | null = null;
let activeRequest: RenderRequest | null = null;
let pendingRequest: RenderRequest | null = null;
let extraAutoLevels = 0;
let autoExtensionKey: string | null = null;
const showLevelLimit = (reached: boolean, levels = 0) => {
  levelLimitWarning.hidden = !reached;
  extendLevelsButton.hidden = !reached || !Number.isSafeInteger(levels + EXTRA_LEVELS_STEP);
  extendLevelsButton.disabled = activeRequest !== null;
};
// Set once a render loses the GPU; later renders avoid WebGL2 until reload.
let webglDisabled: string | undefined;
const noteGpuLost = (reason: string | undefined) => {
  if (reason === GPU_LOST_MESSAGE) {
    webglDisabled = reason;
  }
};
let progressTimer = 0;

// While inputs change, pictures are previewed at Fast quality. A preview in
// progress finishes before the newest one starts, so the picture keeps up
// without restarting the renderer. Once the values settle, the selected
// quality is rendered.
const SETTLE_DELAY_MS = 400;
const PREVIEW_OPTIONS: RenderOptions = {
  supersampling: 1,
  recursionDepth: QUALITY_MODES.fast.recursionDepth,
  levels: QUALITY_MODES.fast.levels,
};
// Previews render at a reduced resolution, scaled up for display. Each
// preview request maps to the full scene, which edit-mode outlines use.
const PREVIEW_MAX_PIXELS = 500_000;
const previewRequests = new WeakMap<RenderRequest, ResolvedSceneDefinition>();
let settleTimer = 0;

function previewScene(scene: ResolvedSceneDefinition): ResolvedSceneDefinition {
  const { width, height } = scene.view.resolution;
  const scale = Math.min(1, Math.sqrt(PREVIEW_MAX_PIXELS / (width * height)));
  const resolution = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  return { ...scene, view: { ...scene.view, resolution } };
}

function scheduleSettledRender() {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => render(), SETTLE_DELAY_MS);
}

function renderPreview(settle: boolean) {
  window.clearTimeout(settleTimer);
  showLevelLimit(false);
  resizeCanvas();
  const scene = resolvedScene();
  const request: RenderRequest = {
    scene: previewScene(scene),
    options: PREVIEW_OPTIONS,
    editMode: state.editMode,
    webglDisabled,
  };
  previewRequests.set(request, scene);
  if (activeRequest && previewRequests.has(activeRequest)) {
    pendingRequest = request;
  } else {
    pendingRequest = null;
    if (activeRequest) {
      stopActiveRender(true);
    }
    startRender(request);
  }
  if (settle) {
    scheduleSettledRender();
  }
}

function stopActiveRender(terminate: boolean) {
  window.clearTimeout(progressTimer);
  setRenderProgress(null);
  activeRequest = null;
  shareDialog.setImageReady(displayedFrame !== null && !displayedFrame.preview);
  if (terminate) {
    renderWorker?.terminate();
    renderWorker = null;
  }
}

// Renders for a new resolution of the same picture keep showing the old
// image, stretched, until their final frame, instead of a rougher preview.
const resizeRequests = new WeakSet<RenderRequest>();

// Waits for resizing to settle, then renders if the resolution no longer
// matches the displayed frame.
let resizeRenderTimer = 0;
function renderAfterResize() {
  window.clearTimeout(resizeRenderTimer);
  resizeRenderTimer = window.setTimeout(() => {
    const target = activeRequest?.scene.view.resolution ?? displayedFrame?.scene.view.resolution;
    if (!target || target.width !== canvas.width || target.height !== canvas.height) {
      render(true);
    }
  }, 150);
}

function render(resized = false) {
  window.clearTimeout(settleTimer);
  resizeCanvas();
  const baseRequest: RenderRequest = {
    scene: resolvedScene(),
    options: renderOptions(),
    editMode: state.editMode,
    webglDisabled,
  };
  const key = continuationKey(baseRequest);
  if (key !== autoExtensionKey) {
    extraAutoLevels = 0;
    autoExtensionKey = key;
  }
  const request: RenderRequest = { ...baseRequest, additionalLevels: extraAutoLevels };
  if (resized) {
    resizeRequests.add(request);
  }
  showLevelLimit(false);
  if (activeRequest && canContinue(activeRequest, request)) {
    pendingRequest = request;
    return;
  }
  pendingRequest = null;
  if (activeRequest) {
    stopActiveRender(true);
  }
  startRender(request);
}

function startRender(request: RenderRequest) {
  const worker = renderWorker ??= new Worker(new URL('./render/worker.ts', import.meta.url), { type: 'module' });
  activeRequest = request;
  extendLevelsButton.disabled = true;
  shareDialog.setImageReady(false);
  let started: Extract<RenderMessage, { type: 'start' }> | null = null;
  let latestProgress = 0;
  let progressVisible = false;
  const showInProgress = () => {
    qualityDetails.textContent = 'Rendering...';
  };
  // Fast renders swap straight to the final details, so the text does not
  // briefly shrink and shift the controls below it. Previews never show
  // progress, which would flicker while inputs change.
  if (!previewRequests.has(request)) {
    progressTimer = window.setTimeout(() => {
      progressVisible = true;
      setRenderProgress(latestProgress);
      showInProgress();
    }, PROGRESS_DELAY_MS);
  }
  setRenderProgress(null);

  const finish = (failed: boolean) => {
    stopActiveRender(failed);
    const next = pendingRequest;
    pendingRequest = null;
    if (next) {
      startRender(next);
    }
  };

  worker.onmessage = (event: MessageEvent<RenderMessage>) => {
    if (activeRequest !== request) {
      return;
    }
    const message = event.data;
    switch (message.type) {
      case 'start':
        started = message;
        setSettingsTitle(describeSettings(message.settings));
        if (progressVisible) {
          showInProgress();
        }
        break;
      case 'progress':
        latestProgress = message.progress;
        if (progressVisible) {
          setRenderProgress(latestProgress);
        }
        break;
      case 'frame':
        if (!message.final && resizeRequests.has(request) && displayedFrame && !displayedFrame.preview) {
          message.bitmap.close();
          break;
        }
        displayedFrame?.bitmap.close();
        displayedFrame = {
          bitmap: message.bitmap,
          scene: previewRequests.get(request) ?? request.scene,
          editMode: request.editMode,
          preview: previewRequests.has(request),
        };
        drawDisplay();
        if (message.final) {
          // Only the change statistics remain, so the picture is done.
          window.clearTimeout(progressTimer);
          progressVisible = false;
          setRenderProgress(null);
        }
        break;
      case 'done': {
        const time = formatDuration(message.milliseconds);
        const step = message.stepMilliseconds === undefined ? '' : ` (last step ${formatDuration(message.stepMilliseconds)})`;
        if (started) {
          setSettingsTitle(`${describeSettings({ ...started.settings, levels: message.levels })} · ${time}${step}`);
        }
        state.resolvedLevels = message.levels;
        let labelChangedResolution = false;
        if (started) {
          state.rendered = { levels: message.levels };
          labelChangedResolution = updateWallLabel();
        }
        syncQualityControls();
        const limitReached = started !== null && started.settings.autoLevels
          && started.settings.autoLevelLimitReached
          && message.levels >= started.settings.levels;
        setQualityDetails([
          ...message.details,
          ...(message.stepChange === undefined ? [] : [formatChange(message.stepChange)]),
          `${time}${step}`,
        ], limitReached ? `stopped at ${message.levels} levels; more detail may be visible` : null);
        finish(false);
        if (labelChangedResolution) {
          render(true);
          break;
        }
        if (!activeRequest) {
          showLevelLimit(limitReached, message.levels);
        }
        break;
      }
      case 'error':
        noteGpuLost(message.message);
        setQualityDetails([`Render failed: ${message.message}`], null);
        finish(true);
        break;
    }
  };
  worker.onerror = (event) => {
    if (activeRequest !== request) {
      return;
    }
    setQualityDetails([`Render failed: ${event.message}`], null);
    finish(true);
  };
  worker.postMessage(request);
}

window.addEventListener('resize', () => {
  if (layoutHeld) {
    return;
  }
  setPictureZoom(IDENTITY_ZOOM);
  if (!resizeCanvas()) {
    drawDisplay();
  }
  renderAfterResize();
});

window.addEventListener('popstate', () => {
  void loadDefinitionFromAddressBar();
});

resizeCanvas();
buildInputPanel();
updateWallLabel();
render();
void loadDefinitionFromAddressBar();
