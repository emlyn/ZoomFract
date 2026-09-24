import './style.css';
import YAML from 'yaml';

type Vec2 = {
  x: number;
  y: number;
};

type BranchNode = {
  start: Vec2;
  end: Vec2;
  depth: number;
};

type SceneElement = {
  name?: string;
};

type RectElement = SceneElement & {
  kind: 'rect';
  center: Vec2;
  width: number;
  height: number;
  rotation: number;
  color: string;
  opacity: number;
};

type ZoomElement = SceneElement & {
  kind: 'zoom';
  center: Vec2;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
};

type DrawableElement = RectElement | ZoomElement;

type CapturedScene = {
  width: number;
  height: number;
  levels: HTMLCanvasElement[];
  leafRasters: Map<string, HTMLCanvasElement>;
};

type AxisRange = {
  from: number;
  to: number;
};

type QualityPresetName = 'fast' | 'balanced' | 'high' | 'proof';

type QualityPreset = {
  label: string;
  renderPasses: number;
  supersampling: number;
  minimumLeafPixels: number;
  maximumLeaves: number;
};

type RenderSettings = {
  recursionDepth: number;
  renderPasses: number;
  supersampling: number;
};

const QUALITY_PRESETS: Record<QualityPresetName, QualityPreset> = {
  fast: {
    label: 'Fast',
    renderPasses: 3,
    supersampling: 1,
    minimumLeafPixels: 10,
    maximumLeaves: 50,
  },
  balanced: {
    label: 'Balanced',
    renderPasses: 3,
    supersampling: 2,
    minimumLeafPixels: 4,
    maximumLeaves: 1000,
  },
  high: {
    label: 'High',
    renderPasses: 4,
    supersampling: 3,
    minimumLeafPixels: 2,
    maximumLeaves: 5000,
  },
  proof: {
    label: 'Proof',
    renderPasses: 6,
    supersampling: 4,
    minimumLeafPixels: 0.75,
    maximumLeaves: 10000,
  },
};

type SceneDefinition = {
  background: string;
  seed: {
    color: string;
    opacity: number;
  };
  hasFractal: boolean;
  depth: number;
  trunkLength: number;
  branchAngle: number;
  spread: number;
  hueStart: number;
  view: {
    aspect: number;
    resolution: {
      width: number;
      height: number;
    };
    coordinates: {
      x: AxisRange;
      y: AxisRange;
    };
  };
  fractal: {
    depth: number;
    trunkLength: number;
    branchAngle: number;
    spread: number;
    hueStart: number;
  };
  elements: DrawableElement[];
};

