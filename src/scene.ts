import YAML from 'yaml';
import { evaluateExpression, isIdentifier, isReservedName, type Variables } from './expression';

// Keys and list indexes leading to a value in the definition.
type ScenePath = (string | number)[];

export type SceneDiagnostic = {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
};

// A definition mistake, with where it occurs in the definition text.
export class SceneError extends Error {
  constructor(message: string, readonly diagnostics: SceneDiagnostic[]) {
    super(message);
  }
}

// An error tagged with the definition path it belongs to.
class PathError extends Error {
  constructor(message: string, readonly path: ScenePath) {
    super(message);
  }
}

// Runs a step, tagging any untagged error with the path being parsed. The
// innermost tag wins, so errors in referenced values point at their source.
function atPath<T>(path: ScenePath, compute: () => T): T {
  try {
    return compute();
  } catch (error) {
    if (error instanceof PathError) {
      throw error;
    }
    throw new PathError(error instanceof Error ? error.message : String(error), path);
  }
}

// American spellings accepted for setting names, mapped to the British
// names used internally and suggested for misspellings. Writing both spellings in one place is an error.
const SPELLINGS: Record<string, string> = {
  color: 'colour',
  colors: 'colours',
  center: 'centre',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function normaliseSpellings(value: unknown, path: ScenePath = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => normaliseSpellings(item, [...path, index]));
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  const written = new Map<string, string>();
  for (const [key, item] of Object.entries(value)) {
    const name = SPELLINGS[key] ?? key;
    const earlier = written.get(name);
    if (earlier !== undefined) {
      throw new PathError(`Use either "${earlier}" or "${key}", not both`, [...path, key]);
    }
    written.set(name, key);
    result[name] = normaliseSpellings(item, [...path, key]);
  }
  return result;
}

// The settings each part of a definition accepts. Parts without keys, such
// as colour mappings, are not checked.
type Shape = {
  keys?: Record<string, Shape>;
  items?: Shape;
  byType?: Record<string, Shape>;
};

const LEAF: Shape = {};
const leaves = (...names: string[]): Record<string, Shape> =>
  Object.fromEntries(names.map((name) => [name, LEAF]));

const POINT: Shape = { keys: leaves('x', 'y') };
const POINT_LIST: Shape = { items: POINT };
const ROTATION: Shape = { keys: leaves('degrees', 'deg', 'radians', 'rad') };
const AXIS: Shape = { keys: leaves('from', 'to', 'min', 'max') };
const GEOMETRY: Record<string, Shape> = {
  ...leaves('type', 'name', 'width', 'height', 'opacity', 'transparency'),
  glow: { keys: leaves('colour', 'opacity', 'transparency', 'size', 'softness', 'sourceOpacity') },
  centre: POINT,
  topLeft: POINT,
  topRight: POINT,
  bottomLeft: POINT,
  bottomRight: POINT,
  rotation: ROTATION,
};
// Align items may be pairs or, for a single pair written as a list, points.
const ALIGN_ITEM: Shape = { keys: { from: POINT, to: POINT, ...leaves('x', 'y') } };
const ALIGN: Shape = { keys: { from: POINT, to: POINT }, items: ALIGN_ITEM };

const DEFINITION: Shape = {
  keys: {
    info: {
      keys: {
        ...leaves('title', 'author', 'date', 'description'),
        links: { items: { keys: leaves('title', 'url') } },
      },
    },
    frame: { keys: leaves('width', 'radius', 'colour', 'wall', 'background', 'padding', 'margin') },
    view: {
      keys: {
        aspect: LEAF,
        overflow: LEAF,
        coordinates: { keys: { x: AXIS, y: AXIS } },
      },
    },
    variables: {
      items: {
        keys: { ...leaves('name', 'value'), input: { keys: leaves('type', 'label', 'min', 'max', 'step') } },
      },
    },
    shading: { keys: { ...leaves('mode', 'scale', 'detail'), colours: LEAF } },
    seed: { keys: leaves('colour', 'opacity', 'transparency') },
    scene: {
      items: {
        byType: {
          // Scale and align are listed so rectangles get a specific error.
          rect: { keys: { ...GEOMETRY, ...leaves('colour', 'weight', 'scale', 'align') } },
          circle: { keys: { ...leaves('type', 'name', 'centre', 'radius', 'colour', 'weight', 'opacity', 'transparency'), points: POINT_LIST } },
          polygon: { keys: { ...leaves('type', 'name', 'sides', 'centre', 'colour', 'weight', 'opacity', 'transparency'), points: POINT_LIST, vertex: POINT } },
          zoom: { keys: { ...GEOMETRY, ...leaves('scale', 'blend'), align: ALIGN } },
        },
      },
    },
  },
};

// Edit distance counting a swap of neighbouring letters as one edit, used to
// suggest the setting a misspelt key was meant to be.
function editDistance(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  const rows = [Array.from({ length: b.length + 1 }, (_, index) => index)];
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        rows[i - 1][j] + 1,
        row[j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
      }
    }
    rows.push(row);
  }
  return rows[a.length][b.length];
}

function unknownKeyError(key: string, known: string[], path: ScenePath): PathError {
  // American spellings are compared too, but the British name is suggested.
  const spellings = Object.entries(SPELLINGS).filter(([, name]) => known.includes(name));
  const [closest] = [...known.map((name) => [name, name]), ...spellings.map(([alias, name]) => [alias, name])]
    .map(([written, name]) => ({ name, distance: editDistance(key, written) }))
    .filter(({ distance }) => distance <= Math.max(1, Math.ceil(key.length / 3)))
    .sort((left, right) => left.distance - right.distance);
  const hint = closest ? `; did you mean "${closest.name}"?` : '';
  return new PathError(`Unknown setting "${key}"${hint}`, [...path, key]);
}

function checkKeys(value: unknown, shape: Shape, path: ScenePath = []): void {
  if (Array.isArray(value)) {
    if (shape.items) {
      value.forEach((item, index) => checkKeys(item, shape.items!, [...path, index]));
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const typed = shape.byType && typeof value.type === 'string' ? shape.byType[value.type] : undefined;
  const keys = typed?.keys ?? shape.keys;
  if (!keys) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(keys, key)) {
      throw unknownKeyError(key, Object.keys(keys), path);
    }
    checkKeys(item, keys[key], [...path, key]);
  }
}

export type Vec2 = {
  x: number;
  y: number;
};

// A soft halo in one colour around the visible parts of an item, reaching
// `size` scene units beyond its edges. Softness runs from 0, a solid band
// with a crisp edge, to 1, which fades out over the whole size.
export type Glow = {
  color: string;
  opacity: number;
  size: number;
  softness: number;
  sourceOpacity: number;
};

type SceneElement = {
  name?: string;
  glow?: Glow;
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

export type CircleElement = SceneElement & {
  kind: 'circle';
  center: Vec2;
  radius: number;
  sourcePoints?: Vec2[];
  color: string;
  opacity: number;
  weight: number;
};

export type PolygonElement = SceneElement & {
  kind: 'polygon';
  points: Vec2[];
  color: string;
  opacity: number;
  weight: number;
};

export type ZoomElement = SceneElement & {
  kind: 'zoom';
  center: Vec2;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  blend: BlendMode;
  alignTargets: Vec2[];
};

export type ShapeElement = RectElement | CircleElement | PolygonElement;
export type DrawableElement = ShapeElement | ZoomElement;

export type ViewRanges = {
  x: AxisRange;
  y: AxisRange;
};

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
  | { mode: 'paint'; detail: number }
  | { mode: 'density'; scale: DensityScale; colors: ColorStop[] };

// How small copies are shrunk, from -1 to 1. Each shrunk block takes the
// average alpha of its pixels at 0 (ordinary image scaling), moving towards
// the minimum alpha at -1 and the maximum at 1 (`preserve`).
const DETAIL_NAMES: Record<string, number> = { average: 0, preserve: 1 };

// How a zoom's copy combines with what is already drawn under it.
export const BLEND_MODES = ['normal', 'multiply', 'screen', 'add', 'darken', 'lighten'] as const;
export type BlendMode = typeof BLEND_MODES[number];

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
      throw new Error(`shading colours position "${key}" must be at most 100%`);
    }
    return { kind: 'fraction', value: value / 100 };
  }
  const count = Number(key);
  if (key.trim() === '' || !Number.isFinite(count) || count < 0) {
    throw new Error(`shading colours position "${key}" must be a hit count or a percentage such as 50%`);
  }
  return { kind: 'count', value: count };
}

