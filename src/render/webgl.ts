import { MAXIMUM_DENSITY_COLORS, type SceneDefinition, type Vec2 } from '../scene';
import {
  EDIT_MODE_ZOOM_OPACITY,
  GPU_LOST_MESSAGE,
  type FrameCallbacks,
  type RenderOutcome,
  type RenderResult,
  type RenderSettings,
} from './common';
import { unrollScene, type UnrolledItem } from './unroll';

type Rgba = [number, number, number, number];

type LevelTexture = {
  texture: WebGLTexture;
  levels: number;
};

type GlowField = {
  index: number;
  // Fraction of the source added on each side, where the glow spreads.
  margin: Vec2;
  // Source mip level sampled, its size, and the field size in texels.
  lod: number;
  levelSize: Vec2;
  size: Vec2;
  softness: number;
  // How far the shape grows, and the blur's sigma, in texels of the sampled level.
  radius: Vec2;
  sigma: Vec2;
  textures: [WebGLTexture, WebGLTexture];
};

// Higher supersampling already antialiases edges, and multisample storage at
// those sizes would use too much GPU memory.
const MSAA_MAXIMUM_SUPERSAMPLING = 2;
const MSAA_SAMPLES = 4;
const MAXIMUM_ANISOTROPY = 16;
const FLOATS_PER_VERTEX = 13;
// Vertex modes: flat colour, sampled source, rectangle glow, zoom glow.
const MODE_FLAT = 0;
const MODE_SOURCE = 1;
const MODE_RECT_GLOW = 2;
const MODE_ZOOM_GLOW = 3;
// Zoom glows sample precomputed glow fields; each distinct glow shape needs
// its own field and texture unit.
const MAXIMUM_ZOOM_GLOW_FIELDS = 8;
// Glow fields are computed at the coarsest resolution where the blur still
// spans a texel, but fine enough that the grown edge is at most this many
// texels, which bounds the cost of dilation.
const GLOW_MAXIMUM_DILATE_TEXELS = 16;
// Reaches four sigma of the blurs, which stay under two texels.
const GLOW_BLUR_TEXELS = 8;
// Zooms smaller than this in working pixels sample the feedback texture, where
// resampling error is no longer visible.
const UNROLL_MINIMUM_ZOOM_PIXELS = 12;
// Bounds geometry memory when many zooms stay large for several generations.
const UNROLL_BUDGET = 150000;
// Windows resets a GPU that spends about two seconds on one submission, and
// Chrome turns the GPU off after a few resets. Scene draws are split into
// batches that each fill at most this many working pixels, and the renderer
// waits for the GPU after each one, so slow GPUs never queue seconds of work.
const MAXIMUM_BATCH_PIXELS = 8_000_000;

// Ranges of whole triangles, as [first vertex, vertex count], that each fill
// at most the batch size. A triangle larger than that is drawn on its own.
function fillBatches(vertices: Float32Array, width: number, height: number): [number, number][] {
  const count = vertices.length / FLOATS_PER_VERTEX;
  const batches: [number, number][] = [];
  let first = 0;
  let fill = 0;
  for (let vertex = 0; vertex < count; vertex += 3) {
    const [ax, ay, bx, by, cx, cy] = [0, 1, 2].flatMap((corner) => {
      const offset = (vertex + corner) * FLOATS_PER_VERTEX;
      return [vertices[offset], vertices[offset + 1]];
    });
    const area = Math.min(Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2, width * height);
    if (fill > 0 && fill + area > MAXIMUM_BATCH_PIXELS) {
      batches.push([first, vertex - first]);
      first = vertex;
      fill = 0;
    }
    fill += area;
  }
  if (count > first) {
    batches.push([first, count - first]);
  }
  return batches;
}

const SCENE_VERTEX_SHADER = `#version 300 es
in vec2 position;
in vec2 texCoord;
in vec4 color;
in float mode;
in vec4 shape;
uniform vec2 resolution;
out vec2 uv;
out vec4 tint;
out float drawMode;
out vec4 shapeData;
void main() {
  uv = texCoord;
  tint = color;
  drawMode = mode;
  shapeData = shape;
  gl_Position = vec4(
    position.x / resolution.x * 2.0 - 1.0,
    1.0 - position.y / resolution.y * 2.0,
    0.0,
    1.0
  );
}`;

const glowFieldIndexes = Array.from({ length: MAXIMUM_ZOOM_GLOW_FIELDS }, (_, index) => index);