const DEFAULT_SCENE_TEXT = `background: "#ffffff"

view:
  aspect: 1.154
  resolution:
    height: 1200
  coordinates:
    x: [-1, 1]
    y: [-1, 1]

scene:
  seed:
    color: "#000000"
  zoom:
    - name: bottom-left
      bottomLeft: [-1, -1]
      topRight: [0, 0]
    - name: bottom-right
      bottomLeft: [0, -1]
      topRight: [1, 0]
    - name: top
      bottomLeft: [-0.5, 0]
      topRight: [0.5, 1]`;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const text = value.trim().replace(/,/g, '');
    if (text.includes('/')) {
      const [left, right] = text.split('/');
      const numerator = Number(left.trim());
      const denominator = Number(right.trim());
      if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
        return numerator / denominator;
      }
    }

    const parsed = Number(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function parseAspectRatio(value: unknown): number {
  const ratio = asNumber(value, 1);
  return ratio > 0 ? ratio : 1;
}

function asPositiveNumber(value: unknown): number | undefined {
  const number = asNumber(value, Number.NaN);
  return number > 0 ? number : undefined;
}

function resolveView(view: Record<string, unknown>) {
  const resolutionNode = view.resolution && typeof view.resolution === 'object' && !Array.isArray(view.resolution)
    ? (view.resolution as Record<string, unknown>)
    : {};
  const requestedWidth = asPositiveNumber(resolutionNode.width);
  const requestedHeight = asPositiveNumber(resolutionNode.height);
  const requestedAspect = parseAspectRatio(view.aspect ?? view.aspectRatio ?? view.ratio);

  if (requestedWidth && requestedHeight) {
    return {
      aspect: requestedWidth / requestedHeight,
      resolution: {
        width: Math.round(requestedWidth),
        height: Math.round(requestedHeight),
      },
    };
  }

  if (requestedHeight) {
    return {
      aspect: requestedAspect,
      resolution: {
        width: Math.max(1, Math.round(requestedHeight * requestedAspect)),
        height: Math.round(requestedHeight),
      },
    };
  }

  if (!requestedWidth) {
    return {
      aspect: requestedAspect,
      resolution: {
        width: Math.max(1, Math.round(1200 * requestedAspect)),
        height: 1200,
      },
    };
  }

  const width = Math.round(requestedWidth);
  return {
    aspect: requestedAspect,
    resolution: {
      width,
      height: Math.max(1, Math.round(width / requestedAspect)),
    },
  };
}

function parseAxisRange(value: unknown, fallback: AxisRange): AxisRange {
  let from: number;
  let to: number;

  if (Array.isArray(value)) {
    from = asNumber(value[0], fallback.from);
    to = asNumber(value[1], fallback.to);
  } else if (value && typeof value === 'object') {
    const range = value as Record<string, unknown>;
    from = asNumber(range.from ?? range.min, fallback.from);
    to = asNumber(range.to ?? range.max, fallback.to);
  } else {
    return fallback;
  }

  return from === to ? fallback : { from, to };
}

function legacyCoordinates(
  value: unknown,
  resolution: { width: number; height: number },
): SceneDefinition['view']['coordinates'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const legacy = value as Record<string, unknown>;
  const centered = legacy.origin !== 'top-left';
  const originX = centered ? resolution.width / 2 : 0;
  const originY = centered ? resolution.height / 2 : 0;
  const x = legacy.x === 'left'
    ? { from: originX, to: originX - resolution.width }
    : { from: -originX, to: resolution.width - originX };
  const y = legacy.y === 'down'
    ? { from: resolution.height - originY, to: -originY }
    : { from: originY - resolution.height, to: originY };

  return { x, y };
}

type CornerName = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft';

type RectGeometry = Pick<RectElement, 'center' | 'width' | 'height' | 'rotation'>;

const CORNER_SIGNS: Record<CornerName, Vec2> = {
  topLeft: { x: -1, y: 1 },
  topRight: { x: 1, y: 1 },
  bottomRight: { x: 1, y: -1 },
  bottomLeft: { x: -1, y: -1 },
};

const CORNER_NAMES = Object.keys(CORNER_SIGNS) as CornerName[];
const RECT_EPSILON = 1e-6;
const LEAF_RASTER_OVERSAMPLING = 2;

const add = (left: Vec2, right: Vec2): Vec2 => ({ x: left.x + right.x, y: left.y + right.y });
const subtract = (left: Vec2, right: Vec2): Vec2 => ({ x: left.x - right.x, y: left.y - right.y });
const scaleVector = (vector: Vec2, scale: number): Vec2 => ({ x: vector.x * scale, y: vector.y * scale });
const vectorLength = (vector: Vec2) => Math.hypot(vector.x, vector.y);
const rotateVector = (vector: Vec2, angle: number): Vec2 => ({
  x: vector.x * Math.cos(angle) - vector.y * Math.sin(angle),
  y: vector.x * Math.sin(angle) + vector.y * Math.cos(angle),
});

function parsePoint(value: unknown): Vec2 | undefined {
  if (Array.isArray(value) && value.length >= 2) {
    const x = asNumber(value[0], Number.NaN);
    const y = asNumber(value[1], Number.NaN);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }

  if (value && typeof value === 'object') {
    const point = value as Record<string, unknown>;
    const x = asNumber(point.x, Number.NaN);
    const y = asNumber(point.y, Number.NaN);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }

  return undefined;
}

function parseRotation(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value * Math.PI / 180;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rotation = value as Record<string, unknown>;
    const radians = asNumber(rotation.radians ?? rotation.rad, Number.NaN);
    if (Number.isFinite(radians)) {
      return radians;
    }
    const degrees = asNumber(rotation.degrees ?? rotation.deg, Number.NaN);
    return Number.isFinite(degrees) ? degrees * Math.PI / 180 : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const match = value.trim().toLowerCase().match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(deg|rad)$/);
  if (!match) {
    return undefined;
  }

  const angle = Number(match[1]);
  return match[2] === 'rad' ? angle : angle * Math.PI / 180;
}

function rectCorner(geometry: RectGeometry, name: CornerName): Vec2 {
  const sign = CORNER_SIGNS[name];
  return add(
    geometry.center,
    rotateVector({
      x: sign.x * geometry.width / 2,
      y: sign.y * geometry.height / 2,
    }, geometry.rotation),
  );
}

function geometryFromAnchor(
  anchor: Vec2,
  anchorSign: Vec2,
  width: number,
  height: number,
  rotation: number,
): RectGeometry {
  const offset = rotateVector({
    x: anchorSign.x * width / 2,
    y: anchorSign.y * height / 2,
  }, rotation);
  return { center: subtract(anchor, offset), width, height, rotation };
}