// Colours are a list spread evenly, or a mapping from hit counts or
// percentages to colours.
function parseColorStops(colors: unknown, variables: Variables): ColorStop[] {
  const path = ['shading', 'colours'];
  const range = `2 to ${MAXIMUM_DENSITY_COLORS}`;
  if (Array.isArray(colors)) {
    if (colors.length < 2 || colors.length > MAXIMUM_DENSITY_COLORS || !colors.every((color) => typeof color === 'string')) {
      throw new Error(`shading colours must be a list of ${range} colours`);
    }
    return evenStops(colors.map((color, index) => atPath([...path, index], () => asColour(color, '', variables))));
  }
  if (!colors || typeof colors !== 'object') {
    throw new Error(`shading colours must be a list or mapping of ${range} colours`);
  }
  const entries = Object.entries(colors);
  if (entries.length < 2 || entries.length > MAXIMUM_DENSITY_COLORS) {
    throw new Error(`shading colours must map ${range} positions to colours`);
  }
  return entries.map(([key, color]) => atPath([...path, key], () => {
    if (typeof color !== 'string') {
      throw new Error(`shading colours position "${key}" must have a colour`);
    }
    return { at: parseStopPosition(key), color: asColour(color, '', variables) };
  }));
}

export type SceneLink = {
  title?: string;
  url: string;
};

// Descriptive details shown on the wall label; none affect the picture.
export type SceneInfo = {
  title?: string;
  author?: string;
  date?: string;
  description?: string;
  links: SceneLink[];
};

// Variables that can be changed while viewing. Sliders set a number; click and
// drag inputs set a point from where the picture is pressed, available as
// `name.x` and `name.y`. `initial` is the value from the definition.
export type SceneInput =
  | { type: 'slider'; name: string; label: string; min: number; max: number; step?: number; value: number; initial: number }
  | { type: 'click' | 'drag'; name: string; label: string; value: Vec2; initial: Vec2 }
  | { type: 'checkbox'; name: string; label: string; value: boolean; initial: boolean };

export type InputValue = number | boolean | Vec2;
export type InputValues = ReadonlyMap<string, InputValue>;

export type SceneDefinition = {
  info: SceneInfo;
  inputs: SceneInput[];
  shading: Shading;
  frame: FrameDefinition;
  seed: {
    color: string;
    opacity: number;
  };
  view: {
    aspect: number;
    // The whole picture, including any overflow. Zooms copy this area.
    coordinates: ViewRanges;
    // The coordinates as written, which set the zoom transforms.
    declared: ViewRanges;
  };
  elements: DrawableElement[];
};

export type ResolvedSceneDefinition = SceneDefinition & {
  view: SceneDefinition['view'] & {
    resolution: {
      width: number;
      height: number;
    };
  };
};

export function withResolution(
  scene: SceneDefinition,
  resolution: ResolvedSceneDefinition['view']['resolution'],
): ResolvedSceneDefinition {
  return { ...scene, view: { ...scene.view, resolution } };
}

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

// A fraction from 0 to 1, or a percentage such as `40%`, whose number may be
// an expression. Results outside the range are clamped.
function asFraction(value: unknown, variables: Variables): number {
  const percent = typeof value === 'string' ? /^(.*)%\s*$/s.exec(value) : null;
  const fraction = percent
    ? evaluateExpression(percent[1], variables) / 100
    : asNumber(value, Number.NaN, variables);
  if (Number.isNaN(fraction)) {
    throw new Error('must be a number from 0 to 1 or a percentage');
  }
  return clamp(fraction, 0, 1);
}

// Items may set `opacity` or `transparency` (1 - opacity), but not both.
function parseOpacity(
  record: Record<string, unknown>,
  fallback: number,
  variables: Variables,
  path: ScenePath,
): number {
  if (record.opacity !== undefined && record.transparency !== undefined) {
    throw new PathError('Use either "opacity" or "transparency", not both', [...path, 'transparency']);
  }
  if (record.transparency !== undefined) {
    return 1 - atPath([...path, 'transparency'], () => asFraction(record.transparency, variables));
  }
  return record.opacity === undefined
    ? fallback
    : atPath([...path, 'opacity'], () => asFraction(record.opacity, variables));
}

let colourContext: OffscreenCanvasRenderingContext2D | null = null;

// Any colour the canvas understands: names, #rgb, #rgba, #rrggbb, #rrggbbaa,
// and functions such as rgb(), hsl(), hwb(), lab() and oklch(). A colour the
// canvas rejects leaves its fill unchanged, so two different starting fills
// reveal it.
function isColour(value: string): boolean {
  colourContext ??= new OffscreenCanvas(1, 1).getContext('2d');
  if (!colourContext) {
    throw new Error('Could not create a canvas to check colours');
  }
  const context = colourContext;
  const parsed = (start: string) => {
    context.fillStyle = start;
    context.fillStyle = value;
    return context.fillStyle;
  };
  return parsed('#000') === parsed('#fff');
}

function asColour(value: unknown, fallback: string, variables: Variables): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === 'string' && isColour(value)) {
    return value;
  }
  const rgb = typeof value === 'string' ? /^rgb\((.*)\)$/is.exec(value.trim()) : null;
  if (rgb) {
    const channels: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < rgb[1].length; index += 1) {
      const character = rgb[1][index];
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (character === ',' && depth === 0) {
        channels.push(rgb[1].slice(start, index).trim());
        start = index + 1;
      }
    }
    channels.push(rgb[1].slice(start).trim());
    if (channels.length !== 3) {
      throw new Error('rgb() expressions need three comma-separated channels');
    }
    const resolved = channels.map((channel) => {
      const percent = channel.endsWith('%');
      const number = evaluateExpression(percent ? channel.slice(0, -1) : channel, variables);
      return percent ? `${number}%` : String(number);
    });
    const colour = `rgb(${resolved.join(', ')})`;
    if (isColour(colour)) {
      return colour;
    }
  }
  throw new Error(`${JSON.stringify(value)} is not a colour; use a name, #rgb, #rrggbbaa, rgb(), hsl() or similar`);
}

// Grows an axis by the overflow on both sides, keeping its direction.
const growAxis = (range: AxisRange, overflow: number): AxisRange => {
  const outwards = Math.sign(range.to - range.from) * overflow;
  return { from: range.from - outwards, to: range.to + outwards };
};

export const viewFrame = ({ x, y }: ViewRanges): ViewFrame => ({
  centre: { x: (x.from + x.to) / 2, y: (y.from + y.to) / 2 },
  width: x.to - x.from,
  height: y.to - y.from,
});

// Where a zoom places a point of the area it copies.
export const zoomMap = (zoom: ZoomElement, view: ViewFrame) => (point: Vec2): Vec2 =>
  add(zoom.center, zoomOffset(point, view, zoom.width, zoom.height, zoom.rotation));

// The same zoom transform, described as copying `to` instead of `from`.
export const reframeZoom = (zoom: ZoomElement, from: ViewFrame, to: ViewFrame): ZoomElement => ({
  ...zoom,
  center: zoomMap(zoom, from)(to.centre),
  width: zoom.width * to.width / from.width,
  height: zoom.height * to.height / from.height,
});

const cross = (origin: Vec2, a: Vec2, b: Vec2) =>
  (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);

