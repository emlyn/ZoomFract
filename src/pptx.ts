import type {
  CircleElement,
  DrawableElement,
  Glow,
  PolygonElement,
  RectElement,
  SceneDefinition,
  ShapeElement,
  ShapeFill,
  Vec2,
  ZoomElement,
} from './scene';
import { sample, toRgb, type ColourValue } from './values';
import { MITER_LIMIT } from './outline';

// A PowerPoint file with one slide holding the scene's top level: shapes
// become vector shapes, and zooms become Slide Zooms of the slide itself, so
// PowerPoint draws the recursion. Each zoom carries a picture of the slide
// for PowerPoint to show until it redraws, and for viewers without zooms.

const EMU_PER_INCH = 914400;
const SLIDE_SHORT_SIDE = 7.5 * EMU_PER_INCH;
const SLIDE_MAX_SIDE = 56 * EMU_PER_INCH;
const SLIDE_MIN_SIDE = EMU_PER_INCH;
const SLIDE_ID = 256;
const SLIDE_CREATION_ID = 2380184264;
// PowerPoint angles are in 60000ths of a degree.
const ANGLE_UNITS = 60000;
const SQUARE_TOLERANCE = 1e-6;

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const NS_P166 = 'http://schemas.microsoft.com/office/powerpoint/2016/6/main';
const NS_PSLZ = 'http://schemas.microsoft.com/office/powerpoint/2016/slidezoom';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PML = 'application/vnd.openxmlformats-officedocument.presentationml';

// --- zip -------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