function geometryFromCorners(corners: Partial<Record<CornerName, Vec2>>): RectGeometry | undefined {
  const horizontalPairs: [CornerName, CornerName][] = [
    ['topLeft', 'topRight'],
    ['bottomLeft', 'bottomRight'],
  ];
  const verticalPairs: [CornerName, CornerName][] = [
    ['bottomLeft', 'topLeft'],
    ['bottomRight', 'topRight'],
  ];
  const horizontal = horizontalPairs
    .map(([from, to]) => corners[from] && corners[to] ? subtract(corners[to]!, corners[from]!) : undefined)
    .find(Boolean);
  const vertical = verticalPairs
    .map(([from, to]) => corners[from] && corners[to] ? subtract(corners[to]!, corners[from]!) : undefined)
    .find(Boolean);

  if (!horizontal || !vertical) {
    return undefined;
  }

  const width = vectorLength(horizontal);
  const height = vectorLength(vertical);
  const rotation = Math.atan2(horizontal.y, horizontal.x);
  const anchorName = CORNER_NAMES.find((name) => corners[name]);
  if (!anchorName || width <= RECT_EPSILON || height <= RECT_EPSILON) {
    return undefined;
  }

  return geometryFromAnchor(corners[anchorName]!, CORNER_SIGNS[anchorName], width, height, rotation);
}

function geometryMatches(
  geometry: RectGeometry,
  center: Vec2 | undefined,
  corners: Partial<Record<CornerName, Vec2>>,
  width: number | undefined,
  height: number | undefined,
  rotation: number | undefined,
): boolean {
  const tolerance = Math.max(RECT_EPSILON, Math.max(geometry.width, geometry.height) * 1e-6);
  const pointsMatch = (left: Vec2, right: Vec2) => vectorLength(subtract(left, right)) <= tolerance;
  const angleMatches = (left: number, right: number) =>
    Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right))) <= RECT_EPSILON;

  return (!center || pointsMatch(geometry.center, center))
    && (!width || Math.abs(geometry.width - width) <= tolerance)
    && (!height || Math.abs(geometry.height - height) <= tolerance)
    && (rotation === undefined || angleMatches(geometry.rotation, rotation))
    && CORNER_NAMES.every((name) => !corners[name] || pointsMatch(rectCorner(geometry, name), corners[name]!));
}