export function convexHull(points: Vec2[]): Vec2[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const chain = (ordered: Vec2[]) => ordered.reduce<Vec2[]>((hull, point) => {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) {
      hull.pop();
    }
    hull.push(point);
    return hull;
  }, []);
  if (sorted.length < 3) {
    return sorted;
  }
  const lower = chain(sorted);
  const upper = chain([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const polygonCross = (origin: Vec2, a: Vec2, b: Vec2) =>
  (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);

const polygonArea = (points: Vec2[]) => points.reduce((area, point, index) => {
  const next = points[(index + 1) % points.length];
  return area + point.x * next.y - next.x * point.y;
}, 0) / 2;

const pointOnSegment = (point: Vec2, start: Vec2, end: Vec2) =>
  Math.abs(polygonCross(start, end, point)) < 1e-10
  && point.x >= Math.min(start.x, end.x) - 1e-10
  && point.x <= Math.max(start.x, end.x) + 1e-10
  && point.y >= Math.min(start.y, end.y) - 1e-10
  && point.y <= Math.max(start.y, end.y) + 1e-10;

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const abC = polygonCross(a, b, c);
  const abD = polygonCross(a, b, d);
  const cdA = polygonCross(c, d, a);
  const cdB = polygonCross(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0)
    || pointOnSegment(c, a, b)
    || pointOnSegment(d, a, b)
    || pointOnSegment(a, c, d)
    || pointOnSegment(b, c, d);
}

// Ear-clipping triangulation supports both convex and concave simple polygons.
export function triangulatePolygon(points: Vec2[], validate = true): Vec2[][] {
  if (points.length < 3) {
    throw new Error('A polygon needs at least three points');
  }
  if (validate && points.some((point, index) => vectorLength(subtract(point, points[(index + 1) % points.length])) < 1e-10)) {
    throw new Error('Polygon points must not be repeated');
  }
  let vertices = points.filter((point, index) =>
    vectorLength(subtract(point, points[(index + points.length - 1) % points.length])) >= 1e-10);
  if (vertices.length > 1 && vectorLength(subtract(vertices[0], vertices.at(-1)!)) < 1e-10) {
    vertices = vertices.slice(0, -1);
  }
  const area = polygonArea(vertices);
  if (validate) {
    for (let first = 0; first < vertices.length; first += 1) {
      const firstNext = (first + 1) % vertices.length;
      for (let second = first + 1; second < vertices.length; second += 1) {
        const secondNext = (second + 1) % vertices.length;
        if (first === second || firstNext === second || secondNext === first) {
          continue;
        }
        if (segmentsIntersect(vertices[first], vertices[firstNext], vertices[second], vertices[secondNext])) {
          throw new Error('Polygon edges must not cross or touch');
        }
      }
    }
  }
  if (Math.abs(area) < 1e-10) {
    throw new Error('Polygon points must enclose an area');
  }
  const orientation = Math.sign(area);
  if (vertices.every((point, index) => {
    const previous = vertices[(index + vertices.length - 1) % vertices.length];
    const next = vertices[(index + 1) % vertices.length];
    return polygonCross(previous, point, next) * orientation >= -1e-10;
  })) {
    return vertices.slice(1, -1).map((point, index) => [vertices[0], point, vertices[index + 2]]);
  }
  const remaining = vertices.map((_, index) => index);
  const triangles: Vec2[][] = [];
  const insideTriangle = (point: Vec2, a: Vec2, b: Vec2, c: Vec2) =>
    polygonCross(a, b, point) * orientation >= -1e-10
    && polygonCross(b, c, point) * orientation >= -1e-10
    && polygonCross(c, a, point) * orientation >= -1e-10;

  while (remaining.length > 3) {
    const ear = remaining.findIndex((current, index) => {
      const previous = remaining[(index + remaining.length - 1) % remaining.length];
      const next = remaining[(index + 1) % remaining.length];
      const [a, b, c] = [vertices[previous], vertices[current], vertices[next]];
      return polygonCross(a, b, c) * orientation > 1e-10
        && !remaining.some((candidate) =>
          candidate !== previous && candidate !== current && candidate !== next
          && insideTriangle(vertices[candidate], a, b, c));
    });
    if (ear < 0) {
      throw new Error('Polygon could not be triangulated; check that its points make a simple shape');
    }
    const previous = remaining[(ear + remaining.length - 1) % remaining.length];
    const current = remaining[ear];
    const next = remaining[(ear + 1) % remaining.length];
    triangles.push([vertices[previous], vertices[current], vertices[next]]);
    remaining.splice(ear, 1);
  }
  triangles.push(remaining.map((index) => vertices[index]));
  return triangles;
}

type Bounds = { min: Vec2; max: Vec2 };

const boundsOf = (points: Vec2[]): Bounds => ({
  min: { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) },
  max: { x: Math.max(...points.map((p) => p.x)), y: Math.max(...points.map((p) => p.y)) },
});

function clipPolygon(points: Vec2[], bounds: Bounds): Vec2[] {
  const boundaries: {
    inside: (point: Vec2) => boolean;
    intersect: (from: Vec2, to: Vec2) => Vec2;
  }[] = [
    {
      inside: (point) => point.x >= bounds.min.x,
      intersect: (from, to) => {
        const t = (bounds.min.x - from.x) / (to.x - from.x);
        return { x: bounds.min.x, y: from.y + (to.y - from.y) * t };
      },
    },
    {
      inside: (point) => point.x <= bounds.max.x,
      intersect: (from, to) => {
        const t = (bounds.max.x - from.x) / (to.x - from.x);
        return { x: bounds.max.x, y: from.y + (to.y - from.y) * t };
      },
    },
    {
      inside: (point) => point.y >= bounds.min.y,
      intersect: (from, to) => {
        const t = (bounds.min.y - from.y) / (to.y - from.y);
        return { x: from.x + (to.x - from.x) * t, y: bounds.min.y };
      },
    },
    {
      inside: (point) => point.y <= bounds.max.y,
      intersect: (from, to) => {
        const t = (bounds.max.y - from.y) / (to.y - from.y);
        return { x: from.x + (to.x - from.x) * t, y: bounds.max.y };
      },
    },
  ];
  let clipped = points;
  for (const boundary of boundaries) {
    const input = clipped;
    clipped = [];
    input.forEach((point, index) => {
      const previous = input[(index + input.length - 1) % input.length];
      if (boundary.inside(point)) {
        if (!boundary.inside(previous)) {
          clipped.push(boundary.intersect(previous, point));
        }
        clipped.push(point);
      } else if (boundary.inside(previous)) {
        clipped.push(boundary.intersect(previous, point));
      }
    });
  }
  return clipped;
}

// Points of an octagon that contains a circle, for growing by a glow.
const OCTAGON = Array.from({ length: 8 }, (_, index) => ({
  x: Math.cos(index * Math.PI / 4) / Math.cos(Math.PI / 8),
  y: Math.sin(index * Math.PI / 4) / Math.cos(Math.PI / 8),
}));

const CIRCLE_BOUNDS_RADIUS = 1 / Math.cos(Math.PI / 128);
const CIRCLE_BOUNDS = Array.from({ length: 128 }, (_, index) => {
  const angle = index * Math.PI * 2 / 128;
  return { x: Math.cos(angle) * CIRCLE_BOUNDS_RADIUS, y: Math.sin(angle) * CIRCLE_BOUNDS_RADIUS };
});

// Bounds of everything the scene draws once zooms have repeated forever.
// The convex hull of the finished picture is the fixed point of hull(rects
// plus each zoom's copy of the hull), which every shrinking zoom approaches
// geometrically from any starting shape.
function contentBounds(elements: DrawableElement[], view: ViewFrame): Bounds {
  const zooms = elements.filter((element): element is ZoomElement => element.kind === 'zoom' && element.opacity > 0);
  const growth = (zoom: ZoomElement) => Math.max(
    Math.abs(zoom.width / view.width),
    Math.abs(zoom.height / view.height),
  );
  const shrink = Math.max(0, ...zooms.map(growth));
  if (shrink >= 1 - 1e-6) {
    const index = elements.findIndex((element) => element.kind === 'zoom' && element.opacity > 0 && growth(element) === shrink);
    const zoom = elements[index];
    const label = zoom.name ? `Zoom "${zoom.name}"` : `Zoom ${index + 1}`;
    throw new Error(`overflow: auto cannot fit the picture because ${label} is ${shrink.toFixed(2)} times the size of the view, so its copies keep growing`);
  }
  const viewBounds = {
    min: {
      x: Math.min(view.centre.x - view.width / 2, view.centre.x + view.width / 2),
      y: Math.min(view.centre.y - view.height / 2, view.centre.y + view.height / 2),
    },
    max: {
      x: Math.max(view.centre.x - view.width / 2, view.centre.x + view.width / 2),
      y: Math.max(view.centre.y - view.height / 2, view.centre.y + view.height / 2),
    },
  };
  const base = elements
    .filter((element): element is ShapeElement =>
      element.kind !== 'zoom' && (element.opacity > 0 || (element.kind === 'rect' && element.glow !== undefined)))
    .flatMap((shape) => {
      if (shape.kind === 'circle') {
        return CIRCLE_BOUNDS.map((point) => add(shape.center, scaleVector(point, shape.radius)));
      }
      if (shape.kind === 'polygon') {
        return shape.points;
      }
      const rect = shape;
      const grow = 2 * (rect.glow?.size ?? 0);
      return CORNER_NAMES.map((name) =>
        rectCorner({ ...rect, width: rect.width + grow, height: rect.height + grow }, name));
    });
  if (base.length === 0 && zooms.length === 0) {
    throw new Error('overflow: auto needs something in the scene to fit');
  }
  const copies = zooms.map((zoom) => {
    const map = zoomMap(zoom, view);
    const glow = zoom.glow?.size ?? 0;
    return (point: Vec2) => {
      const placed = map(point);
      return glow > 0 ? OCTAGON.map((corner) => add(placed, scaleVector(corner, glow))) : [placed];
    };
  });
  const step = (hull: Vec2[]) => {
    const source = clipPolygon(hull, viewBounds);
    return convexHull([...base, ...copies.flatMap((copy) => source.flatMap(copy))]);
  };

  let hull = base.length > 0 ? convexHull(base) : convexHull(CORNER_NAMES.map((name) => viewPoint(view, name)));
  for (let iteration = 0; iteration < 100000; iteration += 1) {
    const next = step(hull);
    const [before, after] = [boundsOf(hull), boundsOf(next)];
    const size = Math.max(after.max.x - after.min.x, after.max.y - after.min.y);
    const change = Math.max(
      Math.abs(after.min.x - before.min.x),
      Math.abs(after.min.y - before.min.y),
      Math.abs(after.max.x - before.max.x),
      Math.abs(after.max.y - before.max.y),
    );
    hull = next;
    // Remaining movement is at most change * shrink / (1 - shrink).
    if (change * shrink <= 1e-9 * size * (1 - shrink)) {
      break;
    }
  }
  return boundsOf(hull);
}

