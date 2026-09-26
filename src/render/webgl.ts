import type { SceneDefinition, Vec2 } from '../scene';
import {
  EDIT_MODE_ZOOM_OPACITY,
  type FrameCallbacks,
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

function createLevelTexture(gl: WebGL2RenderingContext, width: number, height: number): LevelTexture {
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height);
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

  const parseColor = createColorParser();
  const sceneProgram = compileProgram(gl, SCENE_VERTEX_SHADER, SCENE_FRAGMENT_SHADER);
  const mipProgram = compileProgram(gl, FULLSCREEN_VERTEX_SHADER, MIP_FRAGMENT_SHADER);
  const resolveProgram = compileProgram(gl, FULLSCREEN_VERTEX_SHADER, RESOLVE_FRAGMENT_SHADER);
  const textures = [createLevelTexture(gl, width, height), createLevelTexture(gl, width, height)];
  const levelFramebuffer = gl.createFramebuffer()!;

  const samples = factor <= MSAA_MAXIMUM_SUPERSAMPLING
    ? Math.min(MSAA_SAMPLES, gl.getParameter(gl.MAX_SAMPLES))
    : 0;
  const drawRenderbuffer = gl.createRenderbuffer()!;
  gl.bindRenderbuffer(gl.RENDERBUFFER, drawRenderbuffer);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
  const drawFramebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, drawFramebuffer);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, drawRenderbuffer);

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

  const sceneVertices = (items: UnrolledItem[], sampleSource: boolean) => {
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
    topLevelZoomOpacity: editMode ? EDIT_MODE_ZOOM_OPACITY : 1,
  });
  // A leaf at generation g sampling the texture after F feedback levels ends
  // with seed zooms at generation g + F, so the shallowest leaf sets F.
  const feedbackLevelsFor = (levels: number) => Math.max(0, levels - finalUnroll.shallowestLeaf);

  const generateMips = ({ texture, levels }: LevelTexture) => {
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, drawFramebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(sceneProgram);
    gl.uniform2f(gl.getUniformLocation(sceneProgram, 'resolution'), width, height);
    gl.bindTexture(gl.TEXTURE_2D, source?.texture ?? null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const vertices = sceneVertices(items, source !== null);
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / FLOATS_PER_VERTEX);

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

  const renderLevels = (levels: number, frameCallbacks: FrameCallbacks): string[] => {
    const feedbackLevels = feedbackLevelsFor(levels);
    const steps = feedbackLevels - completedFeedbackLevels + 1;
    let step = 0;
    while (completedFeedbackLevels < feedbackLevels) {
      const target = unusedTexture();
      drawLevel(target, lastFeedback, levelItems);
      generateMips(target);
      lastFeedback = target;
      completedFeedbackLevels += 1;
      step += 1;
      frameCallbacks.progress(step / steps);
    }
    const finalTexture = unusedTexture();
    drawLevel(finalTexture, lastFeedback, finalUnroll.items);

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
    frameCallbacks.progress(1);
    frameCallbacks.frame(output);
    const exactGenerations = finalUnroll.shallowestLeaf - 1;
    const budgetLimited = !settings.autoLevels && exactGenerations < settings.recursionDepth;
    return [
      `${finalUnroll.expandedZooms.toLocaleString('en-GB')} exact zooms`,
      ...(budgetLimited ? [`recursion capped at ${exactGenerations}`] : []),
    ];
  };

  return {
    details: renderLevels(settings.levels, callbacks),
    // Exact geometry is kept from the first render; only feedback levels are added.
    continueTo: (next, frameCallbacks) => renderLevels(next.levels, frameCallbacks),
    dispose: () => gl.getExtension('WEBGL_lose_context')?.loseContext(),
  };
}
