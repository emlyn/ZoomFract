import './style.css';
import {
  DEFAULT_EXAMPLE,
  EXAMPLES,
  findExample,
} from './examples';
import {
  MAXIMUM_LEVELS,
  MAXIMUM_RECURSION_CHOICE,
  QUALITY_LABELS,
  QUALITY_MODES,
  RENDERER_LABELS,
  SUPERSAMPLING_CHOICES,
  canContinue,
  elementCorners,
  scenePointToCanvas,
  type QualityMode,
  type RenderMessage,
  type RenderOptions,
  type RenderRequest,
  type RenderSettings,
  type RendererName,
  type StepChange,
} from './render/common';
import {
  clamp,
  parseScene,
  type SceneDefinition,
  type ZoomElement,
} from './scene';

type DefinitionLocation =
  | { kind: 'example'; id: string }
  | { kind: 'source'; url: string }
  | { kind: 'custom' };

const DEFAULT_SCENE_TEXT = DEFAULT_EXAMPLE.text;
const REMOTE_DEFINITION_TIMEOUT_MS = 10_000;
const REMOTE_DEFINITION_MAX_BYTES = 512 * 1024;
const EDIT_MODE_OUTLINE_CSS_PIXELS = 1.5;

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

function definitionLocationFromUrl(): DefinitionLocation {
  const parameters = new URLSearchParams(window.location.search);
  const example = parameters.get('example');
  const source = parameters.get('source');

  if (example && source) {
    throw new Error('Use either "example" or "source", not both');
  }
  if (example) {
    return { kind: 'example', id: example };
  }
  if (source) {
    return { kind: 'source', url: source };
  }
  return { kind: 'example', id: DEFAULT_EXAMPLE.id };
}

function updateDefinitionUrl(location: DefinitionLocation) {
  const url = new URL(window.location.href);
  url.searchParams.delete('example');
  url.searchParams.delete('source');

  if (location.kind === 'example') {
    url.searchParams.set('example', location.id);
  } else if (location.kind === 'source') {
    url.searchParams.set('source', location.url);
  }

  window.history.replaceState(null, '', url);
}

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App root not found');
}

const shell = document.createElement('div');
shell.className = 'app-shell';

const panel = document.createElement('aside');
panel.className = 'sidebar';

const panelResizeHandle = document.createElement('div');
panelResizeHandle.className = 'panel-resize-handle';
panelResizeHandle.setAttribute('role', 'separator');
panelResizeHandle.setAttribute('aria-label', 'Resize panel');
panelResizeHandle.setAttribute('aria-orientation', 'vertical');

const panelToggle = document.createElement('button');
panelToggle.className = 'panel-toggle';
panelToggle.type = 'button';
panelToggle.setAttribute('aria-label', 'Hide panel');

const panelToggleIcon = document.createElement('span');
panelToggleIcon.className = 'panel-toggle-icon';
panelToggle.append(panelToggleIcon);

const canvasHost = document.createElement('div');
canvasHost.className = 'canvas-host';

const canvasFrame = document.createElement('div');
canvasFrame.className = 'canvas-frame';

const canvas = document.createElement('canvas');
const displayContext = canvas.getContext('2d')!;

canvasFrame.append(canvas);
canvasHost.append(canvasFrame);

let panelIsOpen = true;
let panelIsResizing = false;

function setPanelOpen(isOpen: boolean) {
  panelIsOpen = isOpen;
  panel.classList.toggle('collapsed', !isOpen);
  shell.classList.toggle('panel-collapsed', !isOpen);
  shell.classList.remove('panel-handle-visible');
  panelToggle.setAttribute('aria-label', isOpen ? 'Hide panel' : 'Show panel');
}

panelToggle.addEventListener('click', () => {
  setPanelOpen(!panelIsOpen);
});

panelResizeHandle.addEventListener('pointerdown', (event) => {
  panelIsResizing = true;
  panelResizeHandle.setPointerCapture(event.pointerId);
  shell.classList.add('panel-resizing');
});

panelResizeHandle.addEventListener('pointermove', (event) => {
  if (!panelIsResizing) {
    return;
  }

  const width = clamp(event.clientX, 240, Math.min(560, window.innerWidth * 0.6));
  shell.style.setProperty('--panel-width', `${width}px`);
  panelResizeHandle.setAttribute('aria-valuenow', String(Math.round(width)));
});

panelResizeHandle.addEventListener('pointerup', (event) => {
  panelIsResizing = false;
  panelResizeHandle.releasePointerCapture(event.pointerId);
  shell.classList.remove('panel-resizing');
});

