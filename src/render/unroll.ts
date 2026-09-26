import type { SceneDefinition, Vec2 } from '../scene';
import { elementCorners } from './common';

// x' = a x + c y + e, y' = b x + d y + f
type Affine = [number, number, number, number, number, number];

type ZoomNode = {
  transform: Affine;
  clip: Vec2[];
  alpha: number;
  size: number;
  generation: number;
  children: (ZoomNode | null)[] | null;
};

export type UnrolledItem =
  | { kind: 'rect'; polygon: Vec2[]; elementIndex: number; alpha: number }
  | { kind: 'leaf'; polygon: Vec2[]; texCoords: Vec2[]; alpha: number };

export type UnrollOptions = {
  maximumDepth: number;
  // Expand whole generations regardless of size, rather than largest first.
  uniform: boolean;
  budget: number;
  minimumZoomPixels: number;
  topLevelZoomOpacity: number;
};

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

const applyAffine = ([a, b, c, d, e, f]: Affine, point: Vec2): Vec2 => ({
  x: a * point.x + c * point.y + e,
  y: b * point.x + d * point.y + f,
});

const composeAffine = (outer: Affine, inner: Affine): Affine => {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
};

const invertAffine = ([a, b, c, d, e, f]: Affine): Affine => {
  const determinant = a * d - b * c;
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
};

const cross = (origin: Vec2, first: Vec2, second: Vec2) =>
  (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);

const signedArea = (polygon: Vec2[]) => polygon.reduce((total, point, index) => {
  const next = polygon[(index + 1) % polygon.length];
  return total + point.x * next.y - next.x * point.y;
}, 0) / 2;

// Sutherland-Hodgman clipping of a convex subject against a convex clip polygon.
function clipPolygon(subject: Vec2[], clip: Vec2[]): Vec2[] {
  const orientation = Math.sign(signedArea(clip));
  if (orientation === 0) {
    return [];
  }
  let output = subject;
  for (let index = 0; index < clip.length && output.length > 0; index += 1) {
    const edgeStart = clip[index];
    const edgeEnd = clip[(index + 1) % clip.length];
    const inside = (point: Vec2) => cross(edgeStart, edgeEnd, point) * orientation >= 0;
    const intersect = (from: Vec2, to: Vec2): Vec2 => {
      const fromSide = cross(edgeStart, edgeEnd, from);
      const t = fromSide / (fromSide - cross(edgeStart, edgeEnd, to));
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    };
    const input = output;
    output = [];
    input.forEach((current, pointIndex) => {
      const previous = input[(pointIndex + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) {
          output.push(intersect(previous, current));
        }
        output.push(current);
      } else if (inside(previous)) {
        output.push(intersect(previous, current));
      }
    });
  }
  return Math.abs(signedArea(output)) > 1e-9 ? output : [];
}

const maximumEdge = (polygon: Vec2[]) => Math.max(...polygon.map((point, index) => {
  const next = polygon[(index + 1) % polygon.length];
  return Math.hypot(next.x - point.x, next.y - point.y);
}));

// Pushes onto a max-heap ordered by projected zoom size.
function heapPush(heap: ZoomNode[], node: ZoomNode) {
  heap.push(node);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent].size >= heap[index].size) {
      break;
    }
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function heapPop(heap: ZoomNode[]): ZoomNode | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < heap.length && heap[left].size > heap[largest].size) {
        largest = left;
      }
      if (right < heap.length && heap[right].size > heap[largest].size) {
        largest = right;
      }
      if (largest === index) {
        break;
      }
      [heap[largest], heap[index]] = [heap[index], heap[largest]];
      index = largest;
    }
  }
  return top;
}

/**
 * Expands the scene into exact, clipped geometry in working pixels. Zooms are
 * expanded largest first, up to the maximum depth, until the item budget runs
 * out or they become small; the remaining zooms become leaves that sample a
 * rendered texture.
 */
