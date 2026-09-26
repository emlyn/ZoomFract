import { MAXIMUM_DENSITY_COLORS, type SceneDefinition, type Vec2 } from '../scene';
import {
  EDIT_MODE_ZOOM_OPACITY,
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

// Higher supersampling already antialiases edges, and multisample storage at
// those sizes would use too much GPU memory.
const MSAA_MAXIMUM_SUPERSAMPLING = 2;
const MSAA_SAMPLES = 4;
const MAXIMUM_ANISOTROPY = 16;
const FLOATS_PER_VERTEX = 9;
// Zooms smaller than this in working pixels sample the feedback texture, where
// resampling error is no longer visible.
const UNROLL_MINIMUM_ZOOM_PIXELS = 12;
// Bounds geometry memory when many zooms stay large for several generations.
const UNROLL_BUDGET = 150000;

const SCENE_VERTEX_SHADER = `#version 300 es
in vec2 position;
in vec2 texCoord;
in vec4 color;
in float textureMix;
uniform vec2 resolution;
out vec2 uv;
out vec4 tint;
out float mixAmount;
void main() {
  uv = texCoord;
  tint = color;
  mixAmount = textureMix;
  gl_Position = vec4(
    position.x / resolution.x * 2.0 - 1.0,
    1.0 - position.y / resolution.y * 2.0,
    0.0,
    1.0
  );
}`;

const SCENE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D source;
in vec2 uv;
in vec4 tint;
in float mixAmount;
out vec4 outColor;
void main() {
  outColor = tint * mix(vec4(1.0), texture(source, uv), mixAmount);
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

export function isWebglAvailable(): boolean {
  return new OffscreenCanvas(1, 1).getContext('webgl2') !== null;
}

export function renderWebgl(
  scene: SceneDefinition,
  settings: RenderSettings,
  editMode: boolean,
  callbacks: FrameCallbacks,
): RenderResult {
  const outputWidth = scene.view.resolution.width;
  const outputHeight = scene.view.resolution.height;
  const factor = settings.supersampling;
  const width = outputWidth * factor;
  const height = outputHeight * factor;
  const output = new OffscreenCanvas(outputWidth, outputHeight);
  const gl = output.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    throw new Error('WebGL2 is not available');
  }

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
  const textures = [createLevelTexture(gl, width, height, format), createLevelTexture(gl, width, height, format)];
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
  const attributes: [string, number][] = [['position', 2], ['texCoord', 2], ['color', 4], ['textureMix', 1]];
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
  const seedColor = parseColor(scene.seed.color);
  const rectColors = scene.elements.map((element) => element.kind === 'rect' ? parseColor(element.color) : null);

  const pushPolygon = (vertices: number[], polygon: Vec2[], texCoords: Vec2[] | null, color: Rgba) => {
    const pushVertex = (index: number) => vertices.push(
      polygon[index].x,
      polygon[index].y,
      texCoords?.[index].x ?? 0,
      texCoords?.[index].y ?? 0,
      ...color,
      texCoords ? 1 : 0,
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
      } else if (sampleSource) {
        pushPolygon(vertices, item.polygon, item.texCoords, [item.alpha, item.alpha, item.alpha, item.alpha]);
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
      } else if (sampleSource) {
        pushPolygon(vertices, item.polygon, item.texCoords, premultiplied([1, 1, 1, 1], item.alpha));
      } else {
        pushPolygon(vertices, item.polygon, null, premultiplied(seedColor, scene.seed.opacity * item.alpha));
      }
    }
    return new Float32Array(vertices);
  };

  // Continuations redraw the same items, so their vertices are built once.
  const vertexCache = new Map<UnrolledItem[], Map<boolean, Float32Array>>();
  const cachedVertices = (items: UnrolledItem[], sampleSource: boolean) => {
    const byMode = vertexCache.get(items) ?? new Map<boolean, Float32Array>();
    vertexCache.set(items, byMode);
    const vertices = byMode.get(sampleSource) ?? sceneVertices(items, sampleSource);
    byMode.set(sampleSource, vertices);
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

  const drawLevel = (target: LevelTexture, source: LevelTexture | null, items: UnrolledItem[]) => {
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
    gl.bindTexture(gl.TEXTURE_2D, source?.texture ?? null);
    gl.enable(gl.BLEND);
    // Painting composites over what is below; density adds up hits.
    gl.blendFunc(gl.ONE, density ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    const vertices = cachedVertices(items, source !== null);
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / FLOATS_PER_VERTEX);
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
    lastFeedback = target;
    completedFeedbackLevels += 1;
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
    gl.finish();
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
