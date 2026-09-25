import './style.css';
import YAML from 'yaml';
import {
  DEFAULT_EXAMPLE,
  EXAMPLES,
  findExample,
} from './examples';

type Vec2 = {
  x: number;
  y: number;
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
  alignTargets: Vec2[];
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

type DefinitionLocation =
  | { kind: 'example'; id: string }
  | { kind: 'source'; url: string }
  | { kind: 'custom' };

type FrameDefinition = {
  width: number;
  radius: number;
  color: string;
  wall: string;
  background: string;
  padding: number;
  margin: number;
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
  frame: FrameDefinition;
  seed: {
    color: string;
    opacity: number;
  };
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
  elements: DrawableElement[];
};

const DEFAULT_SCENE_TEXT = DEFAULT_EXAMPLE.text;
const REMOTE_DEFINITION_TIMEOUT_MS = 10_000;
const REMOTE_DEFINITION_MAX_BYTES = 512 * 1024;

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

function asNonNegativeNumber(value: unknown, fallback: number): number {
  const number = asNumber(value, fallback);
  return number >= 0 ? number : fallback;
}

function resolveView(view: Record<string, unknown>) {
  const resolutionNode = view.resolution && typeof view.resolution === 'object' && !Array.isArray(view.resolution)
    ? (view.resolution as Record<string, unknown>)
    : {};
  const requestedWidth = asPositiveNumber(resolutionNode.width);
  const requestedHeight = asPositiveNumber(resolutionNode.height);
  const requestedAspect = parseAspectRatio(view.aspect);

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

type CornerName = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft';

type RectGeometry = Pick<RectElement, 'center' | 'width' | 'height' | 'rotation'>;

type PointPart = CornerName | 'centre' | 'top' | 'bottom' | 'left' | 'right';

type PointResolver = (value: unknown, label: string) => Vec2 | undefined;

// Signed extents: width and height are negative when an axis runs backwards.
type ViewFrame = {
  centre: Vec2;
  width: number;
  height: number;
};

type AlignPair = {
  from: Vec2;
  to: Vec2;
};

type ZoomConstraints = {
  aspect: number;
  view: ViewFrame;
  align: AlignPair[];
};

const CORNER_SIGNS: Record<CornerName, Vec2> = {
  topLeft: { x: -1, y: 1 },
  topRight: { x: 1, y: 1 },
  bottomRight: { x: 1, y: -1 },
  bottomLeft: { x: -1, y: -1 },
};

const POINT_SIGNS: Record<PointPart, Vec2> = {
  ...CORNER_SIGNS,
  centre: { x: 0, y: 0 },
  top: { x: 0, y: 1 },
  bottom: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const isPointPart = (value: string): value is PointPart => Object.hasOwn(POINT_SIGNS, value);

const CORNER_NAMES = Object.keys(CORNER_SIGNS) as CornerName[];
const RECT_EPSILON = 1e-6;
const LEAF_RASTER_OVERSAMPLING = 2;
const EDIT_MODE_ZOOM_OPACITY = 0.6;
const EDIT_MODE_OUTLINE_CSS_PIXELS = 1.5;

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

// Scene rotations are clockwise; internal geometry uses anticlockwise radians.
function parseRotation(value: unknown): number | undefined {
  const angle = parseAngle(value);
  return angle === undefined ? undefined : -angle;
}

function parseAngle(value: unknown): number | undefined {
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

function rectPoint(geometry: RectGeometry, part: PointPart): Vec2 {
  const sign = POINT_SIGNS[part];
  return add(
    geometry.center,
    rotateVector({
      x: sign.x * geometry.width / 2,
      y: sign.y * geometry.height / 2,
    }, geometry.rotation),
  );
}

function rectCorner(geometry: RectGeometry, name: CornerName): Vec2 {
  return rectPoint(geometry, name);
}

function viewPoint(view: ViewFrame, part: PointPart): Vec2 {
  const sign = POINT_SIGNS[part];
  return {
    x: view.centre.x + sign.x * view.width / 2,
    y: view.centre.y + sign.y * view.height / 2,
  };
}

// Offset from a zoom's centre to where a source-scene point lands inside it.
function zoomOffset(point: Vec2, view: ViewFrame, width: number, height: number, rotation: number): Vec2 {
  return rotateVector({
    x: (point.x - view.centre.x) / view.width * width,
    y: (point.y - view.centre.y) / view.height * height,
  }, rotation);
}

function isPointLike(value: unknown): boolean {
  if (typeof value === 'string') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 2 && value.every((part) => Number.isFinite(asNumber(part, Number.NaN)));
  }
  return Boolean(value) && typeof value === 'object';
}

function parseAlignPairs(
  value: unknown,
  resolvePoint: PointResolver,
  elementName: string,
): AlignPair[] {
  const toPair = (pair: unknown, label: string): AlignPair => {
    const [fromValue, toValue] = Array.isArray(pair) && pair.length === 2
      ? pair
      : pair && typeof pair === 'object' && !Array.isArray(pair)
        ? [(pair as Record<string, unknown>).from, (pair as Record<string, unknown>).to]
        : [undefined, undefined];
    const from = resolvePoint(fromValue, `${label} from`);
    const to = resolvePoint(toValue, `${label} to`);
    if (!from || !to) {
      throw new Error(`${label} must be [from, to] or { from, to }`);
    }
    return { from, to };
  };

  const label = `${elementName} align`;
  const isSinglePair = Array.isArray(value) && value.length === 2 && isPointLike(value[0]);
  const isObjectPair = Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (isSinglePair || isObjectPair) {
    return [toPair(value, label)];
  }
  if (Array.isArray(value) && value.length === 2) {
    return value.map((pair, index) => toPair(pair, `${label} pair ${index + 1}`));
  }
  throw new Error(`${label} must be one [from, to] pair or a list of two pairs`);
}

function geometryFromAlignPairs(
  [first, second]: AlignPair[],
  view: ViewFrame,
  elementName: string,
): RectGeometry {
  const source = subtract(second.from, first.from);
  const target = subtract(second.to, first.to);
  const sourceLength = vectorLength(source);
  const targetLength = vectorLength(target);
  if (sourceLength <= RECT_EPSILON || targetLength <= RECT_EPSILON) {
    throw new Error(`${elementName} align pairs must use two distinct from points and two distinct to points`);
  }

  const scale = targetLength / sourceLength;
  const width = scale * Math.abs(view.width);
  const height = scale * Math.abs(view.height);
  const orientedSource = {
    x: source.x * Math.sign(view.width),
    y: source.y * Math.sign(view.height),
  };
  const rotation = Math.atan2(target.y, target.x) - Math.atan2(orientedSource.y, orientedSource.x);
  return {
    center: subtract(first.to, zoomOffset(first.from, view, width, height, rotation)),
    width,
    height,
    rotation,
  };
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
  resolvePoint: PointResolver,
  elementName: string,
  zoom?: ZoomConstraints,
): RectGeometry {
  let center = resolvePoint(rect.centre, `${elementName} centre`);
  const corners = Object.fromEntries(
    CORNER_NAMES
      .map((name) => [name, resolvePoint(rect[name], `${elementName} ${name}`)] as const)
      .filter((entry): entry is [CornerName, Vec2] => Boolean(entry[1])),
  ) as Partial<Record<CornerName, Vec2>>;
  let width = asPositiveNumber(rect.width);
  let height = asPositiveNumber(rect.height);
  if (zoom && rect.scale !== undefined) {
    const scale = asPositiveNumber(rect.scale);
    if (!scale) {
      throw new Error(`${elementName} scale must be a positive number`);
    }
    if (width || height) {
      throw new Error(`${elementName} must use either scale or width/height, not both`);
    }
    width = scale * Math.abs(zoom.view.width);
    height = scale * Math.abs(zoom.view.height);
  }
  if (zoom && width && !height) {
    height = width / zoom.aspect;
  } else if (zoom && height && !width) {
    width = height * zoom.aspect;
  }
  let rotation = parseRotation(rect.rotation);
  if (rect.rotation !== undefined && rotation === undefined) {
    throw new Error(`${elementName} rotation must be degrees, "<angle>deg", "<angle>rad", or a unit object`);
  }

  if (zoom?.align.length === 2) {
    const aligned = geometryFromAlignPairs(zoom.align, zoom.view, elementName);
    if (!geometryMatches(aligned, center, corners, width, height, rotation)) {
      throw new Error(`${elementName} align conflicts with its other constraints`);
    }
    return aligned;
  }

  if (zoom?.align.length === 1) {
    if (!width || !height) {
      throw new Error(`${elementName} align needs scale, width, or height`);
    }
    rotation ??= 0;
    const [{ from, to }] = zoom.align;
    const alignedCenter = subtract(to, zoomOffset(from, zoom.view, width, height, rotation));
    if (center && vectorLength(subtract(center, alignedCenter)) > RECT_EPSILON) {
      throw new Error(`${elementName} align conflicts with its centre`);
    }
    center = alignedCenter;
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

function parseRectElement(
  rect: Record<string, unknown>,
  name: string | undefined,
  elementName: string,
  resolvePoint: PointResolver,
): RectElement {
  if (rect.scale !== undefined || rect.align !== undefined) {
    throw new Error(`${elementName}: scale and align are only supported on zooms`);
  }
  const geometry = resolveRectGeometry(rect, resolvePoint, elementName);
  const opacity = clamp(asNumber(rect.opacity, 1), 0, 1);

  return {
    kind: 'rect',
    name,
    ...geometry,
    color: typeof rect.color === 'string' ? rect.color : '#000',
    opacity,
  };
}

function parseZoomElement(
  zoom: Record<string, unknown>,
  name: string | undefined,
  elementName: string,
  resolvePoint: PointResolver,
  aspect: number,
  view: ViewFrame,
): ZoomElement {
  const align = zoom.align === undefined ? [] : parseAlignPairs(zoom.align, resolvePoint, elementName);
  return {
    kind: 'zoom',
    name,
    ...resolveRectGeometry(zoom, resolvePoint, elementName, { aspect, view, align }),
    opacity: clamp(asNumber(zoom.opacity, 1), 0, 1),
    alignTargets: align.map((pair) => pair.to),
  };
}

type SceneItem = {
  record: Record<string, unknown>;
  type: string;
  name?: string;
  label: string;
};

function parseSceneItems(values: unknown[]): SceneItem[] {
  const names = new Set<string>();
  return values.map((value, index) => {
    const itemNumber = index + 1;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Scene item ${itemNumber} must be an object`);
    }

    const record = value as Record<string, unknown>;
    if (typeof record.type !== 'string' || !record.type.trim()) {
      throw new Error(`Scene item ${itemNumber} must have a type`);
    }
    if (record.type !== 'rect' && record.type !== 'zoom') {
      throw new Error(`Scene item ${itemNumber} has unknown type: ${record.type}`);
    }

    let name: string | undefined;
    if (record.name !== undefined) {
      if (typeof record.name !== 'string' || !record.name.trim()) {
        throw new Error(`Scene item ${itemNumber} name must be a non-blank string`);
      }
      name = record.name.trim();
      if (name === 'view') {
        throw new Error(`Scene item ${itemNumber} cannot be named "view"; it is reserved`);
      }
      if (/[.\s]/.test(name)) {
        throw new Error(`Scene item ${itemNumber} name "${name}" cannot contain dots or spaces`);
      }
      if (names.has(name)) {
        throw new Error(`Scene item name "${name}" is used more than once`);
      }
      names.add(name);
    }

    const kind = record.type === 'rect' ? 'Rectangle' : 'Zoom';
    return {
      record,
      type: record.type,
      name,
      label: name ? `${kind} "${name}"` : `${kind} ${itemNumber}`,
    };
  });
}

function resolveSceneElements(
  items: SceneItem[],
  aspect: number,
  view: ViewFrame,
): DrawableElement[] {
  const indexByName = new Map(items.flatMap((item, index) => item.name ? [[item.name, index] as const] : []));
  const resolved: (DrawableElement | undefined)[] = [];
  const resolving = new Set<number>();

  const pointResolverFor = (ownIndex: number): PointResolver => (value, label) => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      const point = parsePoint(value);
      if (!point) {
        throw new Error(`${label} must be [x, y], { x, y }, or a name.part reference`);
      }
      return point;
    }

    const match = value.trim().match(/^([^.\s]+)\.([A-Za-z]+)$/);
    if (!match) {
      throw new Error(`${label} reference "${value}" must look like name.part`);
    }
    const [, name, part] = match;
    if (!isPointPart(part)) {
      throw new Error(`${label} reference "${value}" has unknown part "${part}"`);
    }
    if (name === 'view') {
      return viewPoint(view, part);
    }
    const target = indexByName.get(name);
    if (target === undefined) {
      throw new Error(`${label} refers to unknown element "${name}"`);
    }
    if (target === ownIndex) {
      throw new Error(`${label} cannot refer to its own element`);
    }
    return rectPoint(resolveElement(target), part);
  };

  const resolveElement = (index: number): DrawableElement => {
    const existing = resolved[index];
    if (existing) {
      return existing;
    }
    const item = items[index];
    if (resolving.has(index)) {
      throw new Error(`${item.label} is part of a reference loop`);
    }

    resolving.add(index);
    const resolvePoint = pointResolverFor(index);
    const element = item.type === 'rect'
      ? parseRectElement(item.record, item.name, item.label, resolvePoint)
      : parseZoomElement(item.record, item.name, item.label, resolvePoint, aspect, view);
    resolving.delete(index);
    resolved[index] = element;
    return element;
  };

  return items.map((_, index) => resolveElement(index));
}

function parseScene(text: string): SceneDefinition {
  const fallback = {
    frame: {
      width: 12,
      radius: 6,
      color: '#444',
      wall: '#ddd',
      background: '#fff',
      padding: 12,
      margin: 24,
    },
    seed: {
      color: 'transparent',
      opacity: 1,
    },
    view: {
      aspect: 1,
      resolution: { width: 1200, height: 1200 },
      coordinates: {
        x: { from: -100, to: 100 },
        y: { from: -100, to: 100 },
      },
    },
    elements: [] as DrawableElement[],
  };

  const rawText = text.trim();
  if (!rawText) {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(rawText);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid YAML');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Scene definition must be a YAML object');
  }

  const sceneRoot = parsed as Record<string, unknown>;
  const frameNode = sceneRoot.frame && typeof sceneRoot.frame === 'object' && !Array.isArray(sceneRoot.frame)
    ? (sceneRoot.frame as Record<string, unknown>)
    : {};
    const frame: FrameDefinition = {
      width: asNonNegativeNumber(frameNode.width, fallback.frame.width),
      radius: asNonNegativeNumber(frameNode.radius, fallback.frame.radius),
      color: typeof frameNode.color === 'string' ? frameNode.color : fallback.frame.color,
      wall: typeof frameNode.wall === 'string' ? frameNode.wall : fallback.frame.wall,
      background: typeof frameNode.background === 'string' ? frameNode.background : fallback.frame.background,
      padding: asNonNegativeNumber(frameNode.padding, fallback.frame.padding),
      margin: asNonNegativeNumber(frameNode.margin, fallback.frame.margin),
    };
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
      : fallback.view.coordinates;

    if (!Array.isArray(sceneRoot.scene)) {
      throw new Error('scene must be a list of typed items');
    }
    if (
      sceneRoot.seed !== undefined
      && typeof sceneRoot.seed !== 'string'
      && (!sceneRoot.seed || typeof sceneRoot.seed !== 'object' || Array.isArray(sceneRoot.seed))
    ) {
      throw new Error('seed must be a colour string or an object');
    }
    const seedNode = sceneRoot.seed && typeof sceneRoot.seed === 'object' && !Array.isArray(sceneRoot.seed)
      ? (sceneRoot.seed as Record<string, unknown>)
      : {};
    const viewFrame: ViewFrame = {
      centre: {
        x: (coordinates.x.from + coordinates.x.to) / 2,
        y: (coordinates.y.from + coordinates.y.to) / 2,
      },
      width: coordinates.x.to - coordinates.x.from,
      height: coordinates.y.to - coordinates.y.from,
    };
    const elements = resolveSceneElements(
      parseSceneItems(sceneRoot.scene),
      resolvedView.aspect,
      viewFrame,
    );

    return {
      frame,
      seed: {
        color: typeof sceneRoot.seed === 'string'
          ? sceneRoot.seed
          : typeof seedNode.color === 'string' ? seedNode.color : fallback.seed.color,
        opacity: clamp(asNumber(seedNode.opacity, fallback.seed.opacity), 0, 1),
      },
      view: {
        ...resolvedView,
        coordinates,
      },
      elements,
    };
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
let ctx = displayContext;

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

exampleSelect.addEventListener('change', () => {
  const example = findExample(exampleSelect.value);
  if (!example) {
    exampleDetails.textContent = 'Custom definition';
    return;
  }
  void loadDefinitionLocation({ kind: 'example', id: example.id }, true);
});

controls.append(
  qualityRow,
  qualityDetails,
  exampleRow,
  exampleDetails,
  sceneInputLabel,
  sceneInput,
  editModeRow,
  applySceneButton,
  sceneStatus,
);
panel.append(panelHeader, controls, renderProgress, panelResizeHandle);
shell.append(panel, panelToggle, canvasHost);
app.append(shell);

const baseScene = parseScene(DEFAULT_SCENE_TEXT);
const state = {
  quality: 'balanced' as QualityPresetName,
  editMode: false,
  offsetX: 0,
  offsetY: -10,
  scene: baseScene,
  definitionLocation: { kind: 'example', id: DEFAULT_EXAMPLE.id } as DefinitionLocation,
};
let definitionLoadRevision = 0;

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

  canvas.width = resolution.width;
  canvas.height = resolution.height;
  canvas.style.width = `${resolution.width * displayScale}px`;
  canvas.style.height = `${resolution.height * displayScale}px`;
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

function drawScene(
  scene: SceneDefinition,
  settings: RenderSettings,
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
    if (recursionLevel < settings.recursionDepth) {
      drawZoomElement(element, scene, settings, recursionLevel, capturedScene);
    } else if (capturedScene) {
      drawCapturedElement(element, scene, capturedScene);
    } else {
      drawSeedElement(element, scene);
    }
    ctx.restore();
  }
}

function drawZoomOutlines(scene: SceneDefinition) {
  const cssWidth = canvas.getBoundingClientRect().width;
  const pixelsPerCssPixel = cssWidth > 0 ? canvas.width / cssWidth : 1;
  const lineWidth = EDIT_MODE_OUTLINE_CSS_PIXELS * pixelsPerCssPixel;
  const zooms = scene.elements.filter((element): element is ZoomElement => element.kind === 'zoom');

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineJoin = 'miter';
  for (const zoom of zooms) {
    const corners = elementCorners(zoom, scene);
    tracePolygon(corners);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = lineWidth * 3;
    ctx.stroke();
    ctx.setLineDash([lineWidth * 4, lineWidth * 3]);
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(corners[0].x, corners[0].y, lineWidth * 3, 0, Math.PI * 2);
    ctx.fillStyle = '#e11d48';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    for (const target of zoom.alignTargets.map((point) => scenePointToCanvas(point, scene))) {
      const size = lineWidth * 5;
      ctx.beginPath();
      ctx.moveTo(target.x - size, target.y);
      ctx.lineTo(target.x + size, target.y);
      ctx.moveTo(target.x, target.y - size);
      ctx.lineTo(target.x, target.y + size);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = lineWidth * 3;
      ctx.stroke();
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }
  ctx.restore();
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
  fadeZooms = false,
) {
  ctx = target.getContext('2d')!;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.save();
  ctx.scale(settings.supersampling, settings.supersampling);

  drawScene(scene, settings, 0, capturedScene, fadeZooms);
  ctx.restore();
}

function displayWorkingCanvas(
  workingCanvas: HTMLCanvasElement,
  scene: SceneDefinition,
  editMode: boolean,
) {
  ctx = displayContext;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(workingCanvas, 0, 0, canvas.width, canvas.height);
  if (editMode) {
    drawZoomOutlines(scene);
  }
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
  const editMode = state.editMode;
  const workingCanvas = document.createElement('canvas');
  workingCanvas.width = scene.view.resolution.width * settings.supersampling;
  workingCanvas.height = scene.view.resolution.height * settings.supersampling;
  // Captures feed deeper recursion, so edit-mode fading uses a separate display-only pass.
  const editCanvas = editMode ? document.createElement('canvas') : null;
  if (editCanvas) {
    editCanvas.width = workingCanvas.width;
    editCanvas.height = workingCanvas.height;
  }
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
    const needsCapture = pass < settings.renderPasses - 1;
    if (!editCanvas || needsCapture) {
      renderPass(workingCanvas, scene, settings, capturedScene);
    }
    if (editCanvas) {
      renderPass(editCanvas, scene, settings, capturedScene, true);
    }
    if (revision !== renderRevision) {
      return false;
    }
    displayWorkingCanvas(editCanvas ?? workingCanvas, scene, editMode);
    if (!await advance()) {
      return false;
    }
    if (needsCapture) {
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

window.addEventListener('popstate', () => {
  void loadDefinitionFromAddressBar();
});

resizeCanvas();
render();
void loadDefinitionFromAddressBar();
