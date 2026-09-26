import YAML from 'yaml';
import { evaluateExpression, isIdentifier, isReservedName, type Variables } from './expression';

export type Vec2 = {
  x: number;
  y: number;
};

type SceneElement = {
  name?: string;
};

export type RectElement = SceneElement & {
  kind: 'rect';
  center: Vec2;
  width: number;
  height: number;
  rotation: number;
  color: string;
  opacity: number;
  // Hits added per covered pixel in density shading.
  weight: number;
};

export type ZoomElement = SceneElement & {
  kind: 'zoom';
  center: Vec2;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  alignTargets: Vec2[];
};

export type DrawableElement = RectElement | ZoomElement;

export type AxisRange = {
  from: number;
  to: number;
};

export type FrameDefinition = {
  width: number;
  radius: number;
  color: string;
  wall: string;
  background: string;
  padding: number;
  margin: number;
};

export type DensityScale = 'log' | 'sqrt' | 'linear';

// A gradient stop is placed either at an absolute hit count or at a fraction
// of the way along the scaled range, up to the normalising count.
export type ColorStop = {
  at: { kind: 'count'; value: number } | { kind: 'fraction'; value: number };
  color: string;
};

// Paint draws coloured shapes. Density counts how many copies of the shapes
// cover each pixel and colours pixels by that count.
export type Shading =
  | { mode: 'paint' }
  | { mode: 'density'; scale: DensityScale; colors: ColorStop[] };

export const MAXIMUM_DENSITY_COLORS = 8;
const DEFAULT_DENSITY_COLORS = ['#fef3c7', '#c2410c', '#1c1917'];

const evenStops = (colors: string[]): ColorStop[] => colors.map((color, index) => ({
  at: { kind: 'fraction', value: index / (colors.length - 1) },
  color,
}));

function parseStopPosition(key: string): ColorStop['at'] {
  const percent = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(key);
  if (percent) {
    const value = Number(percent[1]);
    if (value > 100) {
      throw new Error(`shading colors position "${key}" must be at most 100%`);
    }
    return { kind: 'fraction', value: value / 100 };
  }
  const count = Number(key);
  if (key.trim() === '' || !Number.isFinite(count) || count < 0) {
    throw new Error(`shading colors position "${key}" must be a hit count or a percentage such as 50%`);
  }
  return { kind: 'count', value: count };
}

// Colours are a list spread evenly, or a mapping from hit counts or
// percentages to colours.
function parseColorStops(colors: unknown): ColorStop[] {
  const range = `2 to ${MAXIMUM_DENSITY_COLORS}`;
  if (Array.isArray(colors)) {
    if (colors.length < 2 || colors.length > MAXIMUM_DENSITY_COLORS || !colors.every((color) => typeof color === 'string')) {
      throw new Error(`shading colors must be a list of ${range} colours`);
    }
    return evenStops(colors);
  }
  if (!colors || typeof colors !== 'object') {
    throw new Error(`shading colors must be a list or mapping of ${range} colours`);
  }
  const entries = Object.entries(colors);
  if (entries.length < 2 || entries.length > MAXIMUM_DENSITY_COLORS) {
    throw new Error(`shading colors must map ${range} positions to colours`);
  }
  return entries.map(([key, color]) => {
    if (typeof color !== 'string') {
      throw new Error(`shading colors position "${key}" must have a colour`);
    }
    return { at: parseStopPosition(key), color };
  });
}

export type SceneDefinition = {
  shading: Shading;
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

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

// Numeric values may be written as expressions such as `1/sqrt(2)`. Missing
// values use the fallback, but an invalid expression is always an error.
function asNumber(value: unknown, fallback: number, variables: Variables): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    return evaluateExpression(value, variables);
  }

  return fallback;
}

const isNumeric = (value: unknown, variables: Variables) => {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'string') {
    return false;
  }
  try {
    evaluateExpression(value, variables);
    return true;
  } catch {
    return false;
  }
};

function parseAspectRatio(value: unknown, variables: Variables): number {
  const ratio = asNumber(value, 1, variables);
  return ratio > 0 ? ratio : 1;
}

function asPositiveNumber(value: unknown, variables: Variables): number | undefined {
  const number = asNumber(value, Number.NaN, variables);
  return number > 0 ? number : undefined;
}

function asNonNegativeNumber(value: unknown, fallback: number, variables: Variables): number {
  const number = asNumber(value, fallback, variables);
  return number >= 0 ? number : fallback;
}

