// Small WebGL2 helpers shared by the lights layer and its bloom pass.

export function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Could not create a shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(log ?? "Shader compile failed");
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource),
    fragment = compile(gl.FRAGMENT_SHADER, fragmentSource),
    program = gl.createProgram();
  if (!program) throw new Error("Could not create a program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(log ?? "Program link failed");
  }
  return program;
}

export function uniforms<const N extends string>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly N[],
): Record<N, WebGLUniformLocation | null> {
  return Object.fromEntries(
    names.map((name) => [name, gl.getUniformLocation(program, name)]),
  ) as Record<N, WebGLUniformLocation | null>;
}

/** A vertex shader for one triangle that covers the viewport; no buffers needed. */
export const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
