import type { DrawableElement, Glow, SceneDefinition, Vec2 } from './scene';

// A PowerPoint file with one slide holding the scene's top level: rects
// become rectangles, and zooms become Slide Zooms of the slide itself, so
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
  const length = (size: number) => size * Math.sqrt(Math.abs(scaleX * scaleY));
  return { vector, point, length };
}

// An element's box on the slide. Its edges are the images of the scene's
// right and downward directions, which must stay square to each other.
function placement(element: DrawableElement, mapping: ReturnType<typeof slideMapping>): Placement {
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

const glowXml = (glow: Glow | undefined, mapping: ReturnType<typeof slideMapping>) => glow && visible(glow.color, glow.opacity)
  ? `<a:effectLst><a:glow rad="${Math.round(mapping.length(glow.size))}">${colorXml(glow.color, glow.opacity)}</a:glow></a:effectLst>`
  : '';

// --- limits ----------------------------------------------------------------

// Parts of the scene that the PowerPoint file cannot show as ZoomFract does,
// with a colour to show beside the text where one helps.
// The seed needs nothing: the zooms bottom out in the rendered picture.
export type PowerPointLimit = { text: string; color?: string };

export function powerPointLimits(scene: SceneDefinition): PowerPointLimit[] {
  const zooms = scene.elements.filter((element) => element.kind === 'zoom' && element.opacity > 0);
  const drawsItself = scene.elements.some((element) =>
    (element.kind === 'rect' && visible(element.color, element.opacity))
    || (element.glow !== undefined && visible(element.glow.color, element.glow.opacity)));
  const seed = `#${rgba(scene.seed.color).hex}`;
  return [
    scene.shading.mode === 'density' ? { text: 'Density shading is not available, so shapes are drawn in black' } : null,
    zooms.some((zoom) => zoom.opacity < 1) ? { text: 'Zoom opacity is ignored' } : null,
    scene.elements.some((element) => element.glow)
      ? { text: 'Glows use PowerPoint\u2019s own soft edge, so their softness is ignored' }
      : null,
    !drawsItself && zooms.length > 0 && visible(scene.seed.color, scene.seed.opacity)
      ? {
        text: 'Only the seed draws anything, so PowerPoint may fade the picture to nothing as it updates the zooms. '
          + `Covering the slide with a rectangle in the seed colour, ${seed}, and then deleting it brings it back for a while`,
        color: seed,
      }
      : null,
  ].filter((limit): limit is PowerPointLimit => limit !== null);
}

// --- the file --------------------------------------------------------------

const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const guid = (id: number) => `{6184D655-31FA-EE49-9346-${id.toString(16).toUpperCase().padStart(12, '0')}}`;

function shapeXml(element: DrawableElement, id: number, mapping: ReturnType<typeof slideMapping>) {
  const place = placement(element, mapping);
  if (element.kind === 'rect') {
    const name = escapeXml(element.name ?? `Rectangle ${id}`);
    const fill = element.opacity > 0 ? `<a:solidFill>${colorXml(element.color, element.opacity)}</a:solidFill>` : '<a:noFill/>';
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
      + `<p:spPr>${transformXml('a:xfrm', place)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}`
      + `<a:ln><a:noFill/></a:ln>${glowXml(element.glow, mapping)}</p:spPr>`
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

// `picture` is a PNG of the rendered scene, with transparent background.
export function powerPointFile(scene: SceneDefinition, picture: Uint8Array): Blob {
  const { width, height } = slideSize(scene.view.aspect);
  const mapping = slideMapping(scene, width, height);
  const shapes = scene.elements
    .filter((element) => element.kind === 'zoom'
      ? element.opacity > 0
      : element.opacity > 0 || (element.glow !== undefined && visible(element.glow.color, element.glow.opacity)))
    .map((element, index) => shapeXml(element, index + 2, mapping))
    .join('');
  const roots = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
  const rels = (body: string) => xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`);
  const relation = (id: number, type: string, target: string) => `<Relationship Id="rId${id}" Type="${REL}/${type}" Target="${target}"/>`;
  const title = scene.info.title ? ` name="${escapeXml(scene.info.title)}"` : '';

  const slide = xml(`<p:sld ${roots}><p:cSld${title}>`
    + `<p:bg><p:bgPr><a:solidFill>${colorXml(scene.frame.background, 1)}</a:solidFill><a:effectLst/></p:bgPr></p:bg>`
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
    + `<p:sldIdLst><p:sldId id="${SLIDE_ID}" r:id="rId2"/></p:sldIdLst>`
    + `<p:sldSz cx="${Math.round(width)}" cy="${Math.round(height)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);

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
    + '</Types>');

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels(relation(1, 'officeDocument', 'ppt/presentation.xml')) },
    { name: 'ppt/presentation.xml', data: presentation },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: rels(relation(1, 'slideMaster', 'slideMasters/slideMaster1.xml')
        + relation(2, 'slide', 'slides/slide1.xml')
        + relation(3, 'theme', 'theme/theme1.xml')),
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
        + relation(3, 'slide', 'slide1.xml')),
    },
    { name: 'ppt/media/image1.png', data: picture },
  ]);
}
