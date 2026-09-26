import YAML from 'yaml';

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

export type SceneDefinition = {
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