// Rectangle glows are worked out from the distance to the rectangle: the
// shape is grown, then blurred over the rest of the glow size. Full softness
// grows by half and blurs over the other half, like LibreOffice; lower
// softness grows further and blurs less. The logistic curve is a close fit
// to the Gaussian blur of an edge. Zoom glows sample a glow field.
const SCENE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D source;
${glowFieldIndexes.map((index) => `uniform sampler2D glow${index};`).join('\n')}
in vec2 uv;
in vec4 tint;
in float drawMode;
in vec4 shapeData;
out vec4 outColor;
float rectGlow(vec2 local, vec2 halfSize, float size, float softness) {
  float distance = length(max(abs(local) - halfSize, 0.0));
  // At least half a pixel keeps hard glows antialiased.
  float sigma = max(size * softness / 6.0, 0.5 * fwidth(distance));
  return 1.0 / (1.0 + exp(1.702 * (distance - size * (1.0 - 0.5 * softness)) / sigma));
}
float zoomGlow(int field, vec2 coords) {
  return ${glowFieldIndexes.map((index) => `field == ${index} ? textureLod(glow${index}, coords, 0.0).r : `).join('')}0.0;
}
void main() {
  vec4 sampled = texture(source, uv);
  outColor = drawMode < 1.5
    ? tint * mix(vec4(1.0), sampled, drawMode)
    : drawMode < 2.5
      ? tint * rectGlow(uv, shapeData.xy, shapeData.z, shapeData.w)
      : tint * zoomGlow(int(shapeData.x + 0.5), uv);
}`;

// Grows the source's visible parts by an ellipse, measured in texels of the
// sampled mip level. Field texels cover the source plus a margin on each side.
const GLOW_DILATE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform bool hasSource;
uniform float constantAlpha;
uniform float lod;
uniform vec2 levelSize;
uniform vec2 fieldSize;
uniform vec2 margin;
uniform vec2 radius;
out vec4 outColor;
float alphaAt(vec2 coords) {
  if (any(lessThan(coords, vec2(0.0))) || any(greaterThan(coords, vec2(1.0)))) {
    return 0.0;
  }
  return hasSource ? textureLod(source, coords, lod).a : constantAlpha;
}
void main() {
  vec2 coords = gl_FragCoord.xy / fieldSize * (1.0 + 2.0 * margin) - margin;
  vec2 reach = max(radius, vec2(1e-3));
  float edge = max(min(reach.x, reach.y), 1.0);
  ivec2 extent = ivec2(ceil(reach));
  float grown = 0.0;
  for (int y = -extent.y; y <= extent.y; y++) {
    for (int x = -extent.x; x <= extent.x; x++) {
      vec2 offset = vec2(x, y);
      // Texels straddling the ellipse edge count partly, so the grown shape
      // steps smoothly rather than a whole texel at a time.
      float inside = clamp((1.0 - length(offset / reach)) * edge + 0.5, 0.0, 1.0);
      if (inside > 0.0) {
        grown = max(grown, inside * alphaAt(coords + offset / levelSize));
      }
    }
  }
  outColor = vec4(grown);
}`;

// One direction of a Gaussian blur, with sigma in field texels.
const GLOW_BLUR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D field;
uniform vec2 fieldSize;
uniform vec2 direction;
uniform float sigma;
out vec4 outColor;
void main() {
  vec2 coords = gl_FragCoord.xy / fieldSize;
  float spread = max(sigma, 1e-3);
  float total = 0.0;
  float weights = 0.0;
  for (int i = -${GLOW_BLUR_TEXELS}; i <= ${GLOW_BLUR_TEXELS}; i++) {
    float weight = exp(-0.5 * float(i * i) / (spread * spread));
    total += weight * textureLod(field, coords + float(i) * direction / fieldSize, 0.0).r;
    weights += weight;
  }
  outColor = vec4(total / weights);
}`;

const FULLSCREEN_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

// Alpha-weighted colour with maximum alpha keeps fine recursive details from
// fading out as the mip chain shrinks. Texels are stored premultiplied.
const MIP_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D source;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(source, 0);
  ivec2 origin = ivec2(gl_FragCoord.xy) * 2;
  vec3 colorTotal = vec3(0.0);
  float alphaTotal = 0.0;
  float maxAlpha = 0.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec4 texel = texelFetch(source, min(origin + ivec2(x, y), size - 1), 0);
      colorTotal += texel.rgb;
      alphaTotal += texel.a;
      maxAlpha = max(maxAlpha, texel.a);
    }
  }
  outColor = alphaTotal > 0.0 ? vec4(colorTotal / alphaTotal * maxAlpha, maxAlpha) : vec4(0.0);
}`;

