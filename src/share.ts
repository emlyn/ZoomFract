import { deflateSync, inflateSync } from 'fflate';
import dictionary1 from './share/dictionary-1.txt?raw';
import {
  MAXIMUM_LEVELS,
  MAXIMUM_RECURSION_CHOICE,
  QUALITY_LABELS,
  SUPERSAMPLING_CHOICES,
  type QualityMode,
  type QualityOptions,
} from './render/common';
import type { InputValue, InputValues } from './scene';

// A shared definition is the definition text, compressed against a preset
// dictionary and written in URL-safe base64 after a version character.
// QR links add an A before the version and use base43: two bytes in three
// QR-alphanumeric characters, excluding space and % so fragments stay intact.
// Dictionaries are frozen once released, so old links keep working: a new
// dictionary gets a new version.
//
// Input values and app settings follow the text after a NUL, as a JSON object
// with short keys: `i` input values, `q` quality mode, `r` custom render
// settings as [renderer, supersampling, recursionDepth, levels, width, height], and `l`
// whether the label is shown. The renderer is always "webgl" now; "canvas2d"
// from older links is still read, and ignored.
// Choice inputs use their option index, so colours and ramps need no lossy
// serialisation: their values are evaluated from the shared definition.
const DICTIONARIES: Record<string, string> = { 1: dictionary1 };
const CURRENT_VERSION = '1';
const EXTRAS_SEPARATOR = '\0';
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:';

function toAlphanumeric(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 2) {
    let value = bytes[i] * (i + 1 < bytes.length ? 256 : 1) + (bytes[i + 1] ?? 0);
    const count = i + 1 < bytes.length ? 3 : 2;
    for (let digit = 0; digit < count; digit += 1) {
      text += ALPHANUMERIC[value % 43];
      value = Math.floor(value / 43);
    }
  }
  return text;
}

function fromAlphanumeric(text: string): Uint8Array {
  if (text.length % 3 === 1) throw new Error('Incomplete alphanumeric payload');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 3) {
    const digits = text.slice(i, i + 3);
    let value = 0;
    for (let j = 0; j < digits.length; j += 1) {
      const digit = ALPHANUMERIC.indexOf(digits[j]);
      if (digit < 0) throw new Error('Invalid alphanumeric character');
      value += digit * 43 ** j;
    }
    if (value > (digits.length === 3 ? 65535 : 255)) throw new Error('Invalid alphanumeric value');
    if (digits.length === 3) bytes.push(Math.floor(value / 256), value % 256);
    else bytes.push(value);
  }
  return new Uint8Array(bytes);
}

export function qrSharedUrl(url: string): { prefix: string; payload: string } {
  const hash = url.indexOf('#');
  if (hash < 0) throw new Error('QR sharing needs a fragment link');
  const code = url.slice(hash + 1);
  if (!Object.hasOwn(DICTIONARIES, code[0])) throw new Error('Unknown shared dictionary');
  return { prefix: url.slice(0, hash + 1), payload: `A${code[0]}${toAlphanumeric(fromBase64Url(code.slice(1)))}` };
}

export type SharedSettings = { quality: QualityMode; custom: QualityOptions | null; label: boolean };

export type SharedDefinition = { text: string; inputs: InputValues; settings: SharedSettings | null };

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
  .replaceAll('+', '-')
  .replaceAll('/', '_')
  .replace(/=+$/, '');

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error('Not base64url');
  }
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const roundValue = (value: number) => Number(value.toPrecision(6));

const inputJson = (value: InputValue) => typeof value === 'number'
  ? roundValue(value)
  : typeof value === 'boolean'
    ? value
    : [roundValue(value.x), roundValue(value.y)];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

function invalid(part: string): never {
  throw new Error(`Shared link ${part} is invalid`);
}

function parseInputs(values: unknown): InputValues {
  if (!isObject(values)) {
    invalid('input values');
  }
  return new Map(Object.entries(values).map(([name, value]): [string, InputValue] => {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return [name, value];
    }
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'number')) {
      return [name, { x: value[0], y: value[1] }];
    }
    return invalid(`value for "${name}"`);
  }));
}

