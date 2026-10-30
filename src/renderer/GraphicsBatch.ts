/**
 * Vector graphics batch: solid triangles with a per-vertex colour.
 *
 * Geometry generation lives in `tessellate.ts` / `GridGeometry.ts` (pure, cacheable); this class
 * only appends the resulting vertices and submits one `drawArrays`. Vertices carry their own
 * colour so differently coloured shapes can share a draw call.
 */

import { Color } from "../Color";
import { Mat3 } from "../Mat3";

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_position;
layout(location = 1) in vec4 a_color;

uniform mat3 u_projection;

out vec4 v_color;

void main() {
    vec3 clip = u_projection * vec3(a_position, 1.0);
    gl_Position = vec4(clip.xy, 0.0, 1.0);
    v_color = a_color;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec4 v_color;
out vec4 fragColor;

void main() {
    fragColor = v_color;
}
`;

export const FLOATS_PER_VERTEX = 6;

export { VERTEX_SHADER as GRAPHICS_VERTEX_SHADER, FRAGMENT_SHADER as GRAPHICS_FRAGMENT_SHADER };

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
    const s = gl.createShader(type);
    if (!s) throw new Error("[graphics] createShader failed");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(s) ?? "";
        gl.deleteShader(s);
        throw new Error(`[graphics] shader compile failed: ${info}`);
    }
    return s;
}

/** Dynamic triangle batch: one upload and one draw per flush. */

export class GraphicsBatch {
    private readonly gl: WebGL2RenderingContext;
    private readonly program: WebGLProgram;
    private readonly vao: WebGLVertexArrayObject;
    private readonly vbo: WebGLBuffer;
    private readonly uProjection: WebGLUniformLocation;

    private data: Float32Array;
    /** number of vertices written */
    private vertexCount = 0;
    private readonly projectionArray = new Float32Array(9);
    public drawCalls = 0;

    /**
     * Vertices already uploaded this frame. `flush()` uploads only `[uploaded, vertexCount)` so
     * successive flushes write disjoint ranges and every vertex is uploaded exactly once.
     */
    private uploaded = 0;
    /** GPU data-store size in bytes; `bufferData` runs only when growing */
    private glCapacityBytes = 0;

    constructor(gl: WebGL2RenderingContext, initialVertices = 4096) {
        this.gl = gl;
        this.data = new Float32Array(initialVertices * FLOATS_PER_VERTEX);

        const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
        const program = gl.createProgram();
        if (!program) throw new Error("[graphics] createProgram failed");
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program) ?? "";
            throw new Error(`[graphics] shader link failed: ${info}`);
        }
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        this.program = program;

        const up = gl.getUniformLocation(program, "u_projection");
        if (!up) throw new Error("[graphics] u_projection not found");
        this.uProjection = up;

        const vao = gl.createVertexArray();
        const vbo = gl.createBuffer();
        if (!vao || !vbo) throw new Error("[graphics] failed to create VAO/VBO");
        this.vao = vao;
        this.vbo = vbo;

        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        const stride = FLOATS_PER_VERTEX * 4;
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    public begin(): void {
        this.vertexCount = 0;
        this.uploaded = 0;
        this.drawCalls = 0;
    }

    private ensureVertices(n: number): void {
        const need = (this.vertexCount + n) * FLOATS_PER_VERTEX;
        if (need <= this.data.length) return;
        let cap = this.data.length;
        while (cap < need) cap *= 2;
        const next = new Float32Array(cap);
        next.set(this.data.subarray(0, this.vertexCount * FLOATS_PER_VERTEX));
        this.data = next;
    }

    /**
     * Append triangle vertices (`[x0,y0,x1,y1,...]`, one triangle per 3 vertices).
     *
     * @param vertices expanded triangle vertices (from `tessellate.ts`)
     * @param color uniform colour; white when omitted
     */
    public addTriangles(
        vertices: ReadonlyArray<number> | Float32Array,
        color?: Color,
        offsetX = 0,
        offsetY = 0,
    ): void {
        const n = vertices.length / 2;
        if (n === 0) return;
        this.ensureVertices(n);
        const d = this.data;
        let o = this.vertexCount * FLOATS_PER_VERTEX;
        const r = color ? color.r / 255 : 1;
        const g = color ? color.g / 255 : 1;
        const b = color ? color.b / 255 : 1;
        const a = color ? color.a / 255 : 1;
        if (offsetX === 0 && offsetY === 0) {
            for (let i = 0; i < n; i++) {
                d[o++] = vertices[i * 2] as number;
                d[o++] = vertices[i * 2 + 1] as number;
                d[o++] = r;
                d[o++] = g;
                d[o++] = b;
                d[o++] = a;
            }
        } else {
            // Translation avoids re-triangulating the same template for every tile.
            for (let i = 0; i < n; i++) {
                d[o++] = (vertices[i * 2] as number) + offsetX;
                d[o++] = (vertices[i * 2 + 1] as number) + offsetY;
                d[o++] = r;
                d[o++] = g;
                d[o++] = b;
                d[o++] = a;
            }
        }
        this.vertexCount += n;
    }

    /** Append one line segment, expanded into a quad with the given width. */
    public addLine(x0: number, y0: number, x1: number, y1: number, width: number, color?: Color): void {
        // Expanded here directly to avoid a dependency cycle with tessellate.
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9 || width <= 0) return;
        const half = width / 2;
        const nx = (-dy / len) * half;
        const ny = (dx / len) * half;
        const v = [
            x0 + nx, y0 + ny, x1 + nx, y1 + ny, x0 - nx, y0 - ny,
            x0 - nx, y0 - ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny,
        ];
        this.addTriangles(v, color);
    }

    /**
     * Expand line segments into stroke triangles straight into the buffer, with no intermediate
     * array (grid lines can number in the thousands per frame).
     */
    public addSegments(
        segments: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number }>,
        width: number,
        color?: Color,
    ): void {
        if (segments.length === 0 || width <= 0) return;
        // Reserve by the upper bound; degenerate segments are skipped and write fewer vertices.
        this.ensureVertices(segments.length * 6);
        const d = this.data;
        const half = width / 2;
        const r = color ? color.r / 255 : 1;
        const g = color ? color.g / 255 : 1;
        const b = color ? color.b / 255 : 1;
        const a = color ? color.a / 255 : 1;
        let o = this.vertexCount * FLOATS_PER_VERTEX;
        let written = 0;

        const put = (x: number, y: number): void => {
            d[o++] = x;
            d[o++] = y;
            d[o++] = r;
            d[o++] = g;
            d[o++] = b;
            d[o++] = a;
            written++;
        };

        for (let i = 0; i < segments.length; i++) {
            const s = segments[i] as { x0: number; y0: number; x1: number; y1: number };
            const dx = s.x1 - s.x0;
            const dy = s.y1 - s.y0;
            const len = Math.hypot(dx, dy);
            if (len < 1e-9) continue;
            const nx = (-dy / len) * half;
            const ny = (dx / len) * half;
            const ax0 = s.x0 + nx;
            const ay0 = s.y0 + ny;
            const ax1 = s.x0 - nx;
            const ay1 = s.y0 - ny;
            const bx0 = s.x1 + nx;
            const by0 = s.y1 + ny;
            const bx1 = s.x1 - nx;
            const by1 = s.y1 - ny;
            // two triangles
            put(ax0, ay0);
            put(bx0, by0);
            put(ax1, ay1);
            put(ax1, ay1);
            put(bx0, by0);
            put(bx1, by1);
        }
        this.vertexCount += written;
    }

    /** Submit: upload the newly appended vertices + one drawArrays for exactly that range */
    public flush(projection: Mat3): void {
        const first = this.uploaded;
        const count = this.vertexCount - first;
        this.drawCalls = 0;
        if (count <= 0) return;
        const gl = this.gl;

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        projection.toMat3Array(this.projectionArray);
        gl.uniformMatrix3fv(this.uProjection, false, this.projectionArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        // Grow the store only when the frame outgrows it; otherwise each flush is a plain
        // `bufferSubData` into a disjoint range (see `uploaded`).
        const stride = FLOATS_PER_VERTEX * 4;
        const needed = this.vertexCount * stride;
        if (needed > this.glCapacityBytes) {
            let cap = Math.max(4096 * FLOATS_PER_VERTEX, this.glCapacityBytes);
            while (cap < needed) cap *= 2;
            gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
            this.glCapacityBytes = cap;
        }
        gl.bufferSubData(
            gl.ARRAY_BUFFER,
            first * stride,
            this.data.subarray(first * FLOATS_PER_VERTEX, this.vertexCount * FLOATS_PER_VERTEX),
        );
        // `firstVertex` is relative to the bound buffer, so the VAO's attribute pointers stay valid.
        gl.drawArrays(gl.TRIANGLES, first, count);
        this.drawCalls++;

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        this.uploaded = this.vertexCount;
    }

    /** Number of triangles submitted this frame */
    public get triangleCount(): number {
        return this.vertexCount / 3;
    }

    /** Current number of pending vertices (test/debug) */
    public get pendingVertices(): number {
        return this.vertexCount;
    }

    public dispose(): void {
        this.gl.deleteBuffer(this.vbo);
        this.gl.deleteVertexArray(this.vao);
        this.gl.deleteProgram(this.program);
    }
}
