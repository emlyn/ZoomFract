export type PointValue = { kind?: 'point'; x: number; y: number };
// Extended, linear XYZ (D65). Neither gamut nor alpha is clipped here.
export type ColourValue = { kind: 'colour'; x: number; y: number; z: number; a: number };
export const MIXING_SPACES = ['linear-srgb', 'oklab', 'oklch'] as const;
export type MixingSpace = typeof MIXING_SPACES[number];
export const HUE_PATHS = ['shorter', 'longer', 'increasing', 'decreasing'] as const;
export type HuePath = typeof HUE_PATHS[number];
export type GradientValue = {
  kind: 'gradient';
  stops: { position: number; colour: ColourValue }[];
  space: MixingSpace;
  hue: HuePath;
};
export type ComponentsValue = { kind: 'components'; components: Record<string, number> };
export type Value = number | boolean | string | PointValue | ColourValue | GradientValue | ComponentsValue;

export const isPoint = (value: Value): value is PointValue =>
  typeof value === 'object' && !('kind' in value);
export const isColourValue = (value: Value): value is ColourValue =>
  typeof value === 'object' && 'kind' in value && value.kind === 'colour';
export const isGradient = (value: Value): value is GradientValue =>
  typeof value === 'object' && 'kind' in value && value.kind === 'gradient';
export const numeric = (value: Value): number => {
  if (typeof value !== 'number') throw new Error('Expected a number');
  return value;
};
export const boolean = (value: Value): boolean => {
  if (typeof value !== 'boolean') throw new Error('Expected a boolean');
  return value;
};
export const pointValue = (value: Value): PointValue => {
  if (!isPoint(value)) throw new Error('Expected a point');
  return value;
};
export const colourValue = (value: Value): ColourValue => {
  if (!isColourValue(value)) throw new Error('Expected a colour');
  return value;
};
export const mixingSpace = (value: unknown): MixingSpace => {
  if (!MIXING_SPACES.some((space) => space === value)) throw new Error('Mixing space must be linear-srgb, oklab or oklch');
  return value as MixingSpace;
};
export const huePath = (value: unknown): HuePath => {
  if (!HUE_PATHS.some((path) => path === value)) throw new Error('Hue path must be shorter, longer, increasing or decreasing');
  return value as HuePath;
};
const decode = (n: number) => Math.abs(n) <= 0.04045 ? n / 12.92 : Math.sign(n) * ((Math.abs(n) + 0.055) / 1.055) ** 2.4;
const encode = (n: number) => Math.abs(n) <= 0.0031308 ? n * 12.92 : Math.sign(n) * (1.055 * Math.abs(n) ** (1 / 2.4) - 0.055);
export const linearRgb = (r: number, g: number, b: number, a = 1): ColourValue => ({
  kind: 'colour', x: 0.4123908 * r + 0.3575843 * g + 0.1804808 * b,
  y: 0.212639 * r + 0.7151687 * g + 0.0721923 * b,
  z: 0.0193308 * r + 0.1191948 * g + 0.9505322 * b, a,
});
export const rgb = (r: number, g: number, b: number, a = 1) => linearRgb(decode(r), decode(g), decode(b), a);
export const toLinearRgb = (c: ColourValue): [number, number, number] => [
  3.2409699 * c.x - 1.5373832 * c.y - 0.4986108 * c.z,
  -0.9692436 * c.x + 1.8759675 * c.y + 0.0415551 * c.z,
  0.0556301 * c.x - 0.203977 * c.y + 1.0569715 * c.z,
];
export const toRgb = (c: ColourValue) => toLinearRgb(c).map(encode);
export function oklab(l: number, a: number, b: number, alpha = 1): ColourValue {
  const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return linearRgb(4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss, alpha);
}
export const oklch = (l: number, c: number, h: number, alpha = 1) =>
  oklab(l, c * Math.cos(h * Math.PI / 180), c * Math.sin(h * Math.PI / 180), alpha);
