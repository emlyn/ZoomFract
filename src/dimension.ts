// Fractal dimension of the set the zooms build by repeating forever.
//
// When every zoom is a similarity (equal scale on both axes) and the copies
// of the picture's outline do not overlap (the open set condition), the
// dimension is the d solving sum(n * r^d) = 1 (Moran's equation), which has
// a closed form when every scale is r or r^2. If the copies cover the whole
// outline, the picture is solid and the dimension is 2. Otherwise it is
// estimated by box counting.

import { convexHull, viewFrame, zoomMap, type SceneDefinition, type Vec2, type ZoomElement } from './scene';

type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

export type FractalDimension = {
  // The formula and value, e.g. "log(3) / log(2) ≈ 1.585".
  text: string;
  // The similarity dimension, when overlapping copies make it higher.
  similarity?: string;
};

const TOLERANCE = 1e-9;
const BOX_WORK_LIMIT = 100000;
const BOX_NODE_LIMIT = 100000;
const DISTINCT_LIMIT = 20000;
const COVER_SAMPLES = 128;

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const apply = (m: Affine, p: Vec2): Vec2 => ({ x: m.a * p.x + m.b * p.y + m.e, y: m.c * p.x + m.d * p.y + m.f });

const compose = (outer: Affine, inner: Affine): Affine => ({
  a: outer.a * inner.a + outer.b * inner.c,
  b: outer.a * inner.b + outer.b * inner.d,
  c: outer.c * inner.a + outer.d * inner.c,
  d: outer.c * inner.b + outer.d * inner.d,
  e: outer.a * inner.e + outer.b * inner.f + outer.e,
  f: outer.c * inner.e + outer.d * inner.f + outer.f,
});

const singularValues = ({ a, b, c, d }: Affine): [number, number] => {
  const sum = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  const largest = Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2);
  return [largest, largest > 0 ? Math.abs(det) / largest : 0];
};

function affineOf(zoom: ZoomElement, scene: SceneDefinition): Affine {
  const map = zoomMap(zoom, viewFrame(scene.view.coordinates));
  const origin = map({ x: 0, y: 0 });
  const ex = map({ x: 1, y: 0 });
  const ey = map({ x: 0, y: 1 });
  return { a: ex.x - origin.x, b: ey.x - origin.x, c: ex.y - origin.y, d: ey.y - origin.y, e: origin.x, f: origin.y };
}

const sameMap = (left: Affine, right: Affine, size: number) =>
  [left.a - right.a, left.b - right.b, left.c - right.c, left.d - right.d].every((v) => Math.abs(v) < TOLERANCE)
  && Math.abs(left.e - right.e) < TOLERANCE * size
  && Math.abs(left.f - right.f) < TOLERANCE * size;

const extent = (points: Vec2[]) => Math.max(
  Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)),
  Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)),
);

// The convex hull of the limit set is the fixed point of hull(copies of the
// hull), approached geometrically from any start.
function attractorHull(maps: Affine[], start: Vec2[], shrink: number): Vec2[] {
  let hull = convexHull(start);
  for (let iteration = 0; iteration < 5000; iteration += 1) {
    const next = convexHull(maps.flatMap((map) => hull.map((point) => apply(map, point))));
    const change = Math.abs(extent(next) - extent(hull))
      + Math.abs(next.reduce((sum, p) => sum + p.x + p.y, 0) / next.length - hull.reduce((sum, p) => sum + p.x + p.y, 0) / hull.length);
    hull = next;
    if (change * shrink <= TOLERANCE * extent(hull) * (1 - shrink)) {
      break;
    }
  }
  return hull;
}

const polygonArea = (points: Vec2[]) => points.reduce((area, point, index) => {
  const next = points[(index + 1) % points.length];
  return area + point.x * next.y - next.x * point.y;
}, 0) / 2;

const edgeNormals = (polygon: Vec2[]) => polygon.map((point, index) => {
  const next = polygon[(index + 1) % polygon.length];
  const length = Math.hypot(next.x - point.x, next.y - point.y);
  return { x: (next.y - point.y) / length, y: (point.x - next.x) / length };
});

const projection = (polygon: Vec2[], axis: Vec2) => {
  const values = polygon.map((p) => p.x * axis.x + p.y * axis.y);
  return [Math.min(...values), Math.max(...values)];
};