const RESOLVE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform int factor;
out vec4 outColor;
void main() {
  ivec2 origin = ivec2(gl_FragCoord.xy) * factor;
  vec4 total = vec4(0.0);
  for (int y = 0; y < factor; y++) {
    for (int x = 0; x < factor; x++) {
      total += texelFetch(source, origin + ivec2(x, y), 0);
    }
  }
  outColor = total / float(factor * factor);
}`;

// Counts are normalised by this percentile of covered pixels, measured on a
// mip level no larger than this, so a few extreme pixels do not dim the rest.
const DENSITY_PERCENTILE = 0.999;
const DENSITY_SAMPLE_SIZE = 512;
const DENSITY_SCALES = { log: 0, sqrt: 1, linear: 2 } as const;

const shapeCount = (scale: keyof typeof DENSITY_SCALES, count: number) =>
  scale === 'log' ? Math.log1p(count) : scale === 'sqrt' ? Math.sqrt(count) : count;

// Maps hit counts to colours per working pixel, then averages them to the
// output. Counts below one fade out, so partly covered edges stay smooth.
const DENSITY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform int factor;
uniform int scale;
uniform float normaliser;
uniform vec4 stops[${MAXIMUM_DENSITY_COLORS}];
uniform float positions[${MAXIMUM_DENSITY_COLORS}];
uniform int stopCount;
out vec4 outColor;
float shape(float count) {
  return scale == 0 ? log(1.0 + count) : scale == 1 ? sqrt(count) : count;
}
vec4 gradient(float t) {
  vec4 color = stops[0];
  for (int i = 1; i < stopCount; i++) {
    float start = positions[i - 1];
    float span = positions[i] - start;
    color = t <= start ? color : span <= 0.0 ? stops[i] : mix(stops[i - 1], stops[i], min((t - start) / span, 1.0));
  }
  return color;
}
void main() {
  ivec2 origin = ivec2(gl_FragCoord.xy) * factor;
  vec4 total = vec4(0.0);
  for (int y = 0; y < factor; y++) {
    for (int x = 0; x < factor; x++) {
      float count = texelFetch(source, origin + ivec2(x, y), 0).r;
      if (count > 0.0) {
        total += gradient(shape(count) / shape(normaliser)) * min(count, 1.0);
      }
    }
  }
  outColor = total / float(factor * factor);
}`;

function createColorParser(): (color: string) => Rgba {
  const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;
  const cache = new Map<string, Rgba>();
  return (color) => {
    const cached = cache.get(color);
    if (cached) {
      return cached;
    }
    // Invalid colours fall back to black, matching the Canvas 2D renderer.
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    const rgba: Rgba = [red / 255, green / 255, blue / 255, alpha / 255];
    cache.set(color, rgba);
    return rgba;
  };
}

function compileProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`WebGL shader error: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WebGL program error: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

function createLevelTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: number,
): LevelTexture {
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, levels, format, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
  if (anisotropy) {
    gl.texParameterf(
      gl.TEXTURE_2D,
      anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
      Math.min(MAXIMUM_ANISOTROPY, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)),
    );
  }
  return { texture, levels };
}

function createFieldTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

// Density counts need float textures that can be drawn to, blended, and
// filtered. Full floats avoid rounding large counts when they are supported.
function densityFormat(gl: WebGL2RenderingContext): number {
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('Density shading needs WebGL2 floating-point render targets, which are not available');
  }
  return gl.getExtension('EXT_float_blend') && gl.getExtension('OES_texture_float_linear') ? gl.R32F : gl.R16F;
}

// The hit count below which the given fraction of covered pixels fall.
function countPercentile(values: Float32Array, fraction: number): number {
  const counts = values.filter((_, index) => index % 4 === 0).filter((count) => count > 0).sort();
  return counts.length === 0 ? 1 : Math.max(counts[Math.min(counts.length - 1, Math.floor(counts.length * fraction))], 1e-6);
}

export function renderWebgl(
  scene: SceneDefinition,
  settings: RenderSettings,
  editMode: boolean,
  callbacks: FrameCallbacks,
): RenderResult {
  const output = new OffscreenCanvas(scene.view.resolution.width, scene.view.resolution.height);
  const gl = output.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    throw new Error('WebGL2 is not available in workers');
  }
  // Chrome keeps only a few contexts per page and drops the oldest, so a
  // failed render releases its context straight away.
  try {
    return drawWebgl(gl, output, scene, settings, editMode, callbacks);
  } catch (error) {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    throw error;
  }
}

function drawWebgl(
  gl: WebGL2RenderingContext,
  output: OffscreenCanvas,
  scene: SceneDefinition,
  settings: RenderSettings,
  editMode: boolean,
  callbacks: FrameCallbacks,
): RenderResult {
  const outputWidth = output.width;
  const outputHeight = output.height;
  const factor = settings.supersampling;
  const width = outputWidth * factor;
  const height = outputHeight * factor;
  // A lost context turns later calls into no-ops, so it is checked each time
  // the queue drains.
  const waitForGpu = () => {
    gl.finish();
    if (gl.isContextLost()) {
      throw new Error(GPU_LOST_MESSAGE);
    }
  };

  const maximumSize = Math.min(
    gl.getParameter(gl.MAX_TEXTURE_SIZE),
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
  );
  if (width > maximumSize || height > maximumSize) {
    throw new Error(`WebGL2 is limited to ${maximumSize}px textures; this render needs ${Math.max(width, height)}px`);
  }

  const shading = scene.shading;
  const density = shading.mode === 'density';
  const format = density ? densityFormat(gl) : gl.RGBA8;
  const parseColor = createColorParser();
  const sceneProgram = compileProgram(gl, SCENE_VERTEX_SHADER, SCENE_FRAGMENT_SHADER);
  const mipProgram = compileProgram(gl, FULLSCREEN_VERTEX_SHADER, MIP_FRAGMENT_SHADER);
  const resolveProgram = density
    ? compileProgram(gl, FULLSCREEN_VERTEX_SHADER, DENSITY_FRAGMENT_SHADER)
    : compileProgram(gl, FULLSCREEN_VERTEX_SHADER, RESOLVE_FRAGMENT_SHADER);
  const glowDilateProgram = compileProgram(gl, FULLSCREEN_VERTEX_SHADER, GLOW_DILATE_FRAGMENT_SHADER);
  const glowBlurProgram = compileProgram(gl, FULLSCREEN_VERTEX_SHADER, GLOW_BLUR_FRAGMENT_SHADER);
  gl.useProgram(sceneProgram);
  gl.uniform1i(gl.getUniformLocation(sceneProgram, 'source'), 0);
  glowFieldIndexes.forEach((index) => gl.uniform1i(gl.getUniformLocation(sceneProgram, `glow${index}`), index + 1));
  const textures = [createLevelTexture(gl, width, height, format), createLevelTexture(gl, width, height, format)];
  // Zoom glows spread from what a copy shows, not from its glows, so scenes
  // with zoom glows also build a mask of the shapes' coverage.
  const zoomGlows = !density && scene.elements.some((element) => element.kind === 'zoom' && element.glow);
  const masks = zoomGlows
    ? [createLevelTexture(gl, width, height, gl.RGBA8), createLevelTexture(gl, width, height, gl.RGBA8)]
    : [];
  const levelFramebuffer = gl.createFramebuffer()!;

  // Painted levels are drawn with multisampling and copied into textures.
  // Density levels are drawn straight into their float textures.
  const drawFramebuffer = density ? null : gl.createFramebuffer()!;
  if (drawFramebuffer) {
    const samples = factor <= MSAA_MAXIMUM_SUPERSAMPLING
      ? Math.min(MSAA_SAMPLES, gl.getParameter(gl.MAX_SAMPLES))
      : 0;
    const drawRenderbuffer = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, drawRenderbuffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, drawFramebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, drawRenderbuffer);
  }

  const vertexBuffer = gl.createBuffer()!;
  const vertexArray = gl.createVertexArray()!;
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  const attributes: [string, number][] = [['position', 2], ['texCoord', 2], ['color', 4], ['mode', 1], ['shape', 4]];
  let attributeOffset = 0;
  for (const [name, size] of attributes) {
    const location = gl.getAttribLocation(sceneProgram, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, FLOATS_PER_VERTEX * 4, attributeOffset * 4);
    attributeOffset += size;
  }
  const emptyVertexArray = gl.createVertexArray()!;

  const premultiplied = (color: Rgba, opacity: number): Rgba => {
    const alpha = color[3] * opacity;
    return [color[0] * alpha, color[1] * alpha, color[2] * alpha, alpha];
  };
  // Zoom glows are drawn from glow fields: the source image's visible parts,
  // grown and blurred to match each zoom's glow.
  const createGlowFields = () => {
    const fields: GlowField[] = [];
    const byElement = new Map<number, GlowField>();
    const sourceLevels = Math.floor(Math.log2(Math.max(width, height))) + 1;
    // Supersampled detail is not needed in a soft glow.
    const minimumLevel = Math.floor(Math.log2(factor));
    scene.elements.forEach((element, elementIndex) => {
      if (element.kind !== 'zoom' || !element.glow) {
        return;
      }
      const margin = { x: element.glow.size / element.width, y: element.glow.size / element.height };
      const { softness } = element.glow;
      const existing = fields.find((field) => field.softness === softness
        && Math.abs(field.margin.x - margin.x) < 1e-9 && Math.abs(field.margin.y - margin.y) < 1e-9);
      if (existing) {
        byElement.set(elementIndex, existing);
        return;
      }
      if (fields.length === MAXIMUM_ZOOM_GLOW_FIELDS) {
        throw new Error(`At most ${MAXIMUM_ZOOM_GLOW_FIELDS} zoom glow sizes and softnesses are supported`);
      }
      // How far the edge grows, and the blur's sigma, in working pixels of the source.
      const glowPixels = { x: margin.x * width, y: margin.y * height };
      const reach = { x: glowPixels.x * (1 - softness / 2), y: glowPixels.y * (1 - softness / 2) };
      const sigma = { x: glowPixels.x * softness / 6, y: glowPixels.y * softness / 6 };
      const lod = Math.min(sourceLevels - 1, Math.max(
        minimumLevel,
        Math.floor(Math.log2(Math.min(sigma.x, sigma.y))),
        Math.ceil(Math.log2(Math.max(reach.x, reach.y) / GLOW_MAXIMUM_DILATE_TEXELS)),
      ));
      const levelSize = { x: Math.max(1, width >> lod), y: Math.max(1, height >> lod) };
      const size = {
        x: Math.min(maximumSize, Math.ceil(levelSize.x * (1 + 2 * margin.x))),
        y: Math.min(maximumSize, Math.ceil(levelSize.y * (1 + 2 * margin.y))),
      };
      const field: GlowField = {
        index: fields.length,
        margin,
        softness,
        lod,
        levelSize,
        size,
        radius: { x: reach.x / 2 ** lod, y: reach.y / 2 ** lod },
        // Half a texel of blur keeps hard glows from showing the texel grid.
        sigma: { x: Math.max(0.5, sigma.x / 2 ** lod), y: Math.max(0.5, sigma.y / 2 ** lod) },
        textures: [createFieldTexture(gl, size.x, size.y), createFieldTexture(gl, size.x, size.y)],
      };
      fields.push(field);
      byElement.set(elementIndex, field);
    });

    const seedAlpha = parseColor(scene.seed.color)[3] * scene.seed.opacity;
    const pass = (program: WebGLProgram, target: WebGLTexture, input: WebGLTexture | null, field: GlowField) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      gl.useProgram(program);
      gl.uniform2f(gl.getUniformLocation(program, 'fieldSize'), field.size.x, field.size.y);
      gl.bindTexture(gl.TEXTURE_2D, input);
    };
    const compute = (source: LevelTexture | null) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, levelFramebuffer);
      gl.bindVertexArray(emptyVertexArray);
      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      for (const field of fields) {
        const [grown, blurred] = field.textures;
        gl.viewport(0, 0, field.size.x, field.size.y);
        pass(glowDilateProgram, grown, source?.texture ?? null, field);
        const uniform = (name: string) => gl.getUniformLocation(glowDilateProgram, name);
        gl.uniform1i(uniform('hasSource'), source ? 1 : 0);
        gl.uniform1f(uniform('constantAlpha'), seedAlpha);
        gl.uniform1f(uniform('lod'), field.lod);
        gl.uniform2f(uniform('levelSize'), field.levelSize.x, field.levelSize.y);
        gl.uniform2f(uniform('margin'), field.margin.x, field.margin.y);
        gl.uniform2f(uniform('radius'), field.radius.x, field.radius.y);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const blur = (target: WebGLTexture, input: WebGLTexture, direction: Vec2, sigma: number) => {
          pass(glowBlurProgram, target, input, field);
          gl.uniform2f(gl.getUniformLocation(glowBlurProgram, 'direction'), direction.x, direction.y);
          gl.uniform1f(gl.getUniformLocation(glowBlurProgram, 'sigma'), sigma);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        };
        blur(blurred, grown, { x: 1, y: 0 }, field.sigma.x);
        blur(grown, blurred, { x: 0, y: 1 }, field.sigma.y);
      }
    };
    const bind = () => {
      fields.forEach((field) => {
        gl.activeTexture(gl.TEXTURE1 + field.index);
        gl.bindTexture(gl.TEXTURE_2D, field.textures[0]);
      });
      gl.activeTexture(gl.TEXTURE0);
    };
    return { forElement: (index: number) => byElement.get(index), compute, bind, used: fields.length > 0 };
  };

  const seedColor = parseColor(scene.seed.color);
  const rectColors = scene.elements.map((element) => element.kind === 'rect' ? parseColor(element.color) : null);
  const glowColors = scene.elements.map((element) => element.glow
    ? premultiplied(parseColor(element.glow.color), element.glow.opacity)
    : null);
  const glowFields = createGlowFields();

  const pushPolygon = (
    vertices: number[],
    polygon: Vec2[],
    texCoords: Vec2[] | null,
    color: Rgba,
    mode = texCoords ? MODE_SOURCE : MODE_FLAT,
    shape: [number, number, number, number] = [0, 0, 0, 0],
  ) => {
    const pushVertex = (index: number) => vertices.push(
      polygon[index].x,
      polygon[index].y,
      texCoords?.[index].x ?? 0,
      texCoords?.[index].y ?? 0,
      ...color,
      mode,
      ...shape,
    );
    for (let index = 1; index < polygon.length - 1; index += 1) {
      pushVertex(0);
      pushVertex(index);
      pushVertex(index + 1);
    }
  };

  // Density vertices carry a hit weight in every channel: rectangles add their
  // weight, leaves add the counts they sample, and terminal leaves add nothing.
  const densityVertices = (items: UnrolledItem[], sampleSource: boolean) => {
    const vertices: number[] = [];
    for (const item of items) {
      if (item.kind === 'rect') {
        const element = scene.elements[item.elementIndex];
        const weight = element.kind === 'rect' ? element.weight * item.alpha : 0;
        pushPolygon(vertices, item.polygon, null, [weight, weight, weight, weight]);
      } else if (item.kind === 'leaf' && sampleSource) {
        pushPolygon(vertices, item.polygon, item.texCoords, [item.alpha, item.alpha, item.alpha, item.alpha]);
      }
    }
    return new Float32Array(vertices);
  };

  // Mask vertices draw the coverage of shapes and copies, leaving out glows.
  const maskVertices = (items: UnrolledItem[], sampleSource: boolean) => {
    const vertices: number[] = [];
    const seedAlpha = seedColor[3] * scene.seed.opacity;
    for (const item of items) {
      if (item.kind === 'rect') {
        const coverage = rectColors[item.elementIndex]![3] * item.alpha;
        pushPolygon(vertices, item.polygon, null, [coverage, coverage, coverage, coverage]);
      } else if (item.kind === 'leaf') {
        pushPolygon(vertices, item.polygon, sampleSource ? item.texCoords : null, sampleSource
          ? [item.alpha, item.alpha, item.alpha, item.alpha]
          : [seedAlpha * item.alpha, seedAlpha * item.alpha, seedAlpha * item.alpha, seedAlpha * item.alpha]);
      }
    }
    return new Float32Array(vertices);
  };

  const sceneVertices = (items: UnrolledItem[], sampleSource: boolean) => {
    if (density) {
      return densityVertices(items, sampleSource);
    }
    const vertices: number[] = [];
    for (const item of items) {
      if (item.kind === 'rect') {
        pushPolygon(vertices, item.polygon, null, premultiplied(rectColors[item.elementIndex]!, item.alpha));
      } else if (item.kind === 'rectGlow') {
        const element = scene.elements[item.elementIndex];
        const color = glowColors[item.elementIndex]!.map((channel) => channel * item.alpha) as Rgba;
        pushPolygon(vertices, item.polygon, item.local, color, MODE_RECT_GLOW, [
          element.width / 2,
          element.height / 2,
          element.glow!.size,
          element.glow!.softness,
        ]);
      } else if (item.kind === 'zoomGlow') {
        const field = glowFields.forElement(item.elementIndex)!;
        const color = glowColors[item.elementIndex]!.map((channel) => channel * item.alpha) as Rgba;
        const coords = item.texCoords.map((point) => ({
          x: (point.x + field.margin.x) / (1 + 2 * field.margin.x),
          y: (point.y + field.margin.y) / (1 + 2 * field.margin.y),
        }));
        pushPolygon(vertices, item.polygon, coords, color, MODE_ZOOM_GLOW, [field.index, 0, 0, 0]);
      } else if (sampleSource) {
        pushPolygon(vertices, item.polygon, item.texCoords, premultiplied([1, 1, 1, 1], item.alpha));
      } else {
        pushPolygon(vertices, item.polygon, null, premultiplied(seedColor, scene.seed.opacity * item.alpha));
      }
    }
    return new Float32Array(vertices);
  };

  // Continuations redraw the same items, so their vertices are built once.
  const vertexCache = new Map<UnrolledItem[], Map<string, Float32Array>>();
  const batchCache = new WeakMap<Float32Array, [number, number][]>();
  const cachedVertices = (items: UnrolledItem[], sampleSource: boolean, mask: boolean) => {
    const byMode = vertexCache.get(items) ?? new Map<string, Float32Array>();
    vertexCache.set(items, byMode);
    const key = `${sampleSource} ${mask}`;
    const vertices = byMode.get(key) ?? (mask ? maskVertices : sceneVertices)(items, sampleSource);
    byMode.set(key, vertices);
    return vertices;
  };

  const levelItems = unrollScene(scene, factor, {
    maximumDepth: 0,
    uniform: false,
    budget: 0,
    minimumZoomPixels: Infinity,
    topLevelZoomOpacity: 1,
  }).items;
  const finalUnroll = unrollScene(scene, factor, {
    maximumDepth: settings.recursionDepth,
    uniform: !settings.autoLevels,
    budget: UNROLL_BUDGET,
    minimumZoomPixels: settings.autoLevels ? UNROLL_MINIMUM_ZOOM_PIXELS : 0,
    // Fading copies would change density counts; edit mode outlines are enough.
    topLevelZoomOpacity: editMode && !density ? EDIT_MODE_ZOOM_OPACITY : 1,
  });
  // A leaf at generation g sampling the texture after F feedback levels ends
  // with seed zooms at generation g + F, so the shallowest leaf sets F.
  const feedbackLevelsFor = (levels: number) => Math.max(0, levels - finalUnroll.shallowestLeaf);

  const generateMips = ({ texture, levels }: LevelTexture) => {
    if (density) {
      // Plain averages keep the mean count over each texel.
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.generateMipmap(gl.TEXTURE_2D);
      return;
    }
    gl.useProgram(mipProgram);
    gl.bindVertexArray(emptyVertexArray);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, levelFramebuffer);
    for (let level = 1; level < levels; level += 1) {
      // Restricting the sampled range to the previous level avoids a feedback loop.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, level - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level - 1);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, level);
      gl.viewport(0, 0, Math.max(1, width >> level), Math.max(1, height >> level));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
  };

  const drawLevel = (
    target: LevelTexture,
    source: LevelTexture | null,
    items: UnrolledItem[],
    mask = false,
  ) => {
    if (drawFramebuffer) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, drawFramebuffer);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, levelFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(sceneProgram);
    gl.uniform2f(gl.getUniformLocation(sceneProgram, 'resolution'), width, height);
    glowFields.bind();
    gl.bindTexture(gl.TEXTURE_2D, source?.texture ?? null);
    gl.enable(gl.BLEND);
    // Painting composites over what is below; density adds up hits.
    gl.blendFunc(gl.ONE, density ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    const vertices = cachedVertices(items, source !== null, mask);
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    const batches = batchCache.get(vertices) ?? fillBatches(vertices, width, height);
    batchCache.set(vertices, batches);
    for (const [first, count] of batches) {
      gl.drawArrays(gl.TRIANGLES, first, count);
      waitForGpu();
    }
    if (!drawFramebuffer) {
      return;
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, drawFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, levelFramebuffer);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  };

  // The newest feedback texture survives each render, so more levels can be
  // added later by continuing the feedback loop from it.
  let lastFeedback: LevelTexture | null = null;
  let completedFeedbackLevels = 0;
  const unusedTexture = () => lastFeedback === textures[0] ? textures[1] : textures[0];
  const levelsShown = () => completedFeedbackLevels + finalUnroll.shallowestLeaf;

  const addFeedbackLevel = () => {
    const target = unusedTexture();
    drawLevel(target, lastFeedback, levelItems);
    generateMips(target);
    waitForGpu();
    lastFeedback = target;
    completedFeedbackLevels += 1;
  };

  // Every copy's glow spreads from the mask of the fully recursed image. A
  // shallower mask would show its seeds as blocks that the glow outlines.
  let lastMask: LevelTexture | null = null;
  let maskLevels = 0;
  let fieldsReady = false;
  const prepareGlowFields = (levels: number) => {
    if (!glowFields.used || (fieldsReady && maskLevels >= levels)) {
      return;
    }
    for (; maskLevels < levels; maskLevels += 1) {
      const target = lastMask === masks[0] ? masks[1] : masks[0];
      drawLevel(target, lastMask, levelItems, true);
      generateMips(target);
      waitForGpu();
      lastMask = target;
    }
    glowFields.compute(lastMask);
    fieldsReady = true;
  };

  const densityColors = density
    ? shading.colors.map((stop) => premultiplied(parseColor(stop.color), 1))
    : [];
  // Positions along the gradient, where 1 is the normalising count.
  const densityPositions = (scale: keyof typeof DENSITY_SCALES, normaliser: number) => shading.mode === 'density'
    ? shading.colors
      .map(({ at }, index) => ({
        index,
        position: at.kind === 'fraction' ? at.value : shapeCount(scale, at.value) / shapeCount(scale, normaliser),
      }))
      .sort((a, b) => a.position - b.position)
    : [];
  // Reads a small mip level of the counts to find the normalising count.
  const densityNormaliser = (texture: LevelTexture) => {
    generateMips(texture);
    const level = Math.max(0, Math.ceil(Math.log2(Math.max(width, height) / DENSITY_SAMPLE_SIZE)));
    const levelWidth = Math.max(1, width >> level);
    const levelHeight = Math.max(1, height >> level);
    gl.bindFramebuffer(gl.FRAMEBUFFER, levelFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.texture, level);
    const values = new Float32Array(levelWidth * levelHeight * 4);
    gl.readPixels(0, 0, levelWidth, levelHeight, gl.RGBA, gl.FLOAT, values);
    return countPercentile(values, DENSITY_PERCENTILE);
  };
  const useDensityProgram = (texture: LevelTexture) => {
    if (shading.mode !== 'density') {
      return;
    }
    const normaliser = densityNormaliser(texture);
    gl.useProgram(resolveProgram);
    gl.uniform1i(gl.getUniformLocation(resolveProgram, 'scale'), DENSITY_SCALES[shading.scale]);
    gl.uniform1f(gl.getUniformLocation(resolveProgram, 'normaliser'), normaliser);
    const stops = densityPositions(shading.scale, normaliser);
    gl.uniform4fv(gl.getUniformLocation(resolveProgram, 'stops'), stops.flatMap(({ index }) => densityColors[index]));
    gl.uniform1fv(gl.getUniformLocation(resolveProgram, 'positions'), stops.map(({ position }) => position));
    gl.uniform1i(gl.getUniformLocation(resolveProgram, 'stopCount'), shading.colors.length);
  };

  // Draws the exact geometry over the latest feedback texture into the output.
  const drawOutput = () => {
    const finalTexture = unusedTexture();
    drawLevel(finalTexture, lastFeedback, finalUnroll.items);
    useDensityProgram(finalTexture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outputWidth, outputHeight);
    gl.disable(gl.BLEND);
    gl.useProgram(resolveProgram);
    gl.uniform1i(gl.getUniformLocation(resolveProgram, 'factor'), factor);
    gl.bindVertexArray(emptyVertexArray);
    gl.bindTexture(gl.TEXTURE_2D, finalTexture.texture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    waitForGpu();
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      throw new Error(`WebGL error ${error}`);
    }
  };

  const details = () => {
    const exactGenerations = finalUnroll.shallowestLeaf - 1;
    const budgetLimited = !settings.autoLevels && exactGenerations < settings.recursionDepth;
    return [
      `${finalUnroll.expandedZooms.toLocaleString('en-GB')} exact zooms`,
      ...(budgetLimited ? [`recursion capped at ${exactGenerations}`] : []),
    ];
  };

  const renderLevels = (levels: number, frameCallbacks: FrameCallbacks): RenderOutcome => {
    prepareGlowFields(levels);
    const feedbackLevels = feedbackLevelsFor(levels);
    const steps = feedbackLevels - completedFeedbackLevels + 1;
    let step = 0;
    while (completedFeedbackLevels < feedbackLevels) {
      if (completedFeedbackLevels === feedbackLevels - 1) {
        drawOutput();
        frameCallbacks.reference(output, levelsShown());
      }
      addFeedbackLevel();
      step += 1;
      frameCallbacks.progress(step / steps);
    }
    drawOutput();
    frameCallbacks.progress(1);
    frameCallbacks.frame(output, levelsShown());
    return { details: details(), levels: levelsShown() };
  };
  return {
    outcome: renderLevels(settings.levels, callbacks),
    // Exact geometry is kept from the first render; only feedback levels are added.
    continueTo: (next, frameCallbacks) => renderLevels(next.levels, frameCallbacks),
    dispose: () => gl.getExtension('WEBGL_lose_context')?.loseContext(),
  };
}