window.addEventListener('pointermove', (event) => {
  if (panelIsOpen) {
    shell.classList.remove('panel-handle-visible');
    return;
  }

  const nearTopLeft = event.clientX < 48 && event.clientY < 72;
  shell.classList.toggle('panel-handle-visible', nearTopLeft);
});

const panelHeader = document.createElement('div');
panelHeader.className = 'panel-header';
panelHeader.innerHTML = '<h1>ZoomFract</h1>';

const controls = document.createElement('div');
controls.className = 'controls';

// The slider's rightmost position selects automatic levels.
const AUTO_LEVELS_POSITION = MAXIMUM_LEVELS + 1;

const renderOptions = (): RenderOptions =>
  state.quality === 'custom' ? customOptions() : QUALITY_MODES[state.quality];

// Custom starts from the first mode it is opened from, then keeps its own values.
const customOptions = (): RenderOptions => {
  state.custom ??= state.quality === 'custom' ? QUALITY_MODES.high : QUALITY_MODES[state.quality];
  return state.custom;
};

const updateCustomOptions = (update: Partial<RenderOptions>) => {
  state.custom = { ...customOptions(), ...update };
  syncQualityControls();
  render();
};

const qualityControl = selectRow<QualityMode>(
  'quality-row',
  'Quality',
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

const rendererControl = selectRow<RendererName>(
  'renderer-row',
  'Renderer',
  Object.entries(RENDERER_LABELS) as [RendererName, string][],
  (renderer) => updateCustomOptions({ renderer }),
);
rendererControl.row.title = 'How the image is drawn. WebGL2 uses the graphics card and is much faster; '
  + 'Canvas 2D is a slower, simpler reference that works everywhere.';

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

const levelsRow = document.createElement('label');
levelsRow.className = 'levels-row';
levelsRow.title = 'How many times the picture repeats inside itself. More levels add finer detail. '
  + 'Auto (far right) keeps going until extra levels would be too small to see.';
levelsRow.innerHTML = '<span>Levels</span>';
const levelsSlider = document.createElement('input');
levelsSlider.type = 'range';
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
customSettingsSummary.textContent = 'Render settings';
const customSettingsBody = document.createElement('div');
customSettingsBody.className = 'render-settings-body';
const qualityDetails = document.createElement('div');
qualityDetails.className = 'quality-details';
customSettingsBody.append(rendererControl.row, supersamplingControl.row, recursionControl.row, levelsRow, qualityDetails);
customSettings.append(customSettingsSummary, customSettingsBody);

// The quality select and the collapsed settings header both show what the
// latest render actually used.
const setSettingsTitle = (text: string) => {
  qualityControl.row.title = text;
  customSettingsSummary.title = text;
};

// Fast and High quality show their fixed settings read-only.
function syncQualityControls() {
  qualityControl.setValue(state.quality);
  const isCustom = state.quality === 'custom';
  const options = renderOptions();
  const isAuto = options.levels === 'auto';
  rendererControl.setValue(options.renderer);
  supersamplingControl.setValue(options.supersampling);
  recursionControl.setValue(options.recursionDepth);
  levelsSlider.value = String(options.levels === 'auto' ? AUTO_LEVELS_POSITION : options.levels);
  levelsValue.textContent = isAuto
    ? `Auto${state.resolvedLevels === null ? '' : ` (${state.resolvedLevels})`}`
    : String(options.levels);
  for (const control of [rendererControl.select, supersamplingControl.select, recursionControl.select, levelsSlider]) {
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
editModeRow.append(editModeToggle);

editModeToggle.addEventListener('change', () => {
  state.editMode = editModeToggle.checked;
  render();
});

const exampleRow = document.createElement('label');
exampleRow.className = 'example-row';
exampleRow.innerHTML = '<span>Example</span>';

const exampleSelect = document.createElement('select');
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

const exampleDetails = document.createElement('div');
exampleDetails.className = 'example-details';
exampleDetails.textContent = DEFAULT_EXAMPLE.description;

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

const sceneInput = document.createElement('textarea');
sceneInput.className = 'scene-input';
sceneInput.rows = 18;
sceneInput.value = DEFAULT_SCENE_TEXT;
sceneInput.addEventListener('input', () => {
  exampleSelect.value = '';
  exampleDetails.textContent = 'Custom definition';
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
  applyDefinition(sceneInput.value, { kind: 'custom' }, true);
});

const downloadButton = document.createElement('button');
downloadButton.type = 'button';
downloadButton.className = 'apply-scene download-image';
downloadButton.textContent = 'Download PNG';
downloadButton.disabled = true;

// Saves the canvas at its full declared resolution, exactly as displayed.
downloadButton.addEventListener('click', () => {
  const location = state.definitionLocation;
  const name = location.kind === 'example' ? location.id : 'custom';
  canvas.toBlob((blob) => {
    if (!blob) {
      showSceneStatus('Could not create PNG', true);
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `zoomfract-${name}.png`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, 'image/png');
});

exampleSelect.addEventListener('change', () => {
  const example = findExample(exampleSelect.value);
  if (!example) {
    exampleDetails.textContent = 'Custom definition';
    return;
  }
  void loadDefinitionLocation({ kind: 'example', id: example.id }, true);
});

controls.append(
  qualityControl.row,
  customSettings,
  exampleRow,
  exampleDetails,
  sceneInputLabel,
  sceneInput,
  editModeRow,
  applySceneButton,
  downloadButton,
  sceneStatus,
);
panel.append(panelHeader, controls, panelResizeHandle);
shell.append(panel, panelToggle, canvasHost, renderProgress);
app.append(shell);

const baseScene = parseScene(DEFAULT_SCENE_TEXT);
const state = {
  quality: 'high' as QualityMode,
  custom: null as RenderOptions | null,
  resolvedLevels: null as number | null,
  editMode: false,
  offsetX: 0,
  offsetY: -10,
  scene: baseScene,
  definitionLocation: { kind: 'example', id: DEFAULT_EXAMPLE.id } as DefinitionLocation,
};
let definitionLoadRevision = 0;
syncQualityControls();

function showSceneStatus(message: string, isError = false) {
  sceneStatus.textContent = message;
  sceneStatus.classList.toggle('error', isError);
}

function applyDefinition(
  text: string,
  location: DefinitionLocation,
  updateUrl: boolean,
): boolean {
  try {
    const nextScene = parseScene(text);
    state.scene = nextScene;
    state.definitionLocation = location;
    sceneInput.value = text.trim();

    if (location.kind === 'example') {
      const example = findExample(location.id);
      exampleSelect.value = example?.id ?? '';
      exampleDetails.textContent = example?.description ?? 'Custom definition';
    } else if (location.kind === 'source') {
      exampleSelect.value = '';
      exampleDetails.textContent = `Remote: ${location.url}`;
    } else {
      exampleSelect.value = '';
      exampleDetails.textContent = 'Custom definition';
    }

    showSceneStatus('');
    if (updateUrl) {
      updateDefinitionUrl(location);
    }
    resizeCanvas();
    render();
    return true;
  } catch (error) {
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
      applyDefinition(text, location, updateUrl);
    } catch (error) {
      if (revision !== definitionLoadRevision) {
        return;
      }
      showSceneStatus(error instanceof Error ? error.message : 'Could not load source', true);
    }
    return;
  }

  applyDefinition(sceneInput.value, location, updateUrl);
}

async function loadDefinitionFromAddressBar() {
  try {
    await loadDefinitionLocation(definitionLocationFromUrl(), false);
  } catch (error) {
    showSceneStatus(error instanceof Error ? error.message : 'Invalid definition location', true);
  }
}

function resizeCanvas() {
  const host = canvasHost.getBoundingClientRect();
  const frame = state.scene.frame;
  const resolution = state.scene.view.resolution;
  const horizontalSpace = 2 * (frame.margin + frame.width + frame.padding);
  const verticalSpace = 2 * (frame.margin + frame.width + frame.padding);
  const availableWidth = Math.max(1, host.width - horizontalSpace);
  const availableHeight = Math.max(1, host.height - verticalSpace);
  const displayScale = Math.min(
    availableWidth / resolution.width,
    availableHeight / resolution.height,
  );

  canvasHost.style.backgroundColor = frame.wall;
  canvasHost.style.padding = `${frame.margin}px`;
  canvasFrame.style.padding = `${frame.padding}px`;
  canvasFrame.style.borderWidth = `${frame.width}px`;
  canvasFrame.style.borderColor = frame.color;
  canvasFrame.style.borderRadius = `${frame.radius}px`;
  canvasFrame.style.backgroundColor = frame.background;

  if (canvas.width !== resolution.width || canvas.height !== resolution.height) {
    canvas.width = resolution.width;
    canvas.height = resolution.height;
  }
  canvas.style.width = `${resolution.width * displayScale}px`;
  canvas.style.height = `${resolution.height * displayScale}px`;
}
function tracePolygon(points: { x: number; y: number }[]) {
  displayContext.beginPath();
  displayContext.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => displayContext.lineTo(point.x, point.y));
  displayContext.closePath();
}

function drawZoomOutlines(scene: SceneDefinition) {
  const cssWidth = canvas.getBoundingClientRect().width;
  const pixelsPerCssPixel = cssWidth > 0 ? canvas.width / cssWidth : 1;
  const lineWidth = EDIT_MODE_OUTLINE_CSS_PIXELS * pixelsPerCssPixel;
  const zooms = scene.elements.filter((element): element is ZoomElement => element.kind === 'zoom');

  displayContext.save();
  displayContext.setTransform(1, 0, 0, 1, 0, 0);
  displayContext.lineJoin = 'miter';
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
  scene: SceneDefinition;
  editMode: boolean;
};

let displayedFrame: DisplayedFrame | null = null;

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
    drawZoomOutlines(displayedFrame.scene);
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
function describeSettings(renderer: RendererName, settings: RenderSettings) {
  return [
    RENDERER_LABELS[renderer],
    `${settings.supersampling}× supersampling`,
    `Recursion ${settings.recursionDepth}`,
    `Levels ${settings.autoLevels ? `Auto (${settings.levels})` : settings.levels}`,
  ].join(' · ');
}

// Details not visible in the inputs above them.
function describeRender(settings: RenderSettings, fallbackReason?: string) {
  return [
    ...(fallbackReason ? [`Canvas 2D fallback: ${fallbackReason}`] : []),
    ...(settings.renderPasses > 1 ? [`${settings.renderPasses} passes`] : []),
  ];
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
let progressTimer = 0;

function stopActiveRender(terminate: boolean) {
  window.clearTimeout(progressTimer);
  setRenderProgress(null);
  activeRequest = null;
  downloadButton.disabled = displayedFrame === null;
  if (terminate) {
    renderWorker?.terminate();
    renderWorker = null;
  }
}

function render() {
  const request: RenderRequest = {
    scene: state.scene,
    options: renderOptions(),
    editMode: state.editMode,
  };
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
  downloadButton.disabled = true;
  let details: string[] = [];
  let started: Extract<RenderMessage, { type: 'start' }> | null = null;
  let latestProgress = 0;
  let progressVisible = false;
  const showInProgress = () => {
    qualityDetails.textContent = ['Rendering...', ...details].join(' · ');
  };
  // Fast renders swap straight to the final details, so the text does not
  // briefly shrink and shift the controls below it.
  progressTimer = window.setTimeout(() => {
    progressVisible = true;
    setRenderProgress(latestProgress);
    showInProgress();
  }, PROGRESS_DELAY_MS);
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
        details = describeRender(message.settings, message.fallbackReason);
        setSettingsTitle(describeSettings(message.renderer, message.settings));
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
        displayedFrame?.bitmap.close();
        displayedFrame = { bitmap: message.bitmap, scene: request.scene, editMode: request.editMode };
        drawDisplay();
        break;
      case 'done': {
        // Automatic levels may converge before the estimate given at the start.
        const time = formatDuration(message.milliseconds);
        const step = message.stepMilliseconds === undefined ? '' : ` (last step ${formatDuration(message.stepMilliseconds)})`;
        if (started) {
          const settings = {
            ...started.settings,
            levels: message.levels,
            renderPasses: message.renderPasses ?? started.settings.renderPasses,
          };
          details = describeRender(settings, started.fallbackReason);
          setSettingsTitle(`${describeSettings(started.renderer, settings)} · ${time}${step}`);
        }
        state.resolvedLevels = message.levels;
        syncQualityControls();
        qualityDetails.textContent = [
          ...details,
          ...message.details,
          ...(message.stepChange === undefined ? [] : [formatChange(message.stepChange)]),
          `${time}${step}`,
        ].join(' · ');
        finish(false);
        break;
      }
      case 'error':
        qualityDetails.textContent = `Render failed: ${message.message}`;
        finish(true);
        break;
    }
  };
  worker.onerror = (event) => {
    if (activeRequest !== request) {
      return;
    }
    qualityDetails.textContent = `Render failed: ${event.message}`;
    finish(true);
  };
  worker.postMessage(request);
}

window.addEventListener('resize', () => {
  resizeCanvas();
  drawDisplay();
});

window.addEventListener('popstate', () => {
  void loadDefinitionFromAddressBar();
});

resizeCanvas();
render();
void loadDefinitionFromAddressBar();