function resolveView(view: Record<string, unknown>, variables: Variables) {
  const resolutionNode = view.resolution && typeof view.resolution === 'object' && !Array.isArray(view.resolution)
    ? (view.resolution as Record<string, unknown>)
    : {};
  const requestedWidth = asPositiveNumber(resolutionNode.width, variables);
  const requestedHeight = asPositiveNumber(resolutionNode.height, variables);
  const requestedAspect = parseAspectRatio(view.aspect, variables);

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

function parseAxisRange(value: unknown, fallback: AxisRange, variables: Variables): AxisRange {
  let from: number;
  let to: number;

  if (Array.isArray(value)) {
    from = asNumber(value[0], fallback.from, variables);
    to = asNumber(value[1], fallback.to, variables);
  } else if (value && typeof value === 'object') {
    const range = value as Record<string, unknown>;
    from = asNumber(range.from ?? range.min, fallback.from, variables);
    to = asNumber(range.to ?? range.max, fallback.to, variables);
  } else {
    return fallback;
  }

  return from === to ? fallback : { from, to };
}

export type CornerName = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft';

export type RectGeometry = Pick<RectElement, 'center' | 'width' | 'height' | 'rotation'>;

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

const add = (left: Vec2, right: Vec2): Vec2 => ({ x: left.x + right.x, y: left.y + right.y });
export const subtract = (left: Vec2, right: Vec2): Vec2 => ({ x: left.x - right.x, y: left.y - right.y });
export const scaleVector = (vector: Vec2, scale: number): Vec2 => ({ x: vector.x * scale, y: vector.y * scale });
export const vectorLength = (vector: Vec2) => Math.hypot(vector.x, vector.y);
const rotateVector = (vector: Vec2, angle: number): Vec2 => ({
  x: vector.x * Math.cos(angle) - vector.y * Math.sin(angle),
  y: vector.x * Math.sin(angle) + vector.y * Math.cos(angle),
});

function parsePoint(value: unknown, variables: Variables): Vec2 | undefined {
  if (Array.isArray(value) && value.length >= 2) {
    const x = asNumber(value[0], Number.NaN, variables);
    const y = asNumber(value[1], Number.NaN, variables);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }

  if (value && typeof value === 'object') {
    const point = value as Record<string, unknown>;
    const x = asNumber(point.x, Number.NaN, variables);
    const y = asNumber(point.y, Number.NaN, variables);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  }

  return undefined;
}

// Scene rotations are clockwise; internal geometry uses anticlockwise radians.
function parseRotation(value: unknown, variables: Variables): number | undefined {
  const angle = parseAngle(value, variables);
  return angle === undefined ? undefined : -angle;
}

function parseAngle(value: unknown, variables: Variables): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value * Math.PI / 180;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rotation = value as Record<string, unknown>;
    const radians = asNumber(rotation.radians ?? rotation.rad, Number.NaN, variables);
    if (Number.isFinite(radians)) {
      return radians;
    }
    const degrees = asNumber(rotation.degrees ?? rotation.deg, Number.NaN, variables);
    return Number.isFinite(degrees) ? degrees * Math.PI / 180 : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  // An expression is in degrees unless it ends with a deg or rad unit.
  const match = value.trim().match(/^(.*?)\s*(deg|rad)$/);
  const angle = evaluateExpression(match ? match[1] : value, variables);
  return match?.[2] === 'rad' ? angle : angle * Math.PI / 180;
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

export function rectCorner(geometry: RectGeometry, name: CornerName): Vec2 {
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

function isPointLike(value: unknown, variables: Variables): boolean {
  if (typeof value === 'string') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 2 && value.every((part) => isNumeric(part, variables));
  }
  return Boolean(value) && typeof value === 'object';
}

function parseAlignPairs(
  value: unknown,
  resolvePoint: PointResolver,
  elementName: string,
  variables: Variables,
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
  const isSinglePair = Array.isArray(value) && value.length === 2 && isPointLike(value[0], variables);
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
  variables: Variables,
  zoom?: ZoomConstraints,
): RectGeometry {
  let center = resolvePoint(rect.centre, `${elementName} centre`);
  const corners = Object.fromEntries(
    CORNER_NAMES
      .map((name) => [name, resolvePoint(rect[name], `${elementName} ${name}`)] as const)
      .filter((entry): entry is [CornerName, Vec2] => Boolean(entry[1])),
  ) as Partial<Record<CornerName, Vec2>>;
  let width = asPositiveNumber(rect.width, variables);
  let height = asPositiveNumber(rect.height, variables);
  if (zoom && rect.scale !== undefined) {
    const scale = asPositiveNumber(rect.scale, variables);
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
  let rotation = parseRotation(rect.rotation, variables);
  if (rect.rotation !== undefined && rotation === undefined) {
    throw new Error(`${elementName} rotation must be degrees, an expression with an optional deg or rad unit, or a unit object`);
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
  variables: Variables,
  density: boolean,
): RectElement {
  if (rect.scale !== undefined || rect.align !== undefined) {
    throw new Error(`${elementName}: scale and align are only supported on zooms`);
  }
  if (density && (rect.color !== undefined || rect.opacity !== undefined)) {
    throw new Error(`${elementName}: color and opacity are not used with density shading; use weight instead`);
  }
  if (!density && rect.weight !== undefined) {
    throw new Error(`${elementName}: weight is only used with density shading`);
  }
  const weight = rect.weight === undefined ? 1 : asPositiveNumber(rect.weight, variables);
  if (!weight) {
    throw new Error(`${elementName} weight must be a positive number`);
  }
  const geometry = resolveRectGeometry(rect, resolvePoint, elementName, variables);
  const opacity = clamp(asNumber(rect.opacity, 1, variables), 0, 1);

  return {
    kind: 'rect',
    name,
    ...geometry,
    color: typeof rect.color === 'string' ? rect.color : '#000',
    opacity,
    weight,
  };
}

function parseZoomElement(
  zoom: Record<string, unknown>,
  name: string | undefined,
  elementName: string,
  resolvePoint: PointResolver,
  aspect: number,
  view: ViewFrame,
  variables: Variables,
  density: boolean,
): ZoomElement {
  if (density && zoom.opacity !== undefined) {
    throw new Error(`${elementName}: opacity is not used with density shading`);
  }
  const align = zoom.align === undefined ? [] : parseAlignPairs(zoom.align, resolvePoint, elementName, variables);
  return {
    kind: 'zoom',
    name,
    ...resolveRectGeometry(zoom, resolvePoint, elementName, variables, { aspect, view, align }),
    opacity: clamp(asNumber(zoom.opacity, 1, variables), 0, 1),
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
  variables: Variables,
  density: boolean,
): DrawableElement[] {
  const indexByName = new Map(items.flatMap((item, index) => item.name ? [[item.name, index] as const] : []));
  const resolved: (DrawableElement | undefined)[] = [];
  const resolving = new Set<number>();

  const pointResolverFor = (ownIndex: number): PointResolver => (value, label) => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      const point = parsePoint(value, variables);
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
      ? parseRectElement(item.record, item.name, item.label, resolvePoint, variables, density)
      : parseZoomElement(item.record, item.name, item.label, resolvePoint, aspect, view, variables, density);
    resolving.delete(index);
    resolved[index] = element;
    return element;
  };

  return items.map((_, index) => resolveElement(index));
}

// Evaluates a value once, on first use. Re-entering while it is being
// computed means the definitions refer to each other in a loop.
function lazy<T>(label: string, compute: () => T): () => T {
  let resolving = false;
  let result: { value: T } | undefined;
  return () => {
    if (result) {
      return result.value;
    }
    if (resolving) {
      throw new Error(`${label} is part of a reference loop`);
    }
    resolving = true;
    try {
      result = { value: compute() };
      return result.value;
    } finally {
      resolving = false;
    }
  };
}

// Variables are a list of { name, value }. Values may be numbers or
// expressions referring to other variables or view values in any order.
function parseVariableDefinitions(node: unknown): Map<string, number | string> {
  const definitions = new Map<string, number | string>();
  if (node === undefined) {
    return definitions;
  }
  if (!Array.isArray(node)) {
    throw new Error('variables must be a list of { name, value } items');
  }

  node.forEach((item, index) => {
    const label = `Variable ${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label} must be an object with a name and a value`);
    }
    const { name, value } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !isIdentifier(name)) {
      throw new Error(`${label} name must start with a letter or underscore and contain only letters, digits, and underscores`);
    }
    if (isReservedName(name)) {
      throw new Error(`Variable "${name}" has the same name as a built-in constant or function`);
    }
    if (definitions.has(name)) {
      throw new Error(`Variable "${name}" is defined more than once`);
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new Error(`Variable "${name}" value must be a number or an expression`);
    }
    definitions.set(name, value);
  });
  return definitions;
}