export function toOklab(c: ColourValue): [number, number, number] {
  const [r, g, b] = toLinearRgb(c);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function hsl(h: number, s: number, l: number, alpha = 1): ColourValue {
  h = ((h % 360) + 360) % 360 / 60;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(h % 2 - 1));
  const m = l - c / 2;
  const channels = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return rgb(channels[0] + m, channels[1] + m, channels[2] + m, alpha);
}
export function colourComponents(c: ColourValue, space: 'rgb' | 'hsl' | 'oklch'): ComponentsValue {
  const [r, g, b] = toRgb(c);
  if (space === 'rgb') return { kind: 'components', components: { r, g, b, a: c.a } };
  if (space === 'oklch') {
    const [l, a, bb] = toOklab(c);
    return { kind: 'components', components: { l, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360, a: c.a } };
  }
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  const hue = d === 0 ? 0 : max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { kind: 'components', components: { h: (hue * 60 + 360) % 360, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l, a: c.a } };
}
export function component(value: Value, name: string): number {
  if (isPoint(value) && (name === 'x' || name === 'y')) return value[name];
  if (isColourValue(value)) return component(colourComponents(value, 'rgb'), name);
  if (typeof value === 'object' && 'kind' in value && value.kind === 'components' && Object.hasOwn(value.components, name)) {
    return value.components[name];
  }
  throw new Error(`Value has no component "${name}"`);
}
export function combine(a: Value, b: Value, operation: '+' | '-'): Value {
  const f = (x: number, y: number) => operation === '+' ? x + y : x - y;
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  if (isPoint(a) && isPoint(b)) return { x: f(a.x, b.x), y: f(a.y, b.y) };
  if (isColourValue(a) && isColourValue(b)) return { kind: 'colour', x: f(a.x, b.x), y: f(a.y, b.y), z: f(a.z, b.z), a: f(a.a, b.a) };
  throw new Error(`${operation} needs two numbers, two points or two colours`);
}
export function scale(value: Value, factor: number): Value {
  if (typeof value === 'number') return value * factor;
  if (isPoint(value)) return { x: value.x * factor, y: value.y * factor };
  if (isColourValue(value)) return { kind: 'colour', x: value.x * factor, y: value.y * factor, z: value.z * factor, a: value.a * factor };
  throw new Error('Only numbers, points and colours can be scaled');
}
export function interpolate(a: Value, b: Value, t: number, space: MixingSpace, hue: HuePath = 'shorter'): Value {
  if (!isColourValue(a) || !isColourValue(b) || space === 'linear-srgb') {
    return combine(a, scale(combine(b, a, '-'), t), '+');
  }
  const aa = toOklab(a), bb = toOklab(b);
  const alpha = a.a + (b.a - a.a) * t;
  if (space === 'oklab') return oklab(aa[0] + (bb[0] - aa[0]) * t, aa[1] + (bb[1] - aa[1]) * t, aa[2] + (bb[2] - aa[2]) * t, alpha);
  const ca = Math.hypot(aa[1], aa[2]), cb = Math.hypot(bb[1], bb[2]);
  let ha = Math.atan2(aa[2], aa[1]), hb = Math.atan2(bb[2], bb[1]);
  if (ca < 1e-7) ha = hb;
  if (cb < 1e-7) hb = ha;
  const increasing = ((hb - ha) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const shorter = increasing > Math.PI ? increasing - 2 * Math.PI : increasing;
  const difference = hue === 'increasing' ? increasing : hue === 'decreasing' ? increasing === 0 ? 0 : increasing - 2 * Math.PI
    : hue === 'longer' ? shorter >= 0 ? shorter - 2 * Math.PI : shorter + 2 * Math.PI : shorter;
  return oklch(aa[0] + (bb[0] - aa[0]) * t, ca + (cb - ca) * t, (ha + difference * t) * 180 / Math.PI, alpha);
}
export function sample(gradient: GradientValue, t: number): ColourValue {
  const stops = gradient.stops;
  if (t <= stops[0].position) return stops[0].colour;
  const index = stops.findIndex((stop) => stop.position > t);
  if (index < 0) return stops[stops.length - 1].colour;
  const a = stops[index - 1], b = stops[index];
  return colourValue(interpolate(a.colour, b.colour, (t - a.position) / (b.position - a.position), gradient.space, gradient.hue));
}
export function makeGradient(stops: GradientValue['stops'], space: MixingSpace, hue: HuePath = 'shorter'): GradientValue {
  if (stops.length < 2) throw new Error('A gradient needs at least two stops');
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  sorted.forEach((stop, index) => {
    if (!Number.isFinite(stop.position) || stop.position < 0 || stop.position > 1) throw new Error('Gradient stop positions must be from 0 to 1');
    if (index && stop.position === sorted[index - 1].position) throw new Error('Gradient stop positions must be distinct');
  });
  return { kind: 'gradient', stops: sorted, space, hue };
}
export function checkValue(value: Value): Value {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Expression does not evaluate to a finite number');
  if (typeof value === 'object') {
    const numbers = isPoint(value) ? [value.x, value.y] : isColourValue(value) ? [value.x, value.y, value.z, value.a]
      : 'kind' in value && value.kind === 'components' ? Object.values(value.components) : [];
    if (numbers.some((n) => !Number.isFinite(n))) throw new Error('Expression components must be finite');
  }
  return value;
}
export const equalValues = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

// This is the existing sRGB renderer/export boundary, not the value model.
export function colourCss(c: ColourValue): string {
  const channels = toRgb(c).map((n) => Math.max(0, Math.min(1, n)) * 255);
  return `rgba(${channels.join(',')},${Math.max(0, Math.min(1, c.a))})`;
}
let cssContext: OffscreenCanvasRenderingContext2D | null = null;
export function parseCssColour(text: string): ColourValue {
  const hex = /^#([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(text.trim());
  if (hex) {
    const digits = hex[1].length <= 4 ? [...hex[1]].map((n) => n + n).join('') : hex[1];
    const channel = (start: number) => parseInt(digits.slice(start, start + 2), 16) / 255;
    return rgb(channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) : 1);
  }
  const functional = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\((.*)\)$/i.exec(text.trim());
  if (functional) {
    const parts = functional[2].replaceAll(',', ' ').replace('/', ' ').trim().split(/\s+/);
    if ((parts.length === 3 || parts.length === 4) && parts.every((part) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:%|deg)?$/i.test(part))) {
      const name = functional[1].toLowerCase();
      const n = (index: number, percentage: number) => parseFloat(parts[index]) * (parts[index].endsWith('%') ? percentage / 100 : 1);
      const alpha = parts.length === 4 ? n(3, 1) : 1;
      if (name === 'rgb' || name === 'rgba') return rgb(n(0, 255) / 255, n(1, 255) / 255, n(2, 255) / 255, alpha);
      if (name === 'hsl' || name === 'hsla') return hsl(n(0, 360), n(1, 1), n(2, 1), alpha);
      if (name === 'hwb') {
        let white = n(1, 1), black = n(2, 1);
        if (white + black > 1) { const total = white + black; white /= total; black /= total; }
        const [r, g, b] = toRgb(hsl(n(0, 360), 1, 0.5));
        return rgb(r * (1 - white - black) + white, g * (1 - white - black) + white, b * (1 - white - black) + white, alpha);
      }
      if (name === 'lab' || name === 'lch') {
        const l = n(0, 100), aa = n(1, name === 'lab' ? 125 : 150), bb = n(2, name === 'lab' ? 125 : 360);
        const a = name === 'lab' ? aa : aa * Math.cos(bb * Math.PI / 180);
        const b = name === 'lab' ? bb : aa * Math.sin(bb * Math.PI / 180);
        const f = (v: number) => v ** 3 > 216 / 24389 ? v ** 3 : (116 * v - 16) / (24389 / 27);
        const yy = (l + 16) / 116;
        const x = 0.96422 * f(yy + a / 500), y = f(yy), z = 0.82521 * f(yy - b / 200);
        return { kind: 'colour', x: 0.9554734 * x - 0.0230985 * y + 0.0632593 * z,
          y: -0.0283697 * x + 1.0099955 * y + 0.0210414 * z, z: 0.012314 * x - 0.0205077 * y + 1.3303659 * z, a: alpha };
      }
      if (name === 'oklab') return oklab(n(0, 1), n(1, 0.4), n(2, 0.4), alpha);
      return oklch(n(0, 1), n(1, 0.4), n(2, 360), alpha);
    }
  }
  const p3 = /^color\((display-p3|srgb|srgb-linear|xyz|xyz-d65)\s+([+-.\deE]+)\s+([+-.\deE]+)\s+([+-.\deE]+)(?:\s*\/\s*([+-.\deE]+))?\s*\)$/i.exec(text.trim());
  if (p3) {
    const r = Number(p3[2]), g = Number(p3[3]), b = Number(p3[4]), alpha = p3[5] === undefined ? 1 : Number(p3[5]);
    if (p3[1] === 'srgb') return rgb(r, g, b, alpha);
    if (p3[1] === 'srgb-linear') return linearRgb(r, g, b, alpha);
    if (p3[1] === 'xyz' || p3[1] === 'xyz-d65') return { kind: 'colour', x: r, y: g, z: b, a: alpha };
    const rr = decode(r), gg = decode(g), bb = decode(b);
    return colourValue(checkValue({ kind: 'colour', x: 0.48657095 * rr + 0.26566769 * gg + 0.19821729 * bb,
      y: 0.22897456 * rr + 0.69173852 * gg + 0.07928691 * bb, z: 0.04511338 * gg + 1.04394437 * bb, a: alpha }));
  }
  // Only named colours use the browser's 8-bit lookup; advanced spaces must
  // never be silently reduced to sRGB here.
  if (!/^[a-z]+$/i.test(text.trim())) throw new Error(`Unsupported colour literal "${text}"; use hex, rgb, hsl, oklab, oklch or display-p3`);
  cssContext ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  if (!cssContext) throw new Error('Could not create a colour parser canvas');
  cssContext.fillStyle = '#000';
  cssContext.fillStyle = text;
  const first = cssContext.fillStyle;
  cssContext.fillStyle = '#fff';
  cssContext.fillStyle = text;
  if (first !== cssContext.fillStyle) throw new Error(`Unknown colour "${text}"`);
  cssContext.clearRect(0, 0, 1, 1);
  cssContext.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = cssContext.getImageData(0, 0, 1, 1).data;
  return rgb(r / 255, g / 255, b / 255, a / 255);
}