export function unrollScene(
  scene: SceneDefinition,
  factor: number,
  options: UnrollOptions,
): { items: UnrolledItem[]; expandedZooms: number; shallowestLeaf: number } {
  const width = scene.view.resolution.width * factor;
  const height = scene.view.resolution.height * factor;
  const elementPolygons = scene.elements.map((element) =>
    elementCorners(element, scene).map((point) => ({ x: point.x * factor, y: point.y * factor })));
  const zoomTransforms = scene.elements.map((element, index): Affine | null => {
    if (element.kind !== 'zoom') {
      return null;
    }
    const [topLeft, topRight, , bottomLeft] = elementPolygons[index];
    return [
      (topRight.x - topLeft.x) / width,
      (topRight.y - topLeft.y) / width,
      (bottomLeft.x - topLeft.x) / height,
      (bottomLeft.y - topLeft.y) / height,
      topLeft.x,
      topLeft.y,
    ];
  });

  const expand = (node: ZoomNode, isRoot: boolean) => {
    node.children = scene.elements.map((element, index) => {
      const zoomTransform = zoomTransforms[index];
      if (element.kind !== 'zoom' || !zoomTransform) {
        return null;
      }
      const quad = elementPolygons[index].map((point) => applyAffine(node.transform, point));
      const clip = clipPolygon(quad, node.clip);
      if (clip.length === 0) {
        return null;
      }
      return {
        transform: composeAffine(node.transform, zoomTransform),
        clip,
        alpha: node.alpha * element.opacity * (isRoot ? options.topLevelZoomOpacity : 1),
        size: maximumEdge(quad),
        generation: node.generation + 1,
        children: null,
      };
    });
  };

  const root: ZoomNode = {
    transform: IDENTITY,
    clip: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }],
    alpha: 1,
    size: Infinity,
    generation: 0,
    children: null,
  };
  expand(root, true);

  const heap: ZoomNode[] = [];
  const enqueueChildren = (node: ZoomNode) => node.children?.forEach((child) => {
    if (child && child.generation <= options.maximumDepth && child.size > options.minimumZoomPixels) {
      heapPush(heap, child);
    }
  });
  enqueueChildren(root);
  let itemCount = scene.elements.length;
  let expandedZooms = 0;
  const expandCost = scene.elements.length - 1;
  if (options.uniform) {
    // Whole generations only, so every leaf sits at the same depth.
    let frontier = heap.splice(0);
    for (let generation = 1; generation <= options.maximumDepth && frontier.length > 0; generation += 1) {
      if (itemCount + frontier.length * expandCost > options.budget) {
        break;
      }
      frontier.forEach((node) => expand(node, false));
      itemCount += frontier.length * expandCost;
      expandedZooms += frontier.length;
      frontier = frontier.flatMap((node) => (node.children ?? []).filter((child): child is ZoomNode => child !== null));
    }
  }
  while (heap.length > 0 && itemCount + expandCost <= options.budget) {
    const node = heapPop(heap)!;
    expand(node, false);
    itemCount += expandCost;
    expandedZooms += 1;
    enqueueChildren(node);
  }

  const items: UnrolledItem[] = [];
  let shallowestLeaf = Infinity;
  const emit = (node: ZoomNode) => {
    scene.elements.forEach((element, index) => {
      if (element.kind === 'rect') {
        const polygon = clipPolygon(
          elementPolygons[index].map((point) => applyAffine(node.transform, point)),
          node.clip,
        );
        if (polygon.length > 0) {
          items.push({ kind: 'rect', polygon, elementIndex: index, alpha: node.alpha * element.opacity });
        }
        return;
      }
      const child = node.children?.[index];
      if (!child) {
        return;
      }
      if (child.children) {
        emit(child);
        return;
      }
      const inverse = invertAffine(child.transform);
      shallowestLeaf = Math.min(shallowestLeaf, child.generation);
      items.push({
        kind: 'leaf',
        polygon: child.clip,
        texCoords: child.clip.map((point) => {
          const viewPoint = applyAffine(inverse, point);
          return { x: viewPoint.x / width, y: 1 - viewPoint.y / height };
        }),
        alpha: child.alpha,
      });
    });
  };
  emit(root);

  return { items, expandedZooms, shallowestLeaf };
}