const crc32 = (data: Uint8Array) =>
  (data.reduce((crc, byte) => CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

type ZipEntry = { name: string; data: Uint8Array };

// Little-endian fields as [offset, bytes, value]; unlisted bytes stay zero.
function record(size: number, fields: [number, 2 | 4, number][]) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  for (const [offset, width, value] of fields) {
    if (width === 2) {
      view.setUint16(offset, value, true);
    } else {
      view.setUint32(offset, value, true);
    }
  }
  return bytes;
}

// An uncompressed zip. The parts are small apart from the already
// compressed picture, so compression would save little.
function zip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = record(30, [
      [0, 4, 0x04034b50], [4, 2, 20], [14, 4, crc], [18, 4, data.length], [22, 4, data.length], [26, 2, nameBytes.length],
    ]);
    parts.push(local, nameBytes, data);
    directory.push(record(46, [
      [0, 4, 0x02014b50], [4, 2, 20], [6, 2, 20], [16, 4, crc], [20, 4, data.length], [24, 4, data.length],
      [28, 2, nameBytes.length], [42, 4, offset],
    ]), nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directorySize = directory.reduce((total, part) => total + part.length, 0);
  const end = record(22, [
    [0, 4, 0x06054b50], [8, 2, entries.length], [10, 2, entries.length], [12, 4, directorySize], [16, 4, offset],
  ]);
  return new Blob([...parts, ...directory, end].map((part) => part.slice().buffer), { type: `${PML}.presentation` });
}

// --- units -----------------------------------------------------------------

const escapeXml = (text: string) => text
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const xml = (body: string) => new TextEncoder().encode(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${body}`,
);

let colorContext: CanvasRenderingContext2D | null = null;

// Any CSS colour as sRGB hex and opacity, read back from a drawn pixel.
function rgba(color: string) {
  if (!colorContext) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    colorContext = canvas.getContext('2d', { willReadFrequently: true });
    if (!colorContext) {
      throw new Error('Could not create a canvas to read colours');
    }
  }
  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillStyle = color;
  colorContext.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
  const hex = [r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { hex, alpha: a / 255 };
}

function colorXml(color: string, opacity: number) {
  const { hex, alpha } = rgba(color);
  const total = alpha * opacity;
  const alphaXml = total >= 1 ? '' : `<a:alpha val="${Math.round(total * 100000)}"/>`;
  return `<a:srgbClr val="${hex}">${alphaXml}</a:srgbClr>`;
}

function stopColorXml(color: ColourValue, opacity: number) {
  const hex = toRgb(color).map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255)
    .toString(16).padStart(2, '0')).join('').toUpperCase();
  const alpha = Math.round(Math.max(0, Math.min(1, color.a)) * opacity * 100000);
  return `<a:srgbClr val="${hex}">${alpha === 100000 ? '' : `<a:alpha val="${alpha}"/>`}</a:srgbClr>`;
}

const visible = (color: string, opacity: number) => opacity > 0 && rgba(color).alpha > 0;

function slideSize(aspect: number) {
  const long = Math.min(SLIDE_MAX_SIDE, SLIDE_SHORT_SIDE * Math.max(aspect, 1 / aspect));
  const short = long / Math.max(aspect, 1 / aspect);
  if (short < SLIDE_MIN_SIDE) {
    throw new Error('PowerPoint slides cannot be this long and thin');
  }
  return aspect >= 1 ? { width: long, height: short } : { width: short, height: long };
}

// A frame is placed by its unrotated box and turned about its centre,
// clockwise on the slide, after an optional vertical flip.
type Placement = { x: number; y: number; cx: number; cy: number; rot: number; flipV: boolean };

// Scene units to slide EMUs. The slide's top edge is the top of the y range.
function slideMapping(scene: SceneDefinition, width: number, height: number) {
  const { x, y } = scene.view.coordinates;
  const scaleX = width / (x.to - x.from);
  const scaleY = -height / (y.to - y.from);
  const vector = (v: Vec2): Vec2 => ({ x: v.x * scaleX, y: v.y * scaleY });
  const point = (p: Vec2): Vec2 => ({ x: (p.x - x.from) * scaleX, y: (p.y - y.to) * scaleY });
  const unpoint = (p: Vec2): Vec2 => ({ x: p.x / scaleX + x.from, y: p.y / scaleY + y.to });
  const length = (size: number) => size * Math.sqrt(Math.abs(scaleX * scaleY));
  return { vector, point, unpoint, length };
}

function fillFrame(element: ShapeElement, mapping: ReturnType<typeof slideMapping>) {
  if (element.kind === 'rect') {
    const c = Math.cos(element.rotation), s = Math.sin(element.rotation);
    const across = { x: c * element.width, y: s * element.width };
    const down = { x: s * element.height, y: -c * element.height };
    const mappedAcross = mapping.vector(across), mappedDown = mapping.vector(down);
    return {
      origin: { x: element.center.x - (across.x + down.x) / 2, y: element.center.y - (across.y + down.y) / 2 },
      across, down,
      width: Math.hypot(mappedAcross.x, mappedAcross.y),
      height: Math.hypot(mappedDown.x, mappedDown.y),
    };
  }
  const points = element.kind === 'polygon' ? element.points : [
    { x: element.center.x - element.radius, y: element.center.y - element.radius },
    { x: element.center.x + element.radius, y: element.center.y + element.radius },
  ];
  const mapped = points.map(mapping.point);
  const left = Math.min(...mapped.map((p) => p.x)), top = Math.min(...mapped.map((p) => p.y));
  const width = Math.max(...mapped.map((p) => p.x)) - left, height = Math.max(...mapped.map((p) => p.y)) - top;
  const origin = mapping.unpoint({ x: left, y: top });
  const right = mapping.unpoint({ x: left + width, y: top }), bottom = mapping.unpoint({ x: left, y: top + height });
  return { origin, width, height, across: { x: right.x - origin.x, y: right.y - origin.y },
    down: { x: bottom.x - origin.x, y: bottom.y - origin.y } };
}

function fillCoordinates(fill: ShapeFill, frame: ReturnType<typeof fillFrame>) {
  const [a, b, c, d, e, f] = fill.mapping;
  return {
    u: a * frame.origin.x + c * frame.origin.y + e,
    v: b * frame.origin.x + d * frame.origin.y + f,
    ux: a * frame.across.x + c * frame.across.y, vx: b * frame.across.x + d * frame.across.y,
    uy: a * frame.down.x + c * frame.down.y, vy: b * frame.down.x + d * frame.down.y,
  };
}

function radialGeometry(fill: ShapeFill, frame: ReturnType<typeof fillFrame>) {
  const { u, v, ux, uy, vx, vy } = fillCoordinates(fill, frame);
  const xScale = Math.hypot(ux, vx) / frame.width, yScale = Math.hypot(uy, vy) / frame.height;
  if (Math.abs(xScale - yScale) > SQUARE_TOLERANCE * Math.max(xScale, yScale)
    || Math.abs(ux * uy + vx * vy) > SQUARE_TOLERANCE * Math.hypot(ux, vx) * Math.hypot(uy, vy)) return undefined;
  const determinant = ux * vy - uy * vx;
  const x = (uy * v - vy * u) / determinant, y = (vx * u - ux * v) / determinant;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  return { x, y, radius: 1 / xScale };
}

function gradientXml(element: ShapeElement, mapping: ReturnType<typeof slideMapping>) {
  const fill = element.fill!;
  const frame = fillFrame(element, mapping);
  let start = 0, span = 1, geometry: string;
  if (fill.kind === 'linear') {
    const { u, ux, uy } = fillCoordinates(fill, frame);
    start = u + Math.min(0, ux) + Math.min(0, uy);
    span = Math.abs(ux) + Math.abs(uy);
    const angle = Math.atan2(uy / frame.height, ux / frame.width) * 180 / Math.PI;
    geometry = `<a:lin ang="${Math.round((angle + 360) % 360 * ANGLE_UNITS)}" scaled="0"/><a:tileRect/>`;
  } else {
    const radial = radialGeometry(fill, frame);
    if (!radial) throw new Error('This radial gradient needs an image fill');
    const half = Math.max(Math.abs(radial.x * frame.width), Math.abs((1 - radial.x) * frame.width),
      Math.abs(radial.y * frame.height), Math.abs((1 - radial.y) * frame.height));
    span = half * Math.sqrt(2) / radial.radius;
    const percent = (value: number) => Math.round(value * 100000);
    geometry = `<a:path path="circle"><a:fillToRect l="${percent(radial.x)}" t="${percent(radial.y)}"`
      + ` r="${percent(1 - radial.x)}" b="${percent(1 - radial.y)}"/></a:path>`
      + `<a:tileRect l="${percent(radial.x - half / frame.width)}" t="${percent(radial.y - half / frame.height)}"`
      + ` r="${percent(1 - radial.x - half / frame.width)}" b="${percent(1 - radial.y - half / frame.height)}"/>`;
  }
  // PowerPoint eases between stops. Closely spaced samples preserve the ramp's
  // interpolation space without leaving it to PowerPoint's own interpolation.
  const positions = new Set(Array.from({ length: 257 }, (_, i) => Math.round(i / 256 * 100000)));
  for (let i = 0; i <= 256; i++) {
    const position = (i / 256 - start) / span;
    if (position > 0 && position < 1) positions.add(Math.round(position * 100000));
  }
  fill.ramp.stops.forEach((stop) => {
    const position = (stop.position - start) / span;
    if (position > 0 && position < 1) positions.add(Math.round(position * 100000));
  });
  const stops = [...positions].sort((a, b) => a - b).map((position) =>
    `<a:gs pos="${position}">${stopColorXml(sample(fill.ramp, start + span * position / 100000), element.opacity)}</a:gs>`).join('');
  return `<a:gradFill flip="none" rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${geometry}</a:gradFill>`;
}

export async function powerPointGradientPictures(scene: SceneDefinition, resolution: { width: number; height: number }): Promise<Map<number, Uint8Array>> {
  const size = slideSize(scene.view.aspect);
  const mapping = slideMapping(scene, size.width, size.height);
  const pictures = new Map<number, Uint8Array>();
  for (const [index, element] of scene.elements.entries()) {
    if (element.kind === 'zoom' || element.opacity <= 0 || !element.fill || element.fill.kind !== 'radial') continue;
    const frame = fillFrame(element, mapping);
    if (radialGeometry(element.fill, frame)) continue;
    const requestedWidth = frame.width / size.width * resolution.width;
    const requestedHeight = frame.height / size.height * resolution.height;
    const fit = Math.min(1, 1920 / Math.max(requestedWidth, requestedHeight));
    const width = Math.max(1, Math.ceil(requestedWidth * fit));
    const height = Math.max(1, Math.ceil(requestedHeight * fit));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Gradient export needs a 2D canvas');
    const image = context.createImageData(width, height);
    const coordinates = fillCoordinates(element.fill, frame);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tx = (x + 0.5) / width, ty = (y + 0.5) / height;
        const t = Math.hypot(coordinates.u + coordinates.ux * tx + coordinates.uy * ty,
          coordinates.v + coordinates.vx * tx + coordinates.vy * ty);
        const colour = sample(element.fill.ramp, t);
        const offset = (y * width + x) * 4;
        toRgb(colour).forEach((channel, i) => { image.data[offset + i] = Math.round(Math.max(0, Math.min(1, channel)) * 255); });
        image.data[offset + 3] = Math.round(Math.max(0, Math.min(1, colour.a)) * element.opacity * 255);
      }
    }
    context.putImageData(image, 0, 0);
    pictures.set(index, new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  }
  return pictures;
}

function outlineXml(element: ShapeElement, mapping: ReturnType<typeof slideMapping>) {
  const outline = element.outline;
  if (!outline || outline.thickness === 0 || !visible(outline.color, outline.opacity * element.opacity)) return '<a:ln><a:noFill/></a:ln>';
  const x = Math.abs(mapping.vector({ x: 1, y: 0 }).x);
  const y = Math.abs(mapping.vector({ x: 0, y: 1 }).y);
  if (Math.abs(x - y) > SQUARE_TOLERANCE * Math.max(x, y)) {
    throw new Error('Shape outlines need equally sized x and y units in PowerPoint');
  }
  return `<a:ln w="${Math.max(1, Math.round(mapping.length(outline.thickness)))}" algn="ctr">`
    + `<a:solidFill>${colorXml(outline.color, outline.opacity * element.opacity)}</a:solidFill>`
    + (outline.joins === 'round' ? '<a:round/>' : `<a:miter lim="${MITER_LIMIT * 100000}"/>`) + '</a:ln>';
}

function shapeFillXml(element: ShapeElement, mapping: ReturnType<typeof slideMapping>, pictureId?: number) {
  if (element.opacity <= 0) return '<a:noFill/>';
  if (pictureId !== undefined) return `<a:blipFill rotWithShape="1"><a:blip r:embed="rId${pictureId}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`;
  return element.fill ? gradientXml(element, mapping) : `<a:solidFill>${colorXml(element.color, element.opacity)}</a:solidFill>`;
}

// An element's box on the slide. Its edges are the images of the scene's
// right and downward directions, which must stay square to each other.
function placement(element: RectElement | ZoomElement, mapping: ReturnType<typeof slideMapping>): Placement {
  const turn = (v: Vec2): Vec2 => ({
    x: v.x * Math.cos(element.rotation) - v.y * Math.sin(element.rotation),
    y: v.x * Math.sin(element.rotation) + v.y * Math.cos(element.rotation),
  });
  const across = mapping.vector(turn({ x: element.width, y: 0 }));
  const down = mapping.vector(turn({ x: 0, y: -element.height }));
  const angle = Math.atan2(across.y, across.x);
  const cx = Math.hypot(across.x, across.y);
  const along = down.x * Math.cos(angle) + down.y * Math.sin(angle);
  const cy = down.y * Math.cos(angle) - down.x * Math.sin(angle);
  if (Math.abs(along) > SQUARE_TOLERANCE * Math.max(cx, Math.abs(cy))) {
    throw new Error(`${element.name ?? `A ${element.kind}`} would be slanted in PowerPoint because x and y units differ in size`);
  }
  const centre = mapping.point(element.center);
  const degrees = (angle * 180) / Math.PI;
  return {
    x: Math.round(centre.x - cx / 2),
    y: Math.round(centre.y - Math.abs(cy) / 2),
    cx: Math.round(cx),
    cy: Math.round(Math.abs(cy)),
    rot: Math.round((((degrees % 360) + 360) % 360) * ANGLE_UNITS) % (360 * ANGLE_UNITS),
    flipV: cy < 0,
  };
}

function transformXml(tag: string, { x, y, cx, cy, rot, flipV }: Placement, atOrigin = false) {
  const attributes = `${rot === 0 ? '' : ` rot="${rot}"`}${flipV ? ' flipV="1"' : ''}`;
  const offset = atOrigin ? '<a:off x="0" y="0"/>' : `<a:off x="${x}" y="${y}"/>`;
  return `<${tag}${attributes}>${offset}<a:ext cx="${cx}" cy="${cy}"/></${tag}>`;
}

const glowXml = (glow: Glow | undefined, mapping: ReturnType<typeof slideMapping>) =>
  glow && visible(glow.color, glow.opacity)
  ? `<a:effectLst><a:glow rad="${Math.max(1, Math.round(mapping.length(glow.size)))}">${colorXml(glow.color, glow.opacity)}</a:glow></a:effectLst>`
  : '';

// --- limits ----------------------------------------------------------------

// Parts of the scene that the PowerPoint file cannot show as ZoomFract does,
// with a colour to show beside the text where one helps.
// The seed needs nothing: the zooms bottom out in the rendered picture.
export type PowerPointLimit = { text: string; color?: string };

function powerPointFadeWarning(scene: SceneDefinition): PowerPointLimit | null {
  const zooms = scene.elements.filter((element) => element.kind === 'zoom' && element.opacity > 0);
  const drawsItself = scene.elements.some((element) =>
    (element.kind !== 'zoom' && (element.fill
      ? element.opacity > 0 && element.fill.ramp.stops.some((stop) => stop.colour.a > 0)
      : visible(element.color, element.opacity)))
    || (element.kind !== 'zoom' && element.outline !== undefined
      && element.outline.thickness > 0 && visible(element.outline.color, element.outline.opacity * element.opacity))
    || (element.glow !== undefined && visible(element.glow.color, element.glow.opacity)));
  if (drawsItself || zooms.length === 0 || !visible(scene.seed.color, scene.seed.opacity)) {
    return null;
  }
  const seed = `#${rgba(scene.seed.color).hex}`;
  return {
    text: 'Only the seed draws anything, so PowerPoint may fade the picture to nothing as it updates the zooms. '
      + `Covering the slide with a rectangle in the seed colour, ${seed}, and then deleting it brings it back for a while`,
    color: seed,
  };
}

export function powerPointLimits(scene: SceneDefinition): PowerPointLimit[] {
  const zooms = scene.elements.filter((element) => element.kind === 'zoom' && element.opacity > 0);
  const mapping = slideMapping(scene, scene.view.aspect, 1);
  return [
    scene.elements.some((element) => element.kind !== 'zoom' && element.fill?.kind === 'radial'
      && !radialGeometry(element.fill, fillFrame(element, mapping)))
      ? { text: 'Radial gradients with elliptical geometry or an external centre use image fills to preserve their appearance; their stops are not editable in PowerPoint' }
      : null,
    scene.shading.mode === 'density' ? { text: 'Density shading is not available, so shapes are drawn in black' } : null,
    zooms.some((zoom) => zoom.opacity < 1) ? { text: 'Zoom opacity is ignored' } : null,
    zooms.some((zoom) => zoom.kind === 'zoom' && zoom.blend !== 'normal')
      ? { text: 'Zoom blend modes are ignored' }
      : null,
    scene.shading.mode === 'paint' && scene.shading.detail !== 0
      ? { text: 'Shading detail is ignored; PowerPoint shrinks copies like detail: average' }
      : null,
    scene.elements.some((element) => element.glow)
      ? { text: 'Glows use PowerPoint\u2019s own soft edge, so their softness is ignored' }
      : null,
    scene.elements.some((element) => element.kind === 'zoom' && element.glow !== undefined
      && element.glow.sourceOpacity > 0)
      ? { text: 'Custom zoom glow sourceOpacity is ignored' }
      : null,
    powerPointFadeWarning(scene),
  ].filter((limit): limit is PowerPointLimit => limit !== null);
}

// --- the file --------------------------------------------------------------

const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const guid = (id: number) => `{6184D655-31FA-EE49-9346-${id.toString(16).toUpperCase().padStart(12, '0')}}`;

function shapeXml(element: DrawableElement, id: number, mapping: ReturnType<typeof slideMapping>, pictureId?: number) {
  if (element.kind === 'circle' || element.kind === 'polygon') {
    return polygonShapeXml(element, id, mapping, pictureId);
  }
  const place = placement(element, mapping);
  if (element.kind === 'rect') {
    const name = escapeXml(element.name ?? `Rectangle ${id}`);
    const fill = shapeFillXml(element, mapping, pictureId);
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
      + `<p:spPr>${transformXml('a:xfrm', place)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}`
      + `${outlineXml(element, mapping)}${glowXml(element.glow, mapping)}</p:spPr>`
      + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>';
  }
  const name = escapeXml(element.name ?? `Slide Zoom ${id}`);
  // PowerPoint draws a zoom's glow around the shapes it shows, as ZoomFract does.
  const glow = glowXml(element.glow, mapping);
  // showBg="0" leaves the zoom transparent, so copies show through each other.
  const zoom = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/>`
    + '<p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
    + transformXml('p:xfrm', place)
    + `<a:graphic><a:graphicData uri="${NS_PSLZ}">`
    + `<pslz:sldZm><pslz:sldZmObj sldId="${SLIDE_ID}" cId="${SLIDE_CREATION_ID}">`
    + `<pslz:zmPr id="${guid(id)}" returnToParent="0" transitionDur="1000" showBg="0">`
    + `<p166:blipFill xmlns:p166="${NS_P166}"><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p166:blipFill>`
    + `<p166:spPr xmlns:p166="${NS_P166}">${transformXml('a:xfrm', place, true)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${glow}</p166:spPr>`
    + '</pslz:zmPr></pslz:sldZmObj></pslz:sldZm></a:graphicData></a:graphic></p:graphicFrame>';
  const picture = `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}">`
    + '<a:hlinkClick r:id="rId3" action="ppaction://hlinksldjump"/></p:cNvPr>'
    + '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
    + '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
    + `<p:spPr>${transformXml('a:xfrm', place)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${glow}</p:spPr></p:pic>`;
  return `<mc:AlternateContent xmlns:mc="${NS_MC}">`
    + `<mc:Choice xmlns:pslz="${NS_PSLZ}" Requires="pslz">${zoom}</mc:Choice>`
    + `<mc:Fallback>${picture}</mc:Fallback></mc:AlternateContent>`;
}

function polygonShapeXml(
  element: CircleElement | PolygonElement,
  id: number,
  mapping: ReturnType<typeof slideMapping>,
  pictureId?: number,
) {
  const points = element.kind === 'polygon'
    ? element.points
    : Array.from({ length: 128 }, (_, index) => ({
      x: element.center.x + Math.cos(index * Math.PI * 2 / 128) * element.radius,
      y: element.center.y + Math.sin(index * Math.PI * 2 / 128) * element.radius,
    }));
  const mapped = points.map(mapping.point);
  const left = Math.min(...mapped.map((point) => point.x));
  const top = Math.min(...mapped.map((point) => point.y));
  const width = Math.max(...mapped.map((point) => point.x)) - left;
  const height = Math.max(...mapped.map((point) => point.y)) - top;
  const coordinates = mapped.map((point) => ({
    x: Math.round((point.x - left) / width * 100000),
    y: Math.round((point.y - top) / height * 100000),
  }));
  const [first, ...rest] = coordinates;
  const commands = `<a:moveTo><a:pt x="${first.x}" y="${first.y}"/></a:moveTo>`
    + rest.map((point) => `<a:lnTo><a:pt x="${point.x}" y="${point.y}"/></a:lnTo>`).join('')
    + '<a:close/>';
  const name = escapeXml(element.name ?? `${element.kind === 'circle' ? 'Circle' : 'Polygon'} ${id}`);
  const fill = shapeFillXml(element, mapping, pictureId);
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(left)}" y="${Math.round(top)}"/>`
    + `<a:ext cx="${Math.max(1, Math.round(width))}" cy="${Math.max(1, Math.round(height))}"/></a:xfrm>`
    + (element.kind === 'circle' ? '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'
      : `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="100000" b="100000"/>`
      + `<a:pathLst><a:path w="100000" h="100000" fill="norm" stroke="1">${commands}</a:path></a:pathLst></a:custGeom>`)
    + `${fill}${outlineXml(element, mapping)}</p:spPr>`
    + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>';
}