function resolveRectGeometry(
  rect: Record<string, unknown>,
  defaultAspect?: number,
  elementName = 'Rectangle',
): RectGeometry {
  const center = parsePoint(rect.center ?? rect.centre)
    ?? (rect.x !== undefined || rect.y !== undefined
      ? { x: asNumber(rect.x, 0), y: asNumber(rect.y, 0) }
      : undefined);
  const corners = Object.fromEntries(
    CORNER_NAMES
      .map((name) => [name, parsePoint(rect[name])] as const)
      .filter((entry): entry is [CornerName, Vec2] => Boolean(entry[1])),
  ) as Partial<Record<CornerName, Vec2>>;
  let width = asPositiveNumber(rect.width);
  let height = asPositiveNumber(rect.height);
  if (defaultAspect && width && !height) {
    height = width / defaultAspect;
  } else if (defaultAspect && height && !width) {
    width = height * defaultAspect;
  }
  const rotation = parseRotation(rect.rotation);
  if (rect.rotation !== undefined && rotation === undefined) {
    throw new Error(`${elementName} rotation must be degrees, "<angle>deg", "<angle>rad", or a unit object`);
  }
  const specifiedCorners = CORNER_NAMES.filter((name) => corners[name]);
  const candidates: RectGeometry[] = [];
  const addCandidate = (candidate: RectGeometry | undefined) => {
    if (candidate && geometryMatches(candidate, center, corners, width, height, rotation)) {
      candidates.push(candidate);
    }
  };

  if (width && height) {
    const angle = rotation ?? 0;
    if (center) {
      addCandidate({ center, width, height, rotation: angle });
    }
    for (const name of specifiedCorners) {
      addCandidate(geometryFromAnchor(corners[name]!, CORNER_SIGNS[name], width, height, angle));
    }
  }

  if (center && rotation !== undefined) {
    for (const name of specifiedCorners) {
      const localOffset = rotateVector(subtract(corners[name]!, center), -rotation);
      addCandidate({
        center,
        width: Math.abs(localOffset.x) * 2,
        height: Math.abs(localOffset.y) * 2,
        rotation,
      });
    }
  }

  addCandidate(geometryFromCorners(corners));

  const horizontalEdges: [CornerName, CornerName][] = [
    ['topLeft', 'topRight'],
    ['bottomLeft', 'bottomRight'],
  ];
  for (const [left, right] of horizontalEdges) {
    if (corners[left] && corners[right] && height) {
      const edge = subtract(corners[right]!, corners[left]!);
      addCandidate(geometryFromAnchor(
        corners[left]!,
        CORNER_SIGNS[left],
        vectorLength(edge),
        height,
        Math.atan2(edge.y, edge.x),
      ));
    }
  }

  const verticalEdges: [CornerName, CornerName][] = [
    ['bottomLeft', 'topLeft'],
    ['bottomRight', 'topRight'],
  ];
  for (const [bottom, top] of verticalEdges) {
    if (corners[bottom] && corners[top] && width) {
      const edge = subtract(corners[top]!, corners[bottom]!);
      addCandidate(geometryFromAnchor(
        corners[bottom]!,
        CORNER_SIGNS[bottom],
        width,
        vectorLength(edge),
        Math.atan2(edge.y, edge.x) - Math.PI / 2,
      ));
    }
  }

  if (rotation !== undefined) {
    const oppositePairs: [CornerName, CornerName][] = [
      ['bottomLeft', 'topRight'],
      ['topLeft', 'bottomRight'],
    ];
    for (const [from, to] of oppositePairs) {
      if (!corners[from] || !corners[to]) {
        continue;
      }
      const localDiagonal = rotateVector(subtract(corners[to]!, corners[from]!), -rotation);
      addCandidate({
        center: scaleVector(add(corners[from]!, corners[to]!), 0.5),
        width: Math.abs(localDiagonal.x),
        height: Math.abs(localDiagonal.y),
        rotation,
      });
    }
  } else {
    const oppositePairs: [CornerName, CornerName][] = [
      ['bottomLeft', 'topRight'],
      ['topLeft', 'bottomRight'],
    ];
    for (const [first, second] of oppositePairs) {
      if (!corners[first] || !corners[second]) {
        continue;
      }
      const center = scaleVector(add(corners[first]!, corners[second]!), 0.5);
      addCandidate({
        center,
        width: Math.abs(corners[second]!.x - corners[first]!.x),
        height: Math.abs(corners[second]!.y - corners[first]!.y),
        rotation: 0,
      });
    }
  }

  const unique = candidates.filter((candidate, index) =>
    candidates.findIndex((other) =>
      vectorLength(subtract(candidate.center, other.center)) <= RECT_EPSILON
      && Math.abs(candidate.width - other.width) <= RECT_EPSILON
      && Math.abs(candidate.height - other.height) <= RECT_EPSILON
      && Math.abs(Math.atan2(
        Math.sin(candidate.rotation - other.rotation),
        Math.cos(candidate.rotation - other.rotation),
      )) <= RECT_EPSILON) === index);

  if (unique.length !== 1) {
    throw new Error(unique.length === 0
      ? `${elementName} position and size are underdetermined or conflicting`
      : `${elementName} definition is ambiguous`);
  }

  return unique[0];
}

function parseRectElement(value: unknown): RectElement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const rect = value as Record<string, unknown>;
  const geometry = resolveRectGeometry(rect);
  const opacity = clamp(asNumber(rect.opacity, 1), 0, 1);

  return {
    kind: 'rect',
    name: typeof rect.name === 'string' && rect.name.trim() ? rect.name.trim() : undefined,
    ...geometry,
    color: typeof rect.color === 'string'
      ? rect.color
      : typeof rect.fill === 'string' ? rect.fill : '#1d4ed8',
    opacity,
  };
}

function parseZoomElement(value: unknown, viewAspect: number): ZoomElement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const zoom = value as Record<string, unknown>;
  return {
    kind: 'zoom',
    name: typeof zoom.name === 'string' && zoom.name.trim() ? zoom.name.trim() : undefined,
    ...resolveRectGeometry(zoom, viewAspect, 'Zoom'),
    opacity: clamp(asNumber(zoom.opacity, 1), 0, 1),
  };
}

function parseElementCandidates<T>(
  candidates: unknown,
  parse: (candidate: unknown) => T | null,
): T[] {
  const values = Array.isArray(candidates) ? candidates : [candidates];
  return values.flatMap((candidate) => {
    const parsed = parse(candidate);
    return parsed ? [parsed] : [];
  });
}