function parseShading(node: unknown): Shading {
  if (node === undefined) {
    return { mode: 'paint' };
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error('shading must be an object');
  }
  const { mode = 'paint', scale, colors, ...rest } = node as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    throw new Error(`shading has unknown setting "${unknown[0]}"`);
  }
  if (mode === 'paint') {
    if (scale !== undefined || colors !== undefined) {
      throw new Error('shading scale and colors are only used with density mode');
    }
    return { mode };
  }
  if (mode !== 'density') {
    throw new Error('shading mode must be paint or density');
  }
  if (scale !== undefined && scale !== 'log' && scale !== 'sqrt' && scale !== 'linear') {
    throw new Error('shading scale must be log, sqrt, or linear');
  }
  return {
    mode,
    scale: scale ?? 'log',
    colors: colors === undefined ? evenStops(DEFAULT_DENSITY_COLORS) : parseColorStops(colors),
  };
}

function variableCell(name: string, value: number | string, lookup: Variables): () => number {
  return lazy(`Variable "${name}"`, () => {
    try {
      return asNumber(value, Number.NaN, lookup);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.startsWith('Variable "') ? message : `Variable "${name}": ${message}`);
    }
  });
}

export function parseScene(text: string): SceneDefinition {
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
    return { ...fallback, shading: { mode: 'paint' } };
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
  const viewNode = sceneRoot.view && typeof sceneRoot.view === 'object' && !Array.isArray(sceneRoot.view)
    ? (sceneRoot.view as Record<string, unknown>)
    : {};
  const coordinatesNode = viewNode.coordinates && typeof viewNode.coordinates === 'object' && !Array.isArray(viewNode.coordinates)
    ? (viewNode.coordinates as Record<string, unknown>)
    : {};

  // Variables and view values resolve lazily through one lookup, so each
  // may refer to the others as long as there is no loop.
  const cells = new Map<string, () => number>();
  const variables: Variables = (name) => cells.get(name)?.();
  const resolvedView = lazy('view.resolution', () => resolveView(viewNode, variables));
  const xRange = lazy('view.coordinates.x', () => parseAxisRange(coordinatesNode.x, fallback.view.coordinates.x, variables));
  const yRange = lazy('view.coordinates.y', () => parseAxisRange(coordinatesNode.y, fallback.view.coordinates.y, variables));
  const viewValues: Record<string, () => number> = {
    'view.left': () => xRange().from,
    'view.right': () => xRange().to,
    'view.bottom': () => yRange().from,
    'view.top': () => yRange().to,
    'view.width': () => xRange().to - xRange().from,
    'view.height': () => yRange().to - yRange().from,
    'view.centre.x': () => (xRange().from + xRange().to) / 2,
    'view.centre.y': () => (yRange().from + yRange().to) / 2,
    'view.aspect': () => resolvedView().aspect,
    'view.pixels.width': () => resolvedView().resolution.width,
    'view.pixels.height': () => resolvedView().resolution.height,
    'view.pixel.width': () => (xRange().to - xRange().from) / resolvedView().resolution.width,
    'view.pixel.height': () => (yRange().to - yRange().from) / resolvedView().resolution.height,
  };
  Object.entries(viewValues).forEach(([name, value]) => cells.set(name, value));
  parseVariableDefinitions(sceneRoot.variables)
    .forEach((value, name) => cells.set(name, variableCell(name, value, variables)));
  // Evaluate everything so mistakes in unused variables are still reported.
  cells.forEach((cell) => cell());

  const frameNode = sceneRoot.frame && typeof sceneRoot.frame === 'object' && !Array.isArray(sceneRoot.frame)
    ? (sceneRoot.frame as Record<string, unknown>)
    : {};
    const frame: FrameDefinition = {
      width: asNonNegativeNumber(frameNode.width, fallback.frame.width, variables),
      radius: asNonNegativeNumber(frameNode.radius, fallback.frame.radius, variables),
      color: typeof frameNode.color === 'string' ? frameNode.color : fallback.frame.color,
      wall: typeof frameNode.wall === 'string' ? frameNode.wall : fallback.frame.wall,
      background: typeof frameNode.background === 'string' ? frameNode.background : fallback.frame.background,
      padding: asNonNegativeNumber(frameNode.padding, fallback.frame.padding, variables),
      margin: asNonNegativeNumber(frameNode.margin, fallback.frame.margin, variables),
    };
    const coordinates = { x: xRange(), y: yRange() };

    const shading = parseShading(sceneRoot.shading);
    const density = shading.mode === 'density';
    if (density && sceneRoot.seed !== undefined) {
      throw new Error('seed is not used with density shading');
    }
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
      resolvedView().aspect,
      viewFrame,
      variables,
      density,
    );

    return {
      shading,
      frame,
      seed: {
        color: typeof sceneRoot.seed === 'string'
          ? sceneRoot.seed
          : typeof seedNode.color === 'string' ? seedNode.color : fallback.seed.color,
        opacity: clamp(asNumber(seedNode.opacity, fallback.seed.opacity, variables), 0, 1),
      },
      view: {
        ...resolvedView(),
        coordinates,
      },
      elements,
    };
}
