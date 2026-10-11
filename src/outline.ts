import earcut from 'earcut';
import ClipperLib from 'clipper-lib';
import type { ShapeElement, Vec2 } from './scene';

export const MITER_LIMIT = 4;
type Pair = [number, number];
type Polygon = Pair[][];

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec2, n: number): Vec2 => ({ x: a.x * n, y: a.y * n });
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;

export function outlineTriangles(shape: ShapeElement, tolerance = 0.001): Vec2[][] {
  const outline = shape.outline;
  if (!outline || outline.thickness === 0 || outline.opacity === 0) return [];
  const half = outline.thickness / 2;
  const circle = (centre: Vec2, radius: number): Vec2[] => {
    const count = Math.max(16, Math.min(512, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tolerance / radius)))));
    return Array.from({ length: count }, (_, i) => add(centre, {
      x: radius * Math.cos(i * 2 * Math.PI / count), y: radius * Math.sin(i * 2 * Math.PI / count),
    }));
  };
  const pieces: Polygon[] = [];
  const polygon = (points: Vec2[]): Polygon => [points.map((p): Pair => [p.x, p.y])];
  if (shape.kind === 'circle') {
    const outer = circle(shape.center, shape.radius + half);
    const inner = shape.radius > half ? circle(shape.center, shape.radius - half) : [];
    const rings = polygon(outer);
    if (inner.length) rings.push(polygon(inner)[0]);
    pieces.push(rings);
  } else {
    const points = shape.kind === 'polygon' ? shape.points : [
      { x: -shape.width / 2, y: shape.height / 2 }, { x: shape.width / 2, y: shape.height / 2 },
      { x: shape.width / 2, y: -shape.height / 2 }, { x: -shape.width / 2, y: -shape.height / 2 },
    ].map((p) => add(shape.center, {
      x: p.x * Math.cos(shape.rotation) - p.y * Math.sin(shape.rotation),
      y: p.x * Math.sin(shape.rotation) + p.y * Math.cos(shape.rotation),
    }));
    const directions = points.map((p, i) => {
      const next = points[(i + 1) % points.length];
      const length = Math.hypot(next.x - p.x, next.y - p.y);
      return { x: (next.x - p.x) / length, y: (next.y - p.y) / length };
    });
    points.forEach((p, i) => {
      const next = points[(i + 1) % points.length], direction = directions[i];
      const normal = { x: -direction.y * half, y: direction.x * half };
      pieces.push(polygon([add(p, normal), add(next, normal), add(next, scale(normal, -1)), add(p, scale(normal, -1))]));
      const previous = directions[(i + points.length - 1) % points.length];
      const turn = cross(previous, direction);
      if (Math.abs(turn) < 1e-12) return;
      if (outline.joins === 'round') {
        pieces.push(polygon(circle(p, half)));
        return;
      }
      const sign = -Math.sign(turn);
      const a = add(p, { x: -previous.y * half * sign, y: previous.x * half * sign });
      const b = add(p, scale(normal, sign));
      const distance = cross({ x: b.x - a.x, y: b.y - a.y }, direction) / turn;
      const tip = add(a, scale(previous, distance));
      pieces.push(polygon(Math.hypot(tip.x - p.x, tip.y - p.y) <= MITER_LIMIT * half
        ? [p, a, tip, b] : [p, a, b]));
    });
  }
  // Union before triangulating so translucent joins and overlapping thick
  // strokes are painted once, including around holes and concave corners.
  const points = pieces.flat(2);
  const origin = points.reduce<Pair>((min, p) => [Math.min(min[0], p[0]), Math.min(min[1], p[1])], [Infinity, Infinity]);
  const extent = points.reduce((max, p) => Math.max(max, Math.abs(p[0] - origin[0]), Math.abs(p[1] - origin[1])), 0);
  const precision = Math.min(Math.max(64 / tolerance, 1024 / half), 1e12 / Math.max(extent, half));
  if (half * precision < 1) throw new Error('Outline is too thin relative to the shape coordinates');
  const clipper = new ClipperLib.Clipper();
  for (const rings of pieces) {
    rings.forEach((ring, index) => {
      const path = ring.map(([x, y]) => ({ X: Math.round((x - origin[0]) * precision), Y: Math.round((y - origin[1]) * precision) }));
      // Very shallow corner wedges can collapse below the integer precision.
      if (ClipperLib.Clipper.Area(path) === 0) return;
      if (ClipperLib.Clipper.Orientation(path) !== (index === 0)) path.reverse();
      if (!clipper.AddPath(path, ClipperLib.PolyType.ptSubject, true)) throw new Error('Could not construct outline geometry');
    });
  }
  const tree = new ClipperLib.PolyTree();
  if (!clipper.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) {
    throw new Error('Could not combine outline geometry');
  }
  return ClipperLib.JS.PolyTreeToExPolygons(tree).flatMap(({ outer, holes: inner }) => {
    const rings = [outer, ...inner];
    const vertices: number[] = [], holes: number[] = [];
    rings.forEach((ring, i) => {
      if (i) holes.push(vertices.length / 2);
      ring.forEach(({ X, Y }) => vertices.push(X / precision + origin[0], Y / precision + origin[1]));
    });
    const indices = earcut(vertices, holes);
    const triangles: Vec2[][] = [];
    for (let i = 0; i < indices.length; i += 3) {
      triangles.push(indices.slice(i, i + 3).map((index) => ({ x: vertices[index * 2], y: vertices[index * 2 + 1] })));
    }
    return triangles;
  });
}