function parseScene(text: string): SceneDefinition {
  const fallback = {
    background: '#ffffff',
    seed: {
      color: '#000000',
      opacity: 1,
    },
    hasFractal: false,
    view: {
      aspect: 1,
      resolution: { width: 1200, height: 1200 },
      coordinates: {
        x: { from: -100, to: 100 },
        y: { from: -100, to: 100 },
      },
    },
    fractal: {
      depth: 10,
      trunkLength: 90,
      branchAngle: 0.72,
      spread: 1.2,
      hueStart: 190,
    },
    elements: [] as DrawableElement[],
  };

  const rawText = text.trim();
  if (!rawText) {
    return {
      ...fallback,
      depth: fallback.fractal.depth,
      trunkLength: fallback.fractal.trunkLength,
      branchAngle: fallback.fractal.branchAngle,
      spread: fallback.fractal.spread,
      hueStart: fallback.fractal.hueStart,
    };
  }

  let parsed: unknown = null;
  try {
    parsed = YAML.parse(rawText);
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const sceneRoot = parsed as Record<string, unknown>;
    const background = typeof sceneRoot.background === 'string' ? sceneRoot.background : fallback.background;
    const viewNode = sceneRoot.view && typeof sceneRoot.view === 'object' && !Array.isArray(sceneRoot.view)
      ? (sceneRoot.view as Record<string, unknown>)
      : {};
    const resolvedView = resolveView(viewNode);
    const coordinatesNode = viewNode.coordinates && typeof viewNode.coordinates === 'object' && !Array.isArray(viewNode.coordinates)
      ? (viewNode.coordinates as Record<string, unknown>)
      : null;
    const coordinates = coordinatesNode
      ? {
          x: parseAxisRange(coordinatesNode.x, fallback.view.coordinates.x),
          y: parseAxisRange(coordinatesNode.y, fallback.view.coordinates.y),
        }
      : legacyCoordinates(viewNode.coordinateSystem, resolvedView.resolution) ?? fallback.view.coordinates;

    const sceneNode = sceneRoot.scene && typeof sceneRoot.scene === 'object' && !Array.isArray(sceneRoot.scene)
      ? (sceneRoot.scene as Record<string, unknown>)
      : {};
    const fractalNode = sceneNode.fractal && typeof sceneNode.fractal === 'object' && !Array.isArray(sceneNode.fractal)
      ? (sceneNode.fractal as Record<string, unknown>)
      : {};
    const seedNode = sceneNode.seed && typeof sceneNode.seed === 'object' && !Array.isArray(sceneNode.seed)
      ? (sceneNode.seed as Record<string, unknown>)
      : {};

    const fractal = {
      depth: Math.round(clamp(asNumber(fractalNode.depth ?? sceneRoot.depth, 10), 2, 15)),
      trunkLength: clamp(asNumber(fractalNode.trunkLength ?? sceneRoot.trunkLength, 90), 20, 180),
      branchAngle: clamp(asNumber(fractalNode.branchAngle ?? sceneRoot.branchAngle, 0.72), 0.3, 1.4),
      spread: clamp(asNumber(fractalNode.spread ?? sceneRoot.spread, 1.2), 0.8, 2),
      hueStart: ((asNumber(fractalNode.hueStart ?? sceneRoot.hueStart, 190) % 360) + 360) % 360,
    };

    const rectCandidates = sceneNode.rect !== undefined ? sceneNode.rect : sceneNode.rects ?? [];
    const zoomCandidates = sceneNode.zoom !== undefined ? sceneNode.zoom : sceneNode.zooms ?? [];
    const elements: DrawableElement[] = [
      ...parseElementCandidates(rectCandidates, parseRectElement),
      ...parseElementCandidates(zoomCandidates, (candidate) => parseZoomElement(candidate, resolvedView.aspect)),
    ];

    return {
      background,
      seed: {
        color: typeof sceneNode.seed === 'string'
          ? sceneNode.seed
          : typeof seedNode.color === 'string' ? seedNode.color : fallback.seed.color,
        opacity: clamp(asNumber(seedNode.opacity, fallback.seed.opacity), 0, 1),
      },
      hasFractal: Object.keys(fractalNode).length > 0,
      depth: fractal.depth,
      trunkLength: fractal.trunkLength,
      branchAngle: fractal.branchAngle,
      spread: fractal.spread,
      hueStart: fractal.hueStart,
      view: {
        ...resolvedView,
        coordinates,
      },
      fractal,
      elements,
    };
  }

  const values = new Map<string, number>();
  const maybeBackground = /^background\s*:\s*(.+)$/i;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const backgroundMatch = line.match(maybeBackground);
    if (backgroundMatch) {
      const value = backgroundMatch[1].trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        fallback.background = value.slice(1, -1);
      }
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const valueText = line.slice(separatorIndex + 1).trim();
    const value = Number.parseFloat(valueText);

    if (key && Number.isFinite(value)) {
      values.set(key, value);
    }
  }

  const parsedFractal = {
    depth: Math.round(clamp(values.get('depth') ?? 10, 2, 15)),
    trunkLength: clamp(values.get('trunkLength') ?? 90, 20, 180),
    branchAngle: clamp(values.get('branchAngle') ?? 0.72, 0.3, 1.4),
    spread: clamp(values.get('spread') ?? 1.2, 0.8, 2),
    hueStart: ((values.get('hueStart') ?? 190) % 360 + 360) % 360,
  };

  return {
    background: fallback.background,
    seed: fallback.seed,
    hasFractal: true,
    depth: parsedFractal.depth,
    trunkLength: parsedFractal.trunkLength,
    branchAngle: parsedFractal.branchAngle,
    spread: parsedFractal.spread,
    hueStart: parsedFractal.hueStart,
    view: {
      aspect: 1,
      resolution: { width: 1200, height: 1200 },
      coordinates: {
        x: { from: -100, to: 100 },
        y: { from: -100, to: 100 },
      },
    },
    fractal: parsedFractal,
    elements: [],
  };
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