// Convex polygons whose interiors do not meet have a separating edge normal;
// touching edges and corners count as separate.
const interiorsDisjoint = (left: Vec2[], right: Vec2[], tolerance: number) =>
  [...edgeNormals(left), ...edgeNormals(right)].some((axis) => {
    const [leftMin, leftMax] = projection(left, axis);
    const [rightMin, rightMax] = projection(right, axis);
    return leftMax <= rightMin + tolerance || rightMax <= leftMin + tolerance;
  });

// Anticlockwise convex polygon.
const insideConvex = (polygon: Vec2[], point: Vec2, tolerance: number) => polygon.every((start, index) => {
  const end = polygon[(index + 1) % polygon.length];
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  return ((end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)) / length >= -tolerance;
});

// Whether the copies of the hull cover it, sampled on a grid. Each copy lies
// inside the hull, so covering it makes the hull itself the limit set.
function copiesCover(hull: Vec2[], copies: Vec2[][], size: number) {
  const xs = hull.map((p) => p.x);
  const ys = hull.map((p) => p.y);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const step = size / COVER_SAMPLES;
  for (let i = 0; i < COVER_SAMPLES; i += 1) {
    for (let j = 0; j < COVER_SAMPLES; j += 1) {
      const point = { x: minX + (i + 0.5) * step, y: minY + (j + 0.5) * step };
      if (insideConvex(hull, point, -step * 0.01) && !copies.some((copy) => insideConvex(copy, point, TOLERANCE * size))) {
        return false;
      }
    }
  }
  return true;
}

// Box counting: expand the zoom tree until every copy fits in a fine box,
// then count the boxes their centres occupy at that and each coarser size.
// Only copies that coincide exactly are merged.
function boxCountingDimension(maps: Affine[], hull: Vec2[], size: number): number | null {
  const centre = {
    x: hull.reduce((sum, p) => sum + p.x, 0) / hull.length,
    y: hull.reduce((sum, p) => sum + p.y, 0) / hull.length,
  };
  const [minX, minY] = [Math.min(...hull.map((p) => p.x)), Math.min(...hull.map((p) => p.y))];
  let frontier = [IDENTITY];
  let finest = 0;
  let work = 0;
  for (let level = 1; level <= 24; level += 1) {
    const box = size / 2 ** level;
    const stack = [...frontier];
    const next = new Map<string, Affine>();
    while (stack.length > 0 && work <= BOX_WORK_LIMIT && next.size <= BOX_NODE_LIMIT) {
      const node = stack.pop()!;
      const [scale] = singularValues(node);
      if (scale * size > box) {
        work += 1;
        stack.push(...maps.map((map) => compose(node, map)));
        continue;
      }
      const quantum = Math.max(scale, 1e-12) * 1e-6;
      next.set([node.a, node.b, node.c, node.d, node.e / size, node.f / size].map((v) => Math.round(v / quantum)).join(','), node);
    }
    if (stack.length > 0) {
      break;
    }
    frontier = [...next.values()];
    finest = level;
  }
  const cells = frontier.map((node) => {
    const point = apply(node, centre);
    return [Math.floor((point.x - minX) / size * 2 ** finest), Math.floor((point.y - minY) / size * 2 ** finest)];
  });
  const counts = Array.from({ length: finest }, (_, index) => {
    const shift = finest - index - 1;
    return [index + 1, Math.log2(new Set(cells.map(([x, y]) => `${x >> shift},${y >> shift}`)).size)] as [number, number];
  });
  return fitSlope(counts.slice(0, -2));
}

// Least-squares slope over the finest levels, where the count settles.
function fitSlope(counts: [number, number][]): number | null {
  const used = counts.filter(([level]) => level >= 2).slice(-5);
  if (used.length < 3) {
    return null;
  }
  const meanX = used.reduce((sum, [x]) => sum + x, 0) / used.length;
  const meanY = used.reduce((sum, [, y]) => sum + y, 0) / used.length;
  const slope = used.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0)
    / used.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  return Math.min(2, Math.max(0, slope));
}