function parseRenderOptions(value: unknown): QualityOptions {
  if (!Array.isArray(value) || value.length !== 6) {
    invalid('render settings');
  }
  const [renderer, supersampling, recursionDepth, levels, width, height] = value;
  if (
    !['webgl', 'canvas2d'].includes(renderer)
    || !SUPERSAMPLING_CHOICES.includes(supersampling)
    || !isIntegerIn(recursionDepth, 0, MAXIMUM_RECURSION_CHOICE)
    || !(levels === 'auto' || isIntegerIn(levels, 1, MAXIMUM_LEVELS))
    || !(
      (isIntegerIn(width, 1, 100000) && height === null)
      || (width === null && isIntegerIn(height, 1, 100000))
    )
  ) {
    invalid('render settings');
  }
  return {
    supersampling,
    recursionDepth,
    levels,
    resolution: { mode: 'fixed', width: width ?? undefined, height: height ?? undefined },
  };
}

function parseSettings(extras: Record<string, unknown>): SharedSettings | null {
  if (extras.q === undefined) {
    return null;
  }
  const quality = extras.q;
  if (typeof quality !== 'string' || !Object.hasOwn(QUALITY_LABELS, quality) || typeof extras.l !== 'boolean') {
    invalid('settings');
  }
  return {
    quality: quality as QualityMode,
    custom: quality === 'custom' ? parseRenderOptions(extras.r) : null,
    label: extras.l,
  };
}

function extrasJson(inputs: InputValues, settings: SharedSettings | null) {
  const custom = settings?.quality === 'custom' ? settings.custom : null;
  return {
    ...(inputs.size > 0 ? { i: Object.fromEntries([...inputs].map(([name, value]) => [name, inputJson(value)])) } : {}),
    ...(settings ? { q: settings.quality, l: settings.label } : {}),
    ...(custom ? {
      r: [
        'webgl',
        custom.supersampling,
        custom.recursionDepth,
        custom.levels,
        custom.resolution.mode === 'fixed' ? custom.resolution.width ?? null : null,
        custom.resolution.mode === 'fixed' ? custom.resolution.height ?? null : 1200,
      ],
    } : {}),
  };
}

export function encodeSharedDefinition({ text, inputs, settings }: SharedDefinition): string {
  const extras = extrasJson(inputs, settings);
  const payload = Object.keys(extras).length > 0 ? `${text}${EXTRAS_SEPARATOR}${JSON.stringify(extras)}` : text;
  const compressed = deflateSync(encoder.encode(payload), {
    level: 9,
    mem: 12,
    dictionary: encoder.encode(DICTIONARIES[CURRENT_VERSION]),
  });
  return CURRENT_VERSION + toBase64Url(compressed);
}

export function decodeSharedDefinition(code: string): SharedDefinition {
  const alphanumeric = code.startsWith('A');
  if (alphanumeric) code = code.slice(1);
  const dictionary = DICTIONARIES[code.charAt(0)];
  if (dictionary === undefined) {
    throw new Error('Shared link was made by a newer version of ZoomFract, or is damaged');
  }
  let payload: string;
  try {
    const bytes = inflateSync(alphanumeric ? fromAlphanumeric(code.slice(1)) : fromBase64Url(code.slice(1)), { dictionary: encoder.encode(dictionary) });
    payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Shared link is damaged or incomplete');
  }
  const separator = payload.indexOf(EXTRAS_SEPARATOR);
  if (separator < 0) {
    return { text: payload, inputs: new Map(), settings: null };
  }
  let extras: unknown;
  try {
    extras = JSON.parse(payload.slice(separator + 1));
  } catch {
    invalid('data');
  }
  if (!isObject(extras)) {
    invalid('data');
  }
  return {
    text: payload.slice(0, separator),
    inputs: extras.i === undefined ? new Map() : parseInputs(extras.i),
    settings: parseSettings(extras),
  };
}