const canvas = document.createElement('canvas');
const displayContext = canvas.getContext('2d')!;
let ctx = displayContext;

canvasHost.append(canvas);

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

const qualityRow = document.createElement('label');
qualityRow.className = 'quality-row';
qualityRow.innerHTML = '<span>Quality</span>';

const qualitySelect = document.createElement('select');
for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = preset.label;
  qualitySelect.append(option);
}
qualitySelect.value = 'balanced';
qualityRow.append(qualitySelect);

const qualityDetails = document.createElement('div');
qualityDetails.className = 'quality-details';

qualitySelect.addEventListener('change', () => {
  state.quality = qualitySelect.value as QualityPresetName;
  render();
});

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

const applySceneButton = document.createElement('button');
applySceneButton.type = 'button';
applySceneButton.className = 'apply-scene';
applySceneButton.textContent = 'Apply scene';

const sceneStatus = document.createElement('div');
sceneStatus.className = 'scene-status';
sceneStatus.setAttribute('role', 'status');

applySceneButton.addEventListener('click', () => {
  try {
    const nextScene = parseScene(sceneInput.value);
    state.scene = nextScene;
    sceneStatus.textContent = '';
    resizeCanvas();
    render();
  } catch (error) {
    sceneStatus.textContent = error instanceof Error ? error.message : 'Invalid scene definition';
  }
});

controls.append(
  qualityRow,
  qualityDetails,
  sceneInputLabel,
  sceneInput,
  applySceneButton,
  sceneStatus,
);
panel.append(panelHeader, controls, renderProgress, panelResizeHandle);
shell.append(panel, panelToggle, canvasHost);
app.append(shell);

const baseScene = parseScene(DEFAULT_SCENE_TEXT);
const state = {
  quality: 'balanced' as QualityPresetName,
  offsetX: 0,
  offsetY: -10,
  scene: baseScene,
};

function resizeCanvas() {
  const host = canvasHost.getBoundingClientRect();
  const resolution = state.scene.view.resolution;
  const displayScale = Math.min(host.width / resolution.width, host.height / resolution.height);

  canvas.width = resolution.width;
  canvas.height = resolution.height;
  canvas.style.width = `${resolution.width * displayScale}px`;
  canvas.style.height = `${resolution.height * displayScale}px`;
}

function makeBranch(start: Vec2, end: Vec2, depth: number): BranchNode {
  return { start, end, depth };
}

