import { deflateSync, inflateSync } from 'fflate';
import dictionary1 from './share/dictionary-1.txt?raw';
import {
  MAXIMUM_LEVELS,
  MAXIMUM_RECURSION_CHOICE,
  QUALITY_LABELS,
  RENDERER_LABELS,
  SUPERSAMPLING_CHOICES,
  type QualityMode,
  type RenderOptions,
} from './render/common';
import type { InputValue, InputValues } from './scene';

// A shared definition is the definition text, compressed against a preset
// dictionary and written in URL-safe base64 after a version character.
// Dictionaries are frozen once released, so old links keep working: a new
// dictionary gets a new version.
//
// Input values and app settings follow the text after a NUL, as a JSON object
// with short keys: `i` input values, `q` quality mode, `r` custom render
// settings as [renderer, supersampling, recursionDepth, levels], and `l`
// whether the label is shown.
const DICTIONARIES: Record<string, string> = { 1: dictionary1 };
const CURRENT_VERSION = '1';
const EXTRAS_SEPARATOR = '\0';

export type SharedSettings = { quality: QualityMode; custom: RenderOptions | null; label: boolean };

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
    if (typeof value === 'number') {
      return [name, value];
    }
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'number')) {
      return [name, { x: value[0], y: value[1] }];
    }
    return invalid(`value for "${name}"`);
  }));
}

function parseRenderOptions(value: unknown): RenderOptions {
  if (!Array.isArray(value) || value.length !== 4) {
    invalid('render settings');
  }
  const [renderer, supersampling, recursionDepth, levels] = value;
  if (
    !Object.hasOwn(RENDERER_LABELS, renderer)
    || !SUPERSAMPLING_CHOICES.includes(supersampling)
    || !isIntegerIn(recursionDepth, 0, MAXIMUM_RECURSION_CHOICE)
    || !(levels === 'auto' || isIntegerIn(levels, 1, MAXIMUM_LEVELS))
  ) {
    invalid('render settings');
  }
  return { renderer, supersampling, recursionDepth, levels };
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
    ...(custom ? { r: [custom.renderer, custom.supersampling, custom.recursionDepth, custom.levels] } : {}),
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
  const dictionary = DICTIONARIES[code.charAt(0)];
  if (dictionary === undefined) {
    throw new Error('Shared link was made by a newer version of ZoomFract, or is damaged');
  }
  let payload: string;
  try {
    const bytes = inflateSync(fromBase64Url(code.slice(1)), { dictionary: encoder.encode(dictionary) });
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