// The declared view scaled about the content until it just holds it: evenly,
// or with `matchContent` each axis separately so it takes the content's shape.
function fittedView(scene: SceneDefinition, matchContent: boolean): ViewRanges {
  const bounds = contentBounds(scene.elements, viewFrame(scene.view.coordinates));
  const declared = viewFrame(scene.view.declared);
  const scaleX = (bounds.max.x - bounds.min.x) / Math.abs(declared.width);
  const scaleY = (bounds.max.y - bounds.min.y) / Math.abs(declared.height);
  const scale = Math.max(scaleX, scaleY);
  if (!(matchContent ? Math.min(scaleX, scaleY) > 0 : scale > 0)) {
    throw new Error(matchContent
      ? 'overflow: auto with aspect: auto needs content with both width and height'
      : 'overflow: auto found nothing with any size to fit');
  }
  const centre = { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 };
  const halfWidth = declared.width * (matchContent ? scaleX : scale) / 2;
  const halfHeight = declared.height * (matchContent ? scaleY : scale) / 2;
  return {
    x: { from: centre.x - halfWidth, to: centre.x + halfWidth },
    y: { from: centre.y - halfHeight, to: centre.y + halfHeight },
  };
}

const rangesMatch = (left: ViewRanges, right: ViewRanges) => {
  const size = Math.max(Math.abs(left.x.to - left.x.from), Math.abs(left.y.to - left.y.from));
  return [left.x.from - right.x.from, left.x.to - right.x.to, left.y.from - right.y.from, left.y.to - right.y.to]
    .every((difference) => Math.abs(difference) <= 1e-6 * size);
};

// Text fields accept any scalar, so `date: 2026` is fine; blanks are omitted.
function infoText(value: unknown, path: ScenePath): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new PathError(`${path.join(' ')} must be text`, path);
  }
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function parseLink(value: unknown, path: ScenePath): SceneLink {
  const link = isRecord(value)
    ? { title: infoText(value.title, [...path, 'title']), url: infoText(value.url, [...path, 'url']) }
    : { url: infoText(value, path) };
  if (!link.url) {
    throw new PathError('Link needs a url', path);
  }
  const urlPath = isRecord(value) ? [...path, 'url'] : path;
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    throw new PathError(`"${link.url}" is not a valid url`, urlPath);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PathError('Links must start with http:// or https://', urlPath);
  }
  return link.title ? { title: link.title, url: link.url } : { url: link.url };
}

function parseInfo(value: unknown): SceneInfo {
  if (value === undefined) {
    return { links: [] };
  }
  if (!isRecord(value)) {
    throw new PathError('info must be an object', ['info']);
  }
  const links = value.links ?? [];
  if (!Array.isArray(links)) {
    throw new PathError('info links must be a list', ['info', 'links']);
  }
  const text = Object.fromEntries((['title', 'author', 'date', 'description'] as const)
    .map((key) => [key, infoText(value[key], ['info', key])])
    .filter(([, item]) => item !== undefined));
  return { ...text, links: links.map((link, index) => parseLink(link, ['info', 'links', index])) };
}