function scenePointToCanvas(point: Vec2, scene: SceneDefinition): Vec2 {
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

function elementCorners(element: RectGeometry, scene: SceneDefinition): Vec2[] {
  return (['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as CornerName[])
    .map((name) => scenePointToCanvas(rectCorner(element, name), scene));
}

function resolveRenderSettings(
  scene: SceneDefinition,
  preset: QualityPreset,
): RenderSettings {
  const zooms = scene.elements.filter((element): element is ZoomElement => element.kind === 'zoom');
  if (zooms.length === 0) {
    return {
      recursionDepth: 0,
      renderPasses: preset.renderPasses,
      supersampling: preset.supersampling,
    };
  }

  const coordinateWidth = Math.abs(scene.view.coordinates.x.to - scene.view.coordinates.x.from);
  const coordinateHeight = Math.abs(scene.view.coordinates.y.to - scene.view.coordinates.y.from);
  const workingWidth = scene.view.resolution.width * preset.supersampling;
  const workingHeight = scene.view.resolution.height * preset.supersampling;
  const largestZoomScale = Math.max(...zooms.map((zoom) => Math.max(
    zoom.width / coordinateWidth,
    zoom.height / coordinateHeight,
  )));
  let largestLeafPixels = Math.max(...zooms.map((zoom) => Math.max(
    zoom.width / coordinateWidth * workingWidth,
    zoom.height / coordinateHeight * workingHeight,
  )));
  let leafCount = zooms.length;
  let recursionDepth = 0;

  while (recursionDepth < 12 && largestLeafPixels > preset.minimumLeafPixels) {
    const nextLeafCount = leafCount * zooms.length;
    if (nextLeafCount > preset.maximumLeaves) {
      break;
    }
    recursionDepth += 1;
    leafCount = nextLeafCount;
    largestLeafPixels *= largestZoomScale;
  }

  return {
    recursionDepth,
    renderPasses: preset.renderPasses,
    supersampling: preset.supersampling,
  };
}

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
    const oversampled = document.createElement('canvas');
    oversampled.width = width * LEAF_RASTER_OVERSAMPLING;
    oversampled.height = height * LEAF_RASTER_OVERSAMPLING;
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
  settings: RenderSettings,
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
  drawScene(scene, settings, recursionLevel + 1, capturedScene);
  ctx.restore();
}

function drawBranch(branch: BranchNode, scene: SceneDefinition, angle: number, length: number) {
  const dx = branch.end.x - branch.start.x;
  const dy = branch.end.y - branch.start.y;
  const angleRadians = Math.atan2(dy, dx) + angle;
  const nextLength = length * 0.73;

  ctx.beginPath();
  ctx.moveTo(branch.start.x, branch.start.y);
  ctx.lineTo(branch.end.x, branch.end.y);
  ctx.strokeStyle = `hsla(${scene.hueStart + branch.depth * 10}, 70%, ${scene.depth > 2 ? 60 : 50}%, 0.9)`;
  ctx.lineWidth = Math.max(1, 2.4 - branch.depth * 0.12);
  ctx.stroke();

  if (branch.depth >= scene.depth) {
    return;
  }

  const spreadDirection = branch.depth % 2 === 0 ? 1 : -1;
  const leftEnd: Vec2 = {
    x: branch.end.x + Math.cos(angleRadians - scene.branchAngle) * nextLength,
    y: branch.end.y + Math.sin(angleRadians - scene.branchAngle) * nextLength,
  };

  const rightEnd: Vec2 = {
    x: branch.end.x + Math.cos(angleRadians + scene.branchAngle * (spreadDirection > 0 ? scene.spread : 1 / scene.spread)) * nextLength,
    y: branch.end.y + Math.sin(angleRadians + scene.branchAngle * (spreadDirection > 0 ? scene.spread : 1 / scene.spread)) * nextLength,
  };

  drawBranch(makeBranch(branch.end, leftEnd, branch.depth + 1), scene, -scene.branchAngle, nextLength);
  drawBranch(makeBranch(branch.end, rightEnd, branch.depth + 1), scene, scene.branchAngle * (spreadDirection > 0 ? scene.spread : 1 / scene.spread), nextLength);
}

function drawScene(
  scene: SceneDefinition,
  settings: RenderSettings,
  recursionLevel: number,
  capturedScene: CapturedScene | null,
) {
  for (const element of scene.elements) {
    if (element.kind === 'rect') {
      drawRectElement(element, scene);
    } else if (recursionLevel < settings.recursionDepth) {
      drawZoomElement(element, scene, settings, recursionLevel, capturedScene);
    } else if (capturedScene) {
      drawCapturedElement(element, scene, capturedScene);
    } else {
      drawSeedElement(element, scene);
    }
  }

  if (!scene.hasFractal) {
    return;
  }

  const viewWidth = scene.view.resolution.width;
  const viewHeight = scene.view.resolution.height;
  const baseStart: Vec2 = {
    x: viewWidth / 2 + state.offsetX,
    y: viewHeight * 0.82 + state.offsetY,
  };
  const baseEnd: Vec2 = {
    x: viewWidth / 2 + state.offsetX,
    y: viewHeight * 0.52 + state.offsetY,
  };

  drawBranch(makeBranch(baseStart, baseEnd, 0), scene, 0, scene.trunkLength);
}

function downsampleAlphaPreserving(source: HTMLCanvasElement): HTMLCanvasElement {
  const width = Math.max(1, Math.ceil(source.width / 2));
  const height = Math.max(1, Math.ceil(source.height / 2));
  const sourceContext = source.getContext('2d')!;
  const sourcePixels = sourceContext.getImageData(0, 0, source.width, source.height);
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const outputContext = output.getContext('2d')!;
  const outputPixels = outputContext.createImageData(width, height);

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
          const alpha = sourcePixels.data[sourceIndex + 3];
          maxAlpha = Math.max(maxAlpha, alpha);
          alphaTotal += alpha;
          red += sourcePixels.data[sourceIndex] * alpha;
          green += sourcePixels.data[sourceIndex + 1] * alpha;
          blue += sourcePixels.data[sourceIndex + 2] * alpha;
        }
      }

      const outputIndex = (y * width + x) * 4;
      if (alphaTotal > 0) {
        outputPixels.data[outputIndex] = Math.round(red / alphaTotal);
        outputPixels.data[outputIndex + 1] = Math.round(green / alphaTotal);
        outputPixels.data[outputIndex + 2] = Math.round(blue / alphaTotal);
        outputPixels.data[outputIndex + 3] = maxAlpha;
      }
    }
  }

  outputContext.putImageData(outputPixels, 0, 0);
  return output;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function captureCanvas(
  source: HTMLCanvasElement,
  onLevel: () => Promise<boolean>,
): Promise<CapturedScene | null> {
  const fullResolution = document.createElement('canvas');
  fullResolution.width = source.width;
  fullResolution.height = source.height;
  fullResolution.getContext('2d')!.drawImage(source, 0, 0);

  const levels = [fullResolution];
  while (levels.at(-1)!.width > 1 || levels.at(-1)!.height > 1) {
    levels.push(downsampleAlphaPreserving(levels.at(-1)!));
    if (!await onLevel()) {
      return null;
    }
  }

  return {
    width: fullResolution.width,
    height: fullResolution.height,
    levels,
    leafRasters: new Map(),
  };
}