// Solves sum(count * ratio^d) = 1, which decreases in d.
function moranDimension(groups: { ratio: number; count: number }[]): number {
  const excess = (d: number) => groups.reduce((sum, { ratio, count }) => sum + count * ratio ** d, 0) - 1;
  let [low, high] = [0, 1];
  while (excess(high) > 0) {
    [low, high] = [high, high * 2];
  }
  for (let step = 0; step < 100; step += 1) {
    const middle = (low + high) / 2;
    if (excess(middle) > 0) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const near = (value: number, target: number) => Math.abs(value - target) < TOLERANCE * Math.max(1, Math.abs(target));

// An exact name for a number: an integer, a small fraction or a square root.
type Nice = { text: string; integer?: number; root?: number };

function niceNumber(value: number): Nice | null {
  if (near(value, Math.round(value))) {
    return { text: String(Math.round(value)), integer: Math.round(value) };
  }
  for (let denominator = 2; denominator <= 12; denominator += 1) {
    const numerator = Math.round(value * denominator);
    if (near(value * denominator, numerator) && gcd(numerator, denominator) === 1) {
      return { text: `${numerator}/${denominator}` };
    }
  }
  const square = Math.round(value * value);
  if (square <= 10000 && near(value * value, square)) {
    return { text: `\u221a${square}`, root: square };
  }
  return null;
}

// The smallest base and exponent with base^exponent = value.
function perfectPower(value: number): [number, number] {
  for (let base = 2; base * base <= value; base += 1) {
    let [power, exponent] = [base, 1];
    while (power < value) {
      [power, exponent] = [power * base, exponent + 1];
    }
    if (power === value) {
      return [base, exponent];
    }
  }
  return [value, 1];
}

const formatValue = (value: number) => String(Number(value.toFixed(3)));

// log(count) / log(1 / ratio), reduced to a number when both are powers of
// one base.
function singleScaleFormula(count: number, ratio: number, value: number): string | null {
  const inverse = niceNumber(1 / ratio);
  if (inverse === null) {
    return null;
  }
  const formula = `log(${count}) / log(${inverse.text})`;
  const target = inverse.integer ?? inverse.root;
  if (target !== undefined && count > 1) {
    const [countBase, countExponent] = perfectPower(count);
    const [targetBase, targetExponent] = perfectPower(target);
    if (countBase === targetBase) {
      const numerator = countExponent * (inverse.root === undefined ? 1 : 2);
      const divisor = gcd(numerator, targetExponent);
      const [top, bottom] = [numerator / divisor, targetExponent / divisor];
      const exact = bottom === 1 || Number.isInteger(top / bottom * 1000) ? formatValue(top / bottom) : `${top}/${bottom}`;
      return `${formula} = ${exact}`;
    }
  }
  return `${formula} \u2248 ${formatValue(value)}`;
}

// With counts n1 at r and n2 at r^2, x = r^d solves n1 x + n2 x^2 = 1, so
// 1/x = (n1 + sqrt(n1^2 + 4 n2)) / 2.
function twoScaleFormula(first: { ratio: number; count: number }, second: { ratio: number; count: number }, value: number) {
  const inverse = niceNumber(1 / first.ratio);
  if (inverse === null || !near(second.ratio, first.ratio ** 2)) {
    return null;
  }
  const discriminant = first.count ** 2 + 4 * second.count;
  const root = Math.round(Math.sqrt(discriminant));
  const growth = root * root === discriminant
    ? niceNumber((first.count + root) / 2)?.text
    : first.count === 1 && second.count === 1
      ? '\u03c6'
      : `(${first.count} + \u221a${discriminant})/2`;
  return growth === undefined ? null : `log(${growth}) / log(${inverse.text}) \u2248 ${formatValue(value)}`;
}

// The similarity dimension solves sum(ratio^d) = 1, as if no copies overlap.
function similarityDimension(ratios: number[]): { value: number; text: string } {
  const groups = [...ratios].sort((a, b) => b - a)
    .reduce<{ ratio: number; count: number }[]>((all, ratio) => {
      const last = all[all.length - 1];
      return last && near(last.ratio, ratio)
        ? [...all.slice(0, -1), { ...last, count: last.count + 1 }]
        : [...all, { ratio, count: 1 }];
    }, []);
  const value = moranDimension(groups);
  const formula = groups.length === 1
    ? singleScaleFormula(groups[0].count, groups[0].ratio, value)
    : groups.length === 2
      ? twoScaleFormula(groups[0], groups[1], value)
      : null;
  return { value, text: formula ?? (near(value, Math.round(value)) ? String(Math.round(value)) : `\u2248 ${formatValue(value)}`) };
}

function computeDimension(scene: SceneDefinition): FractalDimension | null {
  const zooms = scene.elements.filter((element): element is ZoomElement => element.kind === 'zoom' && element.opacity > 0);
  if (zooms.length === 0) {
    return null;
  }
  const view = viewFrame(scene.view.coordinates);
  const viewSize = Math.max(Math.abs(view.width), Math.abs(view.height));
  const maps = zooms.map((zoom) => affineOf(zoom, scene))
    .filter((map, index, all) => !all.slice(0, index).some((other) => sameMap(other, map, viewSize)));
  const scales = maps.map(singularValues);
  const shrink = Math.max(...scales.map(([largest]) => largest));
  if (shrink >= 1 - TOLERANCE) {
    return null;
  }
  const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({
    x: view.centre.x + sx * view.width / 2,
    y: view.centre.y + sy * view.height / 2,
  })));
  const hull = attractorHull(maps, corners, shrink);
  const size = extent(hull);
  if (!(size > 0)) {
    return { text: '0' };
  }
  const similar = scales.every(([largest, smallest]) => largest - smallest <= TOLERANCE * largest);
  const similarity = similar ? similarityDimension(scales.map(([ratio]) => ratio)) : null;
  // Shown alongside only when overlaps make the picture's dimension lower.
  const withSimilarity = (text: string, value: number): FractalDimension =>
    similarity && similarity.value > value + 0.005 ? { text, similarity: similarity.text } : { text };
  const hasArea = Math.abs(polygonArea(hull)) > TOLERANCE * size * size;
  const copies = maps.map((map) => convexHull(hull.map((point) => apply(map, point))));
  if (hasArea && copiesCover(hull, copies, size)) {
    return withSimilarity('2', 2);
  }
  if (!similarity) {
    const estimate = boxCountingDimension(maps, hull, size);
    return estimate === null ? null : { text: `\u2248 ${estimate.toFixed(2)}` };
  }
  const separated = hasArea && copies.every((copy, index) =>
    copies.slice(index + 1).every((other) => interiorsDisjoint(copy, other, TOLERANCE * size)));
  // Overlapping copies only lower the dimension below min(2, similarity)
  // when some compositions coincide exactly (Hochman), so count distinct ones.
  const growth = separated ? null : distinctGrowth(maps, scales.map(([ratio]) => ratio), viewSize);
  if (growth !== null) {
    const estimate = Math.min(2, growth);
    return withSimilarity(`\u2248 ${estimate.toFixed(2)}`, estimate);
  }
  return similarity.value > 2 + TOLERANCE ? withSimilarity('2', 2) : { text: similarity.text };
}
// Expands compositions in generations cut at powers of the largest ratio,
// merging ones that coincide. Returns null if none ever coincide, otherwise
// the growth rate of the distinct count as a dimension estimate.
function distinctGrowth(maps: Affine[], ratios: number[], size: number): number | null {
  const largest = Math.max(...ratios);
  const counts: number[] = [];
  let frontier: { map: Affine; scale: number }[] = [{ map: IDENTITY, scale: 1 }];
  let merged = false;
  for (let level = 1; level <= 60; level += 1) {
    const cut = largest ** level * (1 + 1e-9);
    const seen = new Set<string>();
    const next: { map: Affine; scale: number }[] = [];
    const stack = [...frontier];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.scale > cut) {
        stack.push(...maps.map((map, index) => ({ map: compose(node.map, map), scale: node.scale * ratios[index] })));
        continue;
      }
      const quantum = node.scale * 1e-6;
      const { a, b, c, d, e, f } = node.map;
      const key = [a, b, c, d].map((v) => Math.round(v / quantum))
        .concat([e, f].map((v) => Math.round(v / (quantum * size)))).join(',');
      if (seen.has(key)) {
        merged = true;
      } else {
        seen.add(key);
        next.push(node);
      }
    }
    counts.push(next.length);
    frontier = next;
    if (next.length > DISTINCT_LIMIT) {
      break;
    }
  }
  if (!merged || counts.length < 2) {
    return null;
  }
  const span = Math.min(3, counts.length - 1);
  const last = counts.length - 1;
  return Math.log(counts[last] / counts[last - span]) / (span * Math.log(1 / largest));
}

const cache = new WeakMap<SceneDefinition, FractalDimension | null>();

export function fractalDimension(scene: SceneDefinition): FractalDimension | null {
  if (!cache.has(scene)) {
    cache.set(scene, computeDimension(scene));
  }
  return cache.get(scene) ?? null;
}
