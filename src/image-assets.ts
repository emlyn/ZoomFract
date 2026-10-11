import YAML from 'yaml';
import type { ImageMetadata } from './scene';

export type DecodedImage = ImageMetadata & { bitmap: ImageBitmap; blob: Blob };
export type DecodedImages = ReadonlyMap<string, DecodedImage>;

const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_TOTAL_IMAGE_PIXELS = 32_000_000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const pendingImages = new Map<string, { users: number; result: Promise<DecodedImage> }>();

async function decodeImage(url: string): Promise<DecodedImage> {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Image response has no data');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error('Image exceeds the 16 MiB file limit');
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  const blob = new Blob(chunks, { type: response.headers.get('Content-Type') ?? '' });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
  } catch {
    throw new Error('Could not decode the image. Use PNG, JPEG, or a browser-supported image format.');
  }
  if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
    bitmap.close();
    throw new Error(`Image exceeds the ${MAX_IMAGE_PIXELS.toLocaleString()}-pixel limit`);
  }
  return { width: bitmap.width, height: bitmap.height, bitmap, blob };
}

async function acquireImage(url: string): Promise<DecodedImage> {
  let pending = pendingImages.get(url);
  if (!pending) {
    pending = { users: 0, result: decodeImage(url) };
    pendingImages.set(url, pending);
  }
  pending.users += 1;
  let original: DecodedImage | undefined;
  try {
    original = await pending.result;
    return { ...original, bitmap: await createImageBitmap(original.bitmap, { premultiplyAlpha: 'premultiply' }) };
  } finally {
    pending.users -= 1;
    if (pending.users === 0) {
      pendingImages.delete(url);
      original?.bitmap.close();
    }
  }
}

export function imageSources(text: string): { source: string; path: string }[] {
  const value: unknown = YAML.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const root = value as Record<string, unknown>;
  const result = new Map<string, string>();
  for (const [layerName, layer] of [['scene', root.scene], ['background', root.background]] as const) {
    if (!Array.isArray(layer)) continue;
    for (const [index, item] of layer.entries()) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        if (record.type === 'image' && typeof record.source === 'string' && record.source.trim()) {
          if (!result.has(record.source.trim())) result.set(record.source.trim(), `${layerName}[${index}].source`);
        }
      }
    }
  }
  return [...result].map(([source, path]) => ({ source, path }));
}

export function absoluteImageSources(text: string, baseUrl: string): string {
  const document = YAML.parseDocument(text, { prettyErrors: false });
  const root = document.contents;
  if (!YAML.isMap(root)) return text;
  const base = new URL(baseUrl);
  base.username = '';
  base.password = '';
  for (const layerName of ['scene', 'background']) {
    const layer = root.get(layerName, true);
    if (!YAML.isSeq(layer)) continue;
    for (const item of layer.items) {
      if (!YAML.isMap(item)) continue;
      const type = item.get('type', true);
      if (!YAML.isScalar(type) || type.value !== 'image') continue;
      const source = item.get('source', true);
      if (!YAML.isScalar(source) || typeof source.value !== 'string'
        || /^[a-z][a-z\d+.-]*:/i.test(source.value)) continue;
      source.value = new URL(source.value, base).href;
    }
  }
  return document.toString();
}

export async function loadImages(sources: string[], baseUrl?: string): Promise<Map<string, DecodedImage>> {
  const results = await Promise.allSettled([...new Set(sources)].map(async (source) => {
    try {
      const url = new URL(source, baseUrl ?? window.location.href);
      if (!['http:', 'https:', 'data:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Use an HTTP(S) URL without credentials or an embedded image data URL');
      }
      return [source, await acquireImage(url.href)] as const;
    } catch (error) {
      const label = source.startsWith('data:') ? 'embedded image' : source;
      throw new Error(`Image "${label}" could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  const loaded = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    loaded.forEach(([, image]) => image.bitmap.close());
    throw failure.reason;
  }
  const totalPixels = loaded.reduce((total, [, image]) => total + image.width * image.height, 0);
  if (totalPixels > MAX_TOTAL_IMAGE_PIXELS) {
    loaded.forEach(([, image]) => image.bitmap.close());
    throw new Error(`Images exceed the ${MAX_TOTAL_IMAGE_PIXELS.toLocaleString()}-pixel total limit`);
  }
  return new Map(loaded);
}