function renderPass(
  target: HTMLCanvasElement,
  scene: SceneDefinition,
  settings: RenderSettings,
  capturedScene: CapturedScene | null,
) {
  ctx = target.getContext('2d')!;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.save();
  ctx.scale(settings.supersampling, settings.supersampling);

  drawScene(scene, settings, 0, capturedScene);
  ctx.restore();
}

function displayWorkingCanvas(workingCanvas: HTMLCanvasElement) {
  ctx = displayContext;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(workingCanvas, 0, 0, canvas.width, canvas.height);
}

let renderRevision = 0;
let rendererIsRunning = false;

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

function mipLevelCount(width: number, height: number): number {
  return Math.ceil(Math.log2(Math.max(width, height)));
}

async function renderScene(scene: SceneDefinition, revision: number): Promise<boolean> {
  const preset = QUALITY_PRESETS[state.quality];
  const settings = resolveRenderSettings(scene, preset);
  qualityDetails.textContent = `Depth ${settings.recursionDepth} · ${settings.renderPasses} passes · ${settings.supersampling}×`;
  canvasHost.style.backgroundColor = scene.background;
  const workingCanvas = document.createElement('canvas');
  workingCanvas.width = scene.view.resolution.width * settings.supersampling;
  workingCanvas.height = scene.view.resolution.height * settings.supersampling;
  const mipLevels = mipLevelCount(workingCanvas.width, workingCanvas.height);
  const totalSteps = settings.renderPasses + (settings.renderPasses - 1) * mipLevels;
  let completedSteps = 0;
  const advance = async () => {
    completedSteps += 1;
    setRenderProgress(completedSteps / totalSteps);
    await nextFrame();
    return revision === renderRevision;
  };

  let capturedScene: CapturedScene | null = null;
  for (let pass = 0; pass < settings.renderPasses; pass += 1) {
    renderPass(workingCanvas, scene, settings, capturedScene);
    if (revision !== renderRevision) {
      return false;
    }
    displayWorkingCanvas(workingCanvas);
    if (!await advance()) {
      return false;
    }
    if (pass < settings.renderPasses - 1) {
      capturedScene = await captureCanvas(workingCanvas, advance);
      if (!capturedScene) {
        return false;
      }
    }
  }

  return true;
}

async function runRenderer() {
  if (rendererIsRunning) {
    return;
  }

  rendererIsRunning = true;
  setRenderProgress(0);
  await nextFrame();

  while (true) {
    const revision = renderRevision;
    const completed = await renderScene(state.scene, revision);
    if (completed && revision === renderRevision) {
      break;
    }
  }

  setRenderProgress(null);
  rendererIsRunning = false;
}

function render() {
  renderRevision += 1;
  void runRenderer();
}

window.addEventListener('resize', () => {
  resizeCanvas();
  render();
});

resizeCanvas();
render();