function parseAxisRange(value: unknown, fallback: AxisRange, variables: Variables, path: ScenePath): AxisRange {
  let from: number;
  let to: number;

  if (Array.isArray(value)) {
    from = atPath([...path, 0], () => asNumber(value[0], fallback.from, variables));
    to = atPath([...path, 1], () => asNumber(value[1], fallback.to, variables));
  } else if (value && typeof value === 'object') {
    const range = value as Record<string, unknown>;
    from = atPath([...path, range.from === undefined ? 'min' : 'from'], () => asNumber(range.from ?? range.min, fallback.from, variables));
    to = atPath([...path, range.to === undefined ? 'max' : 'to'], () => asNumber(range.to ?? range.max, fallback.to, variables));
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
export type ViewFrame = {
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
  return isRecord(value) && 'x' in value && 'y' in value;
}

function parseAlignPairs(
  value: unknown,
  resolvePoint: PointResolver,
  elementName: string,
  variables: Variables,
  path: ScenePath,
): AlignPair[] {
  const toPair = (pair: unknown, label: string, pairPath: ScenePath): AlignPair => atPath(pairPath, () => {
    const [fromValue, toValue] = Array.isArray(pair) && pair.length === 2
      ? pair
      : pair && typeof pair === 'object' && !Array.isArray(pair)
        ? [(pair as Record<string, unknown>).from, (pair as Record<string, unknown>).to]
        : [undefined, undefined];
    const isList = Array.isArray(pair);
    const from = atPath([...pairPath, isList ? 0 : 'from'], () => resolvePoint(fromValue, `${label} from`));
    const to = atPath([...pairPath, isList ? 1 : 'to'], () => resolvePoint(toValue, `${label} to`));
    if (!from || !to) {
      throw new Error(`${label} must be [from, to] or { from, to }`);
    }
    return { from, to };
  });

  const label = `${elementName} align`;
  const isSinglePair = Array.isArray(value) && value.length === 2 && isPointLike(value[0], variables);
  const isObjectPair = Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (isSinglePair || isObjectPair) {
    return [toPair(value, label, path)];
  }
  if (Array.isArray(value) && value.length === 2) {
    return value.map((pair, index) => toPair(pair, `${label} pair ${index + 1}`, [...path, index]));
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
  path: ScenePath,
  zoom?: ZoomConstraints,
): RectGeometry {
  const at = <T>(key: string, compute: () => T) => atPath([...path, key], compute);
  let center = at('centre', () => resolvePoint(rect.centre, `${elementName} centre`));
  const corners = Object.fromEntries(
    CORNER_NAMES
      .map((name) => [name, at(name, () => resolvePoint(rect[name], `${elementName} ${name}`))] as const)
      .filter((entry): entry is [CornerName, Vec2] => Boolean(entry[1])),
  ) as Partial<Record<CornerName, Vec2>>;
  let width = at('width', () => asPositiveNumber(rect.width, variables));
  let height = at('height', () => asPositiveNumber(rect.height, variables));
  if (zoom && rect.scale !== undefined) {
    const scale = at('scale', () => asPositiveNumber(rect.scale, variables));
    if (!scale) {
      throw new PathError(`${elementName} scale must be a positive number`, [...path, 'scale']);
    }
    if (width || height) {
      throw new PathError(`${elementName} must use either scale or width/height, not both`, [...path, 'scale']);
    }
    width = scale * Math.abs(zoom.view.width);
    height = scale * Math.abs(zoom.view.height);
  }
  if (zoom && width && !height) {
    height = width / zoom.aspect;
  } else if (zoom && height && !width) {
    width = height * zoom.aspect;
  }
  let rotation = at('rotation', () => parseRotation(rect.rotation, variables));
  if (rect.rotation !== undefined && rotation === undefined) {
    throw new PathError(`${elementName} rotation must be degrees, an expression with an optional deg or rad unit, or a unit object`, [...path, 'rotation']);
  }

  if (zoom?.align.length === 2) {
    const aligned = at('align', () => geometryFromAlignPairs(zoom.align, zoom.view, elementName));
    if (!geometryMatches(aligned, center, corners, width, height, rotation)) {
      throw new PathError(`${elementName} align conflicts with its other constraints`, [...path, 'align']);
    }
    return aligned;
  }

  if (zoom?.align.length === 1) {
    if (!width || !height) {
      throw new PathError(`${elementName} align needs scale, width, or height`, [...path, 'align']);
    }
    rotation ??= 0;
    const [{ from, to }] = zoom.align;
    const alignedCenter = subtract(to, zoomOffset(from, zoom.view, width, height, rotation));
    if (center && vectorLength(subtract(center, alignedCenter)) > RECT_EPSILON) {
      throw new PathError(`${elementName} align conflicts with its centre`, [...path, 'align']);
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

const DEFAULT_GLOW_OPACITY = 1;
const DEFAULT_GLOW_SOFTNESS = 1;

function parseGlow(
  value: unknown,
  elementName: string,
  variables: Variables,
  density: boolean,
  path: ScenePath,
  isZoom: boolean,
): Glow | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (density) {
    throw new Error(`${elementName}: glow is not used with density shading`);
  }
  if (!isRecord(value)) {
    throw new Error(`${elementName} glow must be an object with a colour and size`);
  }
  if (!isZoom && value.sourceOpacity !== undefined) {
    throw new PathError('sourceOpacity is only used by zoom glows', [...path, 'sourceOpacity']);
  }
  const size = atPath([...path, 'size'], () => asNonNegativeNumber(value.size, Number.NaN, variables));
  if (Number.isNaN(size)) {
    throw new PathError(`${elementName} glow size must be a non-negative number`, value.size === undefined ? path : [...path, 'size']);
  }
  const colour = value.colour;
  if (colour === undefined) {
    throw new PathError(`${elementName} glow needs a colour`, path);
  }
  const softness = atPath([...path, 'softness'], () => asNumber(value.softness, DEFAULT_GLOW_SOFTNESS, variables));
  if (softness < 0 || softness > 1) {
    throw new PathError(`${elementName} glow softness must be from 0 to 1`, [...path, 'softness']);
  }
  return {
    color: atPath([...path, 'colour'], () => asColour(colour, '', variables)),
    opacity: parseOpacity(value, DEFAULT_GLOW_OPACITY, variables, path),
    size,
    softness,
    sourceOpacity: atPath([...path, 'sourceOpacity'], () => value.sourceOpacity === undefined
      ? 0
      : asFraction(value.sourceOpacity, variables)),
  };
}

function parseRectElement(
  rect: Record<string, unknown>,
  name: string | undefined,
  elementName: string,
  resolvePoint: PointResolver,
  variables: Variables,
  density: boolean,
  path: ScenePath,
): RectElement {
  const at = <T>(key: string, compute: () => T) => atPath([...path, key], compute);
  if (rect.scale !== undefined || rect.align !== undefined) {
    throw new PathError(`${elementName}: scale and align are only supported on zooms`, [...path, rect.scale !== undefined ? 'scale' : 'align']);
  }
  if (density && (rect.colour !== undefined || rect.opacity !== undefined || rect.transparency !== undefined)) {
    const key = rect.colour !== undefined ? 'colour' : rect.opacity !== undefined ? 'opacity' : 'transparency';
    throw new PathError(
      `${elementName}: ${key} is not used with density shading; use weight instead`,
      [...path, key],
    );
  }
  if (!density && rect.weight !== undefined) {
    throw new PathError(`${elementName}: weight is only used with density shading`, [...path, 'weight']);
  }
  const weight = rect.weight === undefined ? 1 : at('weight', () => asPositiveNumber(rect.weight, variables));
  if (!weight) {
    throw new PathError(`${elementName} weight must be a positive number`, [...path, 'weight']);
  }
  const geometry = resolveRectGeometry(rect, resolvePoint, elementName, variables, path);
  const opacity = parseOpacity(rect, 1, variables, path);
  const color = at('colour', () => asColour(rect.colour, '#000', variables));

  return {
    kind: 'rect',
    name,
    glow: at('glow', () => parseGlow(rect.glow, elementName, variables, density, [...path, 'glow'], false)),
    ...geometry,
    color,
    opacity,
    weight,
  };
}

function parseShapeStyle<K extends 'circle' | 'polygon'>(
  record: Record<string, unknown>,
  name: string | undefined,
  kind: K,
  elementName: string,
  variables: Variables,
  density: boolean,
  path: ScenePath,
): { kind: K; name: string | undefined; color: string; opacity: number; weight: number } {
  if (density && (record.colour !== undefined || record.opacity !== undefined || record.transparency !== undefined)) {
    const key = record.colour !== undefined ? 'colour' : record.opacity !== undefined ? 'opacity' : 'transparency';
    throw new PathError(
      `${elementName}: ${key} is not used with density shading; use weight instead`,
      [...path, key],
    );
  }
  if (!density && record.weight !== undefined) {
    throw new PathError(`${elementName}: weight is only used with density shading`, [...path, 'weight']);
  }
  const weight = record.weight === undefined ? 1 : atPath([...path, 'weight'], () => asPositiveNumber(record.weight, variables));
  if (!weight) {
    throw new PathError(`${elementName} weight must be a positive number`, [...path, 'weight']);
  }
  return {
    kind,
    name,
    color: atPath([...path, 'colour'], () => asColour(record.colour, '#000', variables)),
    opacity: parseOpacity(record, 1, variables, path),
    weight,
  };
}

function parseShapePoints(
  value: unknown,
  resolvePoint: PointResolver,
  elementName: string,
  path: ScenePath,
  validatePolygon = true,
) {
  if (!Array.isArray(value)) {
    throw new PathError(`${elementName} points must be a list of at least three points`, path);
  }
  const points = value.map((point, index) => atPath([...path, index], () => {
    const resolved = resolvePoint(point, `${elementName} point ${index + 1}`);
    if (!resolved) {
      throw new Error(`${elementName} point ${index + 1} must be [x, y], { x, y }, or a name.part reference`);
    }
    return resolved;
  }));
  if (validatePolygon) {
    atPath(path, () => triangulatePolygon(points));
  }
  return points;
}

function circumcircle([a, b, c]: [Vec2, Vec2, Vec2], elementName: string): { center: Vec2; radius: number } {
  const determinant = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const scale = Math.max(1, vectorLength(subtract(a, b)), vectorLength(subtract(b, c)), vectorLength(subtract(c, a)));
  if (Math.abs(determinant) <= 1e-10 * scale * scale) {
    throw new Error(`${elementName} points must not be collinear`);
  }
  const aa = a.x * a.x + a.y * a.y;
  const bb = b.x * b.x + b.y * b.y;
  const cc = c.x * c.x + c.y * c.y;
  const center = {
    x: (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / determinant,
    y: (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / determinant,
  };
  return { center, radius: vectorLength(subtract(a, center)) };
}

function parseCircleElement(
  record: Record<string, unknown>,
  name: string | undefined,
  elementName: string,
  resolvePoint: PointResolver,
  variables: Variables,
  density: boolean,
  path: ScenePath,
): CircleElement {
  const hasPointSet = record.points !== undefined;
  if (hasPointSet === (record.centre !== undefined || record.radius !== undefined)) {
    throw new PathError(
      `${elementName} must use either centre and radius, or three points`,
      [...path, hasPointSet ? 'points' : 'centre'],
    );
  }
  let center: Vec2;
  let radius: number;
  let sourcePoints: Vec2[] | undefined;
  if (hasPointSet) {
    sourcePoints = parseShapePoints(record.points, resolvePoint, elementName, [...path, 'points'], false);
    if (sourcePoints.length !== 3) {
      throw new PathError(`${elementName} needs exactly three points`, [...path, 'points']);
    }
    ({ center, radius } = atPath([...path, 'points'], () =>
      circumcircle(sourcePoints as [Vec2, Vec2, Vec2], elementName)));
  } else {
    const resolvedCenter = atPath([...path, 'centre'], () => resolvePoint(record.centre, `${elementName} centre`));
    if (!resolvedCenter) {
      throw new PathError(`${elementName} needs a centre`, [...path, 'centre']);
    }
    center = resolvedCenter;
    radius = atPath([...path, 'radius'], () => asPositiveNumber(record.radius, variables)) ?? 0;
    if (!radius) {
      throw new PathError(`${elementName} radius must be a positive number`, [...path, 'radius']);
    }
  }
  return {
    ...parseShapeStyle(record, name, 'circle', elementName, variables, density, path),
    center,
    radius,
    ...(sourcePoints ? { sourcePoints } : {}),
  };
}

function parsePolygonElement(
  record: Record<string, unknown>,
  name: string | undefined,
  elementName: string,
  resolvePoint: PointResolver,
  variables: Variables,
  density: boolean,
  path: ScenePath,
): PolygonElement {
  let points: Vec2[];
  if (record.points !== undefined) {
    if (record.sides !== undefined || record.centre !== undefined || record.vertex !== undefined) {
      throw new PathError(`${elementName} must use points or sides, centre, and vertex`, [...path, 'points']);
    }
    points = parseShapePoints(record.points, resolvePoint, elementName, [...path, 'points']);
  } else {
    const sides = atPath([...path, 'sides'], () => asNumber(record.sides, Number.NaN, variables));
    if (!Number.isInteger(sides) || sides < 3 || sides > 256) {
      throw new PathError(`${elementName} sides must be a whole number from 3 to 256`, [...path, 'sides']);
    }
    const center = atPath([...path, 'centre'], () => resolvePoint(record.centre, `${elementName} centre`));
    const vertex = atPath([...path, 'vertex'], () => resolvePoint(record.vertex, `${elementName} vertex`));
    if (!center || !vertex) {
      throw new PathError(`${elementName} needs a centre and one vertex`, [...path, !center ? 'centre' : 'vertex']);
    }
    const offset = subtract(vertex, center);
    const radius = vectorLength(offset);
    if (radius <= 1e-10) {
      throw new PathError(`${elementName} vertex must differ from its centre`, [...path, 'vertex']);
    }
    const angle = Math.atan2(offset.y, offset.x);
    points = Array.from({ length: sides }, (_, index) => ({
      x: center.x + radius * Math.cos(angle + index * Math.PI * 2 / sides),
      y: center.y + radius * Math.sin(angle + index * Math.PI * 2 / sides),
    }));
  }
  return {
    ...parseShapeStyle(record, name, 'polygon', elementName, variables, density, path),
    points,
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
  path: ScenePath,
): ZoomElement {
  const alignPath = [...path, 'align'];
  if (density && (zoom.opacity !== undefined || zoom.transparency !== undefined)) {
    const key = zoom.opacity !== undefined ? 'opacity' : 'transparency';
    throw new PathError(`${elementName}: ${key} is not used with density shading`, [...path, key]);
  }
  if (zoom.blend !== undefined && density) {
    throw new PathError(`${elementName}: blend is not used with density shading`, [...path, 'blend']);
  }
  if (zoom.blend !== undefined && !BLEND_MODES.includes(zoom.blend as BlendMode)) {
    throw new PathError(`${elementName} blend must be ${BLEND_MODES.slice(0, -1).join(', ')}, or ${BLEND_MODES.at(-1)}`, [...path, 'blend']);
  }
  const align = zoom.align === undefined
    ? []
    : atPath(alignPath, () => parseAlignPairs(zoom.align, resolvePoint, elementName, variables, alignPath));
  return {
    kind: 'zoom',
    name,
    glow: atPath([...path, 'glow'], () => parseGlow(zoom.glow, elementName, variables, density, [...path, 'glow'], true)),
    ...resolveRectGeometry(zoom, resolvePoint, elementName, variables, path, { aspect, view, align }),
    opacity: parseOpacity(zoom, 1, variables, path),
    blend: (zoom.blend as BlendMode | undefined) ?? 'normal',
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
  return values.map((value, index) => atPath(['scene', index], () => {
    const itemNumber = index + 1;
    const at = <T>(key: string, compute: () => T) => atPath(['scene', index, key], compute);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Scene item ${itemNumber} must be an object`);
    }

    const record = value as Record<string, unknown>;
    if (typeof record.type !== 'string' || !record.type.trim()) {
      throw new Error(`Scene item ${itemNumber} must have a type`);
    }
    if (!['rect', 'circle', 'polygon', 'zoom'].includes(record.type)) {
      throw new PathError(`Scene item ${itemNumber} has unknown type: ${record.type}`, ['scene', index, 'type']);
    }

    const name = record.name === undefined ? undefined : at('name', () => {
      if (typeof record.name !== 'string' || !record.name.trim()) {
        throw new Error(`Scene item ${itemNumber} name must be a non-blank string`);
      }
      const name = record.name.trim();
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
      return name;
    });

    const kind = record.type === 'zoom'
      ? 'Zoom'
      : record.type === 'circle'
        ? 'Circle'
        : record.type === 'polygon'
          ? 'Polygon'
          : 'Rectangle';
    return {
      record,
      type: record.type,
      name,
      label: name ? `${kind} "${name}"` : `${kind} ${itemNumber}`,
    };
  }));
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

    const pointList = value.trim().match(/^([^.\s]+)\.points\.(\d+)$/);
    if (pointList) {
      const [, name, indexText] = pointList;
      const target = indexByName.get(name);
      if (target === undefined) {
        throw new Error(`${label} refers to unknown element "${name}"`);
      }
      if (target === ownIndex) {
        throw new Error(`${label} cannot refer to its own element`);
      }
      const element = resolveElement(target);
      const index = Number(indexText);
      const points = element.kind === 'polygon' ? element.points
        : element.kind === 'circle' ? element.sourcePoints
          : undefined;
      if (!points || !points[index]) {
        throw new Error(`${label} reference "${value}" has no point ${indexText}`);
      }
      return points[index];
    }
    const match = value.trim().match(/^([^.\s]+)\.([A-Za-z]+)$/);
    if (!match) {
      throw new Error(`${label} reference "${value}" must look like name.part`);
    }
    const [, name, written] = match;
    const part = SPELLINGS[written] ?? written;
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
    const element = resolveElement(target);
    if (element.kind === 'rect' || element.kind === 'zoom') {
      return rectPoint(element, part);
    }
    const box = element.kind === 'circle'
      ? { center: element.center, width: 2 * element.radius, height: 2 * element.radius, rotation: 0 }
      : (() => {
        const min = { x: Math.min(...element.points.map((point) => point.x)), y: Math.min(...element.points.map((point) => point.y)) };
        const max = { x: Math.max(...element.points.map((point) => point.x)), y: Math.max(...element.points.map((point) => point.y)) };
        return {
          center: scaleVector(add(min, max), 0.5),
          width: max.x - min.x,
          height: max.y - min.y,
          rotation: 0,
        };
      })();
    return rectPoint(box, part);
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
    const path = ['scene', index];
    const element = atPath(path, () => {
      if (item.type === 'rect') {
        return parseRectElement(item.record, item.name, item.label, resolvePoint, variables, density, path);
      }
      if (item.type === 'circle') {
        return parseCircleElement(item.record, item.name, item.label, resolvePoint, variables, density, path);
      }
      if (item.type === 'polygon') {
        return parsePolygonElement(item.record, item.name, item.label, resolvePoint, variables, density, path);
      }
      return parseZoomElement(item.record, item.name, item.label, resolvePoint, aspect, view, variables, density, path);
    });
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
// Variables with an `input` can also be changed while viewing.
type InputSpec =
  | { type: 'slider'; label?: string; min: unknown; max: unknown; step: unknown }
  | { type: 'click' | 'drag'; label?: string }
  | { type: 'checkbox'; label?: string };
type VariableDefinition = { value: unknown; index: number; input?: InputSpec };

const isPointInput = (input: InputSpec | undefined): input is Extract<InputSpec, { type: 'click' | 'drag' }> =>
  input?.type === 'click' || input?.type === 'drag';

function parseInputSpec(node: unknown, name: string, path: ScenePath): InputSpec | undefined {
  if (node === undefined) {
    return undefined;
  }
  const record = typeof node === 'string' ? { type: node } : isRecord(node) ? node : undefined;
  if (!record) {
    throw new PathError(`Variable "${name}" input must be slider, click, drag, checkbox, or an object with a type`, path);
  }
  const { type, label, min, max, step } = record;
  if (label !== undefined && (typeof label !== 'string' || !label.trim())) {
    throw new PathError(`Variable "${name}" input label must be text`, [...path, 'label']);
  }
  if (type === 'slider') {
    const missing = min === undefined ? 'min' : max === undefined ? 'max' : undefined;
    if (missing) {
      throw new PathError(`Slider "${name}" needs a ${missing}`, path);
    }
    return { type, label, min, max, step };
  }
  if (type === 'click' || type === 'drag' || type === 'checkbox') {
    const unused = Object.entries({ min, max, step }).find(([, value]) => value !== undefined);
    if (unused) {
      throw new PathError(`${type} inputs do not use ${unused[0]}`, [...path, unused[0]]);
    }
    return { type, label };
  }
  throw new PathError(
    `Variable "${name}" input type must be slider, click, drag, or checkbox`,
    typeof node === 'string' ? path : [...path, 'type'],
  );
}

function parseVariableDefinitions(node: unknown): Map<string, VariableDefinition> {
  const definitions = new Map<string, VariableDefinition>();
  if (node === undefined) {
    return definitions;
  }
  if (!Array.isArray(node)) {
    throw new Error('variables must be a list of { name, value } items');
  }

  node.forEach((item, index) => atPath(['variables', index], () => {
    const label = `Variable ${index + 1}`;
    const at = (key: string, message: string) => new PathError(message, ['variables', index, key]);
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label} must be an object with a name and a value`);
    }
    const { name, value, input: inputNode } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !isIdentifier(name)) {
      throw at('name', `${label} name must start with a letter or underscore and contain only letters, digits, and underscores`);
    }
    if (isReservedName(name)) {
      throw at('name', `Variable "${name}" has the same name as a built-in constant or function`);
    }
    if (definitions.has(name)) {
      throw at('name', `Variable "${name}" is defined more than once`);
    }
    const input = parseInputSpec(inputNode, name, ['variables', index, 'input']);
    if (isPointInput(input)) {
      if (!Array.isArray(value) && !isRecord(value)) {
        throw at('value', `Variable "${name}" value must be a point [x, y]`);
      }
    } else if (input?.type === 'checkbox') {
      if (typeof value !== 'boolean') {
        throw at('value', `Variable "${name}" value must be true or false`);
      }
    } else if (typeof value === 'boolean' && input) {
      throw at('value', `Variable "${name}" value must be a number or an expression for a ${input.type}`);
    } else if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
      throw at('value', `Variable "${name}" value must be a number, an expression, true, or false`);
    }
    definitions.set(name, { value, index, input });
  }));
  return definitions;
}

function parseDetail(value: unknown, variables: Variables): number {
  if (value === undefined) {
    return 0;
  }
  const named = typeof value === 'string' ? DETAIL_NAMES[value.trim()] : undefined;
  if (named !== undefined) {
    return named;
  }
  const percent = typeof value === 'string' ? /^(.*)%\s*$/s.exec(value) : null;
  const detail = percent
    ? evaluateExpression(percent[1], variables) / 100
    : asNumber(value, Number.NaN, variables);
  if (!(detail >= -1 && detail <= 1)) {
    throw new Error('shading detail must be average, preserve, or a number from -1 to 1');
  }
  return detail;
}

function parseShading(node: unknown, variables: Variables): Shading {
  if (node === undefined) {
    return { mode: 'paint', detail: 0 };
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error('shading must be an object');
  }
  const { mode = 'paint', scale, colours, detail } = node as Record<string, unknown>;
  if (mode === 'paint') {
    if (scale !== undefined || colours !== undefined) {
      throw new PathError('shading scale and colours are only used with density mode', ['shading', scale !== undefined ? 'scale' : 'colours']);
    }
    return { mode, detail: atPath(['shading', 'detail'], () => parseDetail(detail, variables)) };
  }
  if (mode !== 'density') {
    throw new PathError('shading mode must be paint or density', ['shading', 'mode']);
  }
  if (detail !== undefined) {
    throw new PathError('shading detail is only used with paint mode', ['shading', 'detail']);
  }
  if (scale !== undefined && scale !== 'log' && scale !== 'sqrt' && scale !== 'linear') {
    throw new PathError('shading scale must be log, sqrt, or linear', ['shading', 'scale']);
  }
  return {
    mode,
    scale: scale ?? 'log',
    colors: colours === undefined
      ? evenStops(DEFAULT_DENSITY_COLORS)
      : atPath(['shading', 'colours'], () => parseColorStops(colours, variables)),
  };
}

function variableCell(name: string, { value, index }: VariableDefinition, lookup: Variables): () => number {
  return lazy(`Variable "${name}"`, () => {
    try {
      return asNumber(value, Number.NaN, lookup);
    } catch (error) {
      if (error instanceof PathError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new PathError(
        message.startsWith('Variable "') ? message : `Variable "${name}": ${message}`,
        ['variables', index, 'value'],
      );
    }
  });
}

type DefinedVariable = { cells: [string, () => number][]; input?: () => SceneInput };

// The expression names a variable provides, using the value set while viewing
// when there is one. Slider values stay within their range.
function defineVariable(
  name: string,
  definition: VariableDefinition,
  lookup: Variables,
  override: InputValue | undefined,
): DefinedVariable {
  const { input, index } = definition;
  const at = <T>(path: ScenePath, compute: () => T) => atPath(['variables', index, ...path], compute);
  const label = input?.label?.trim() ?? name;

  if (isPointInput(input)) {
    const initial = lazy(`Variable "${name}"`, () => at(['value'], () => {
      const point = parsePoint(definition.value, lookup);
      if (!point) {
        throw new Error(`Variable "${name}" value must be a point [x, y]`);
      }
      return point;
    }));
    const current = () => typeof override === 'object' ? override : initial();
    return {
      cells: [[`${name}.x`, () => current().x], [`${name}.y`, () => current().y]],
      input: () => ({ type: input.type, name, label, value: current(), initial: initial() }),
    };
  }

  // true and false are 1 and 0 in expressions.
  if (typeof definition.value === 'boolean') {
    const initial = definition.value;
    const current = () => typeof override === 'boolean' ? override : initial;
    return {
      cells: [[name, () => Number(current())]],
      input: input?.type === 'checkbox'
        ? () => ({ type: 'checkbox', name, label, value: current(), initial })
        : undefined,
    };
  }

  const initial = variableCell(name, definition, lookup);
  if (input?.type !== 'slider') {
    return { cells: [[name, initial]] };
  }
  const range = lazy(`Slider "${name}"`, () => {
    const min = at(['input', 'min'], () => asNumber(input.min, Number.NaN, lookup));
    const max = at(['input', 'max'], () => asNumber(input.max, Number.NaN, lookup));
    if (!(max > min)) {
      throw new PathError(`Slider "${name}" max must be greater than its min`, ['variables', index, 'input', 'max']);
    }
    const step = input.step === undefined ? undefined : at(['input', 'step'], () => asPositiveNumber(input.step, lookup));
    if (input.step !== undefined && step === undefined) {
      throw new PathError(`Slider "${name}" step must be a positive number`, ['variables', index, 'input', 'step']);
    }
    const start = initial();
    if (start < min || start > max) {
      throw new PathError(`Variable "${name}" value must be between the slider's min and max`, ['variables', index, 'value']);
    }
    return { min, max, step };
  });
  const current = () => typeof override === 'number' ? clamp(override, range().min, range().max) : initial();
  return {
    cells: [[name, current]],
    input: () => ({ type: 'slider', name, label, ...range(), value: current(), initial: initial() }),
  };
}

const fallback = {
    info: { links: [] } as SceneInfo,
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
      coordinates: {
        x: { from: -100, to: 100 },
        y: { from: -100, to: 100 },
      },
      declared: {
        x: { from: -100, to: 100 },
        y: { from: -100, to: 100 },
      },
    },
    elements: [] as DrawableElement[],
};

type YamlNode = YAML.Node | YAML.Pair | null | undefined | unknown;

const nodeRange = (node: YamlNode): [number, number] | undefined =>
  YAML.isNode(node) && node.range ? [node.range[0], node.range[1]] : undefined;

// The key of a pair, extended over its value when that fits on the line.
function pairRange(pair: YAML.Pair): [number, number] | undefined {
  const key = nodeRange(pair.key);
  const value = YAML.isScalar(pair.value) ? nodeRange(pair.value) : undefined;
  return key && value ? [key[0], value[1]] : key;
}

// The first line of a node: a scalar, or the first entry of a collection.
function headRange(node: YamlNode): [number, number] | undefined {
  if (YAML.isMap(node) && YAML.isPair(node.items[0])) {
    return pairRange(node.items[0]);
  }
  if (YAML.isSeq(node) && node.items.length > 0) {
    return headRange(node.items[0]);
  }
  return nodeRange(node);
}

// Finds the text range for a definition path, stopping at the deepest part
// that exists so missing values point at their parent.
function rangeForPath(document: YAML.Document, path: ScenePath): [number, number] {
  let node: YamlNode = document.contents;
  let range = headRange(node) ?? [0, 0];
  for (const key of path) {
    if (YAML.isMap(node)) {
      const keyOf = (item: YAML.Pair) => YAML.isScalar(item.key) ? String(item.key.value) : undefined;
      const pair = node.items.find((item) => keyOf(item) === String(key))
        ?? node.items.find((item) => SPELLINGS[keyOf(item) ?? ''] === String(key));
      if (!pair) {
        break;
      }
      range = (YAML.isScalar(pair.value) ? pairRange(pair) : nodeRange(pair.key)) ?? range;
      node = pair.value;
    } else if (YAML.isSeq(node) && typeof key === 'number' && key < node.items.length) {
      node = node.items[key];
      range = headRange(node) ?? range;
    } else {
      break;
    }
  }
  return range;
}

const yamlDiagnostic = (severity: SceneDiagnostic['severity']) => (error: YAML.YAMLError): SceneDiagnostic => ({
  from: error.pos[0],
  to: error.pos[1],
  severity,
  message: error.message,
});

export type ParsedScene = {
  scene: SceneDefinition;
  warnings: SceneDiagnostic[];
};

// Parses a definition, reporting mistakes with their positions in the text.
// Input values replace the values of variables set while viewing.
export function parseSceneWithDiagnostics(text: string, inputValues: InputValues = new Map()): ParsedScene {
  if (!text.trim()) {
    return { scene: { ...fallback, inputs: [], shading: { mode: 'paint', detail: 0 } }, warnings: [] };
  }
  const document = YAML.parseDocument(text, { prettyErrors: false });
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
  const warnings = document.warnings.map(yamlDiagnostic('warning'));
  if (document.errors.length > 0) {
    const [first] = document.errors;
    throw new SceneError(`Line ${lineOf(first.pos[0])}: ${first.message}`, [
      ...document.errors.map(yamlDiagnostic('error')),
      ...warnings,
    ]);
  }
  try {
    return { scene: sceneFromValue(document.toJS(), inputValues), warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [from, to] = error instanceof PathError ? rangeForPath(document, error.path) : headRange(document.contents) ?? [0, 0];
    throw new SceneError(`Line ${lineOf(from)}: ${message}`, [{ from, to, severity: 'error', message }, ...warnings]);
  }
}

export function parseScene(text: string, inputValues: InputValues = new Map()): SceneDefinition {
  return parseSceneWithDiagnostics(text, inputValues).scene;
}

// With `overflow: auto` the picture is fitted to the content, which may
// depend on pixel sizes, so the scene is rebuilt until the fit settles.
function sceneFromValue(value: unknown, inputValues: InputValues): SceneDefinition {
  let scene = buildScene(value, inputValues, undefined);
  const parsed = normaliseSpellings(value);
  if (!isRecord(parsed) || !isRecord(parsed.view) || parsed.view.overflow !== 'auto') {
    return scene;
  }
  const matchContent = parsed.view.aspect === 'auto';
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const fitted = atPath(['view', 'overflow'], () => fittedView(scene, matchContent));
    if (attempt > 0 && rangesMatch(fitted, scene.view.coordinates)) {
      return scene;
    }
    scene = buildScene(value, inputValues, fitted);
  }
  throw new PathError('overflow: auto could not settle on a size', ['view', 'overflow']);
}

function buildScene(value: unknown, inputValues: InputValues, fitted: ViewRanges | undefined): SceneDefinition {
  const parsed = normaliseSpellings(value);
  if (!isRecord(parsed)) {
    throw new Error('Scene definition must be a YAML object');
  }
  checkKeys(parsed, DEFINITION);

  const sceneRoot = parsed;
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
  const axis = (key: 'x' | 'y') => {
    const path = ['view', 'coordinates', key];
    return lazy(`view.coordinates.${key}`, () => atPath(path, () =>
      parseAxisRange(coordinatesNode[key], fallback.view.coordinates[key], variables, path)));
  };
  const xRange = axis('x');
  const yRange = axis('y');
  // `aspect: auto` follows the coordinates, so scene units are square.
  const resolvedAspect = lazy('view.aspect', () => atPath(['view', 'aspect'], () => viewNode.aspect === 'auto'
    ? Math.abs((xRange().to - xRange().from) / (yRange().to - yRange().from))
    : parseAspectRatio(viewNode.aspect, variables)));
  const autoOverflow = viewNode.overflow === 'auto';
  const overflow = lazy('view.overflow', () => atPath(['view', 'overflow'], () => {
    const value = asNumber(viewNode.overflow, 0, variables);
    if (value < 0) {
      throw new Error('view overflow must not be negative');
    }
    return value;
  }));
  const declared = (): ViewRanges => ({ x: xRange(), y: yRange() });
  const shown = (): ViewRanges => autoOverflow
    ? fitted ?? declared()
    : { x: growAxis(xRange(), overflow()), y: growAxis(yRange(), overflow()) };
  const viewValues: Record<string, () => number> = {
    'view.left': () => xRange().from,
    'view.right': () => xRange().to,
    'view.bottom': () => yRange().from,
    'view.top': () => yRange().to,
    'view.width': () => xRange().to - xRange().from,
    'view.height': () => yRange().to - yRange().from,
    'view.centre.x': () => (xRange().from + xRange().to) / 2,
    'view.centre.y': () => (yRange().from + yRange().to) / 2,
    'view.center.x': () => (xRange().from + xRange().to) / 2,
    'view.center.y': () => (yRange().from + yRange().to) / 2,
    'view.aspect': resolvedAspect,
    ...(autoOverflow ? {} : { 'view.overflow': overflow }),
  };
  Object.entries(viewValues).forEach(([name, value]) => cells.set(name, value));
  const inputBuilders = [...atPath(['variables'], () => parseVariableDefinitions(sceneRoot.variables))]
    .flatMap(([name, definition]) => {
      const defined = defineVariable(name, definition, variables, inputValues.get(name));
      defined.cells.forEach(([cellName, cell]) => cells.set(cellName, cell));
      return defined.input ? [defined.input] : [];
    });
  // Evaluate everything so mistakes in unused variables are still reported.
  cells.forEach((cell) => cell());
  const inputs = inputBuilders.map((build) => build());

  const frameNode = sceneRoot.frame && typeof sceneRoot.frame === 'object' && !Array.isArray(sceneRoot.frame)
    ? (sceneRoot.frame as Record<string, unknown>)
    : {};
    const frameSize = (key: 'width' | 'radius' | 'padding' | 'margin') =>
      atPath(['frame', key], () => asNonNegativeNumber(frameNode[key], fallback.frame[key], variables));
    const frame: FrameDefinition = {
      width: frameSize('width'),
      radius: frameSize('radius'),
      color: atPath(['frame', 'colour'], () => asColour(frameNode.colour, fallback.frame.color, variables)),
      wall: atPath(['frame', 'wall'], () => asColour(frameNode.wall, fallback.frame.wall, variables)),
      background: atPath(['frame', 'background'], () => asColour(frameNode.background, fallback.frame.background, variables)),
      padding: frameSize('padding'),
      margin: frameSize('margin'),
    };
    const coordinates = { x: xRange(), y: yRange() };

    const shading = atPath(['shading'], () => parseShading(sceneRoot.shading, variables));
    const density = shading.mode === 'density';
    if (density && sceneRoot.seed !== undefined) {
      throw new PathError('seed is not used with density shading', ['seed']);
    }
    if (!Array.isArray(sceneRoot.scene)) {
      throw new PathError('scene must be a list of typed items', ['scene']);
    }
    if (
      sceneRoot.seed !== undefined
      && typeof sceneRoot.seed !== 'string'
      && (!sceneRoot.seed || typeof sceneRoot.seed !== 'object' || Array.isArray(sceneRoot.seed))
    ) {
      throw new PathError('seed must be a colour string or an object', ['seed']);
    }
    const seedNode = sceneRoot.seed && typeof sceneRoot.seed === 'object' && !Array.isArray(sceneRoot.seed)
      ? (sceneRoot.seed as Record<string, unknown>)
      : {};
    const elements = resolveSceneElements(
      parseSceneItems(sceneRoot.scene),
      resolvedAspect(),
      viewFrame(coordinates),
      variables,
      density,
    ).map((element) => element.kind === 'zoom'
      ? reframeZoom(element, viewFrame(coordinates), viewFrame(shown()))
      : element);

    return {
      info: atPath(['info'], () => parseInfo(sceneRoot.info)),
      inputs,
      shading,
      frame,
      seed: {
        color: typeof sceneRoot.seed === 'string'
          ? atPath(['seed'], () => asColour(sceneRoot.seed, fallback.seed.color, variables))
          : atPath(['seed', 'colour'], () => asColour(seedNode.colour, fallback.seed.color, variables)),
        opacity: parseOpacity(seedNode, fallback.seed.opacity, variables, ['seed']),
      },
      view: {
        aspect: resolvedAspect(),
        coordinates: shown(),
        declared: declared(),
      },
      elements,
    };
}