// `picture` is a PNG of the rendered scene, with transparent background.
export function powerPointFile(scene: SceneDefinition, picture: Uint8Array, background?: Uint8Array, gradientPictures: ReadonlyMap<number, Uint8Array> = new Map()): Blob {
  if (scene.background.length && !background) throw new Error('PowerPoint export needs the rendered background image');
  const { width, height } = slideSize(scene.view.aspect);
  const mapping = slideMapping(scene, width, height);
  const shapes = scene.elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => element.kind === 'zoom'
      ? element.opacity > 0
      : element.opacity > 0 || (element.glow !== undefined && visible(element.glow.color, element.glow.opacity)))
    .map(({ element, index }) => shapeXml(element, index + 2, mapping, gradientPictures.has(index) ? index + 6 : undefined))
    .join('');
  const roots = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
  const rels = (body: string) => xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`);
  const relation = (id: number, type: string, target: string) => `<Relationship Id="rId${id}" Type="${REL}/${type}" Target="${target}"/>`;
  const title = scene.info.title ? ` name="${escapeXml(scene.info.title)}"` : '';
  const fadeWarning = powerPointFadeWarning(scene);

  const slide = xml(`<p:sld ${roots}><p:cSld${title}>`
    + `<p:bg><p:bgPr>${background
      ? '<a:blipFill><a:blip r:embed="rId5"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>'
      : `<a:solidFill>${colorXml(scene.frame.background, 1)}</a:solidFill>`}<a:effectLst/></p:bgPr></p:bg>`
    + `${EMPTY_TREE}${shapes}</p:spTree>`
    + '<p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}">'
    + `<p14:creationId xmlns:p14="${NS_P14}" val="${SLIDE_CREATION_ID}"/></p:ext></p:extLst>`
    + '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');

  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const theme = xml(`<a:theme xmlns:a="${NS_A}" name="ZoomFract"><a:themeElements>`
    + '<a:clrScheme name="ZoomFract"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
    + '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>'
    + '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
    + '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
    + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'
    + '<a:fontScheme name="ZoomFract"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
    + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
    + `<a:fmtScheme name="ZoomFract"><a:fillStyleLst>${solid.repeat(3)}</a:fillStyleLst>`
    + `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}">${solid}</a:ln>`).join('')}</a:lnStyleLst>`
    + `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>`
    + `<a:bgFillStyleLst>${solid.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);

  const master = xml(`<p:sldMaster ${roots}><p:cSld>${EMPTY_TREE}</p:spTree></p:cSld>`
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
    + 'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>');

  const layout = xml(`<p:sldLayout ${roots} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:spTree></p:cSld>`
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');

  const presentation = xml(`<p:presentation ${roots}>`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483660" r:id="rId1"/></p:sldMasterIdLst>'
    + (fadeWarning ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId4"/></p:notesMasterIdLst>' : '')
    + `<p:sldIdLst><p:sldId id="${SLIDE_ID}" r:id="rId2"/></p:sldIdLst>`
    + `<p:sldSz cx="${Math.round(width)}" cy="${Math.round(height)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);

  const notesMaster = fadeWarning
    ? xml(`<p:notesMaster ${roots}><p:cSld>${EMPTY_TREE}</p:spTree></p:cSld>`
      + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
      + 'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>')
    : null;
  const notesSlide = fadeWarning
    ? xml(`<p:notes ${roots}><p:cSld><p:spTree>${EMPTY_TREE.slice('<p:spTree>'.length)}`
      + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr txBox="1"/>'
      + '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>'
      + `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(`Warning: ${fadeWarning.text}.`)}</a:t></a:r>`
      + '<a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld>'
      + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>')
    : null;

  const override = (part: string, type: string) => `<Override PartName="/ppt/${part}" ContentType="${type}"/>`;
  const contentTypes = xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + override('presentation.xml', `${PML}.presentation.main+xml`)
    + override('slideMasters/slideMaster1.xml', `${PML}.slideMaster+xml`)
    + override('slideLayouts/slideLayout1.xml', `${PML}.slideLayout+xml`)
    + override('slides/slide1.xml', `${PML}.slide+xml`)
    + override('theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml')
    + (fadeWarning
      ? override('notesMasters/notesMaster1.xml', `${PML}.notesMaster+xml`)
        + override('notesSlides/notesSlide1.xml', `${PML}.notesSlide+xml`)
      : '')
    + '</Types>');

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels(relation(1, 'officeDocument', 'ppt/presentation.xml')) },
    { name: 'ppt/presentation.xml', data: presentation },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: rels(relation(1, 'slideMaster', 'slideMasters/slideMaster1.xml')
        + relation(2, 'slide', 'slides/slide1.xml')
        + relation(3, 'theme', 'theme/theme1.xml')
        + (fadeWarning ? relation(4, 'notesMaster', 'notesMasters/notesMaster1.xml') : '')),
    },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: rels(relation(1, 'slideLayout', '../slideLayouts/slideLayout1.xml') + relation(2, 'theme', '../theme/theme1.xml')),
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels(relation(1, 'slideMaster', '../slideMasters/slideMaster1.xml')) },
    { name: 'ppt/theme/theme1.xml', data: theme },
    { name: 'ppt/slides/slide1.xml', data: slide },
    {
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: rels(relation(1, 'slideLayout', '../slideLayouts/slideLayout1.xml')
        + relation(2, 'image', '../media/image1.png')
        + relation(3, 'slide', 'slide1.xml')
        + (background ? relation(5, 'image', '../media/background.png') : '')
        + [...gradientPictures.keys()].map((index) => relation(index + 6, 'image', `../media/gradient${index}.png`)).join('')
        + (fadeWarning ? relation(4, 'notesSlide', '../notesSlides/notesSlide1.xml') : '')),
    },
    { name: 'ppt/media/image1.png', data: picture },
  ];
  if (background) entries.push({ name: 'ppt/media/background.png', data: background });
  for (const [index, data] of gradientPictures) entries.push({ name: `ppt/media/gradient${index}.png`, data });
  if (fadeWarning && notesMaster && notesSlide) {
    entries.push(
      { name: 'ppt/notesMasters/notesMaster1.xml', data: notesMaster },
      { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: rels(relation(1, 'theme', '../theme/theme1.xml')) },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: notesSlide },
      {
        name: 'ppt/notesSlides/_rels/notesSlide1.xml.rels',
        data: rels(relation(1, 'notesMaster', '../notesMasters/notesMaster1.xml')
          + relation(2, 'slide', '../slides/slide1.xml')),
      },
    );
  }
  return zip(entries);
}
