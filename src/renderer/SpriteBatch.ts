/**
 * Instanced sprite batch: one `Float32Array` of instances plus one `drawArraysInstanced`
 * per texture batch. The unit quad is generated in the vertex shader, so no quad VBO is needed.
 *
 * Only consecutive draws with the same texture merge, so sorting the input by texture gives
 * the fewest draw calls.
 */

import { InstanceBuffer, INSTANCE_ATTRIBS, FLOATS_PER_INSTANCE } from "../InstanceBuffer";
import type { SpriteDrawCall } from "../InstanceBuffer";
import { Mat3 } from "../Mat3";
import { Texture } from "./Texture";

export const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

// Unit quad generated from gl_VertexID: two triangles, 6 vertices
const vec2 QUAD[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);

layout(location = 0) in vec2 a_center;
layout(location = 1) in vec2 a_size;
layout(location = 2) in vec2 a_anchor;
layout(location = 3) in vec2 a_rot;      // (cos, sin)
layout(location = 4) in vec2 a_uvPos;
layout(location = 5) in vec2 a_uvSize;
layout(location = 6) in vec4 a_color;

uniform mat3 u_projection;

out vec2 v_uv;
out vec4 v_color;

void main() {
    vec2 q = QUAD[gl_VertexID];

    // Place the anchor at the origin, then scale
    vec2 local = (q - a_anchor) * a_size;

    // Rotation is precomputed per instance as (cos, sin)
    vec2 rotated = vec2(
        local.x * a_rot.x - local.y * a_rot.y,
        local.x * a_rot.y + local.y * a_rot.x
    );

    vec2 world = a_center + rotated;

    vec3 clip = u_projection * vec3(world, 1.0);
    gl_Position = vec4(clip.xy, 0.0, 1.0);

    v_uv = a_uvPos + q * a_uvSize;
    v_color = a_color;
}
`;

export const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision mediump float;

uniform sampler2D u_texture;

in vec2 v_uv;
in vec4 v_color;
out vec4 fragColor;

void main() {
    fragColor = texture(u_texture, v_uv) * v_color;
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("[renderer] createShader failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader) ?? "(no log)";
        gl.deleteShader(shader);
        throw new Error(`[renderer] shader compile failed: ${info}`);
    }
    return shader;
}

/** One draw unit batched by texture */
export interface Batch {
    texture: Texture;
    /** Start instance index of this batch in the InstanceBuffer */
    start: number;
    /** Number of instances in this batch */
    count: number;
}

/**
 * Batch splitting (pure logic, no GL dependency).
 *
 * `flush()` uses `start` to offset the instance attribute pointers: instance attributes are
 * indexed by `gl_InstanceID`, which restarts at 0 for every draw, so a batch must rebind its
 * pointer to `start * stride` or it re-reads the first batch's instances.
 */
export class BatchList {
    public readonly items: Batch[] = [];

    public reset(): void {
        this.items.length = 0;
    }

    /** Append one instance, merging into the previous batch when the texture matches. */
    public add(texture: Texture, start: number): void {
        const last = this.items[this.items.length - 1];
        if (last && last.texture === texture) {
            last.count++;
        } else {
            this.items.push({ texture, start, count: 1 });
        }
    }

    public get length(): number {
        return this.items.length;
    }
}

export class SpriteBatch {
    private readonly gl: WebGL2RenderingContext;
    private readonly program: WebGLProgram;
    private readonly vao: WebGLVertexArrayObject;
    private readonly instanceVbo: WebGLBuffer;
    private readonly uProjection: WebGLUniformLocation;
    private readonly uTexture: WebGLUniformLocation;

    /** Instance data (reused across frames) */
    public readonly instances = new InstanceBuffer(1024);
    private readonly batches = new BatchList();
    private readonly projection = new Mat3();
    private readonly projectionArray = new Float32Array(9);

    /**
     * Instances already uploaded this frame.
     *
     * `flush()` writes only `[uploaded, count)` so successive flushes write disjoint ranges;
     * an earlier draw may still be reading its range when a later flush uploads.
     */
    private uploaded = 0;
    /** GPU data-store size in bytes; `bufferData` is only called when growing */
    private glCapacityBytes = 0;
    /** Blend state currently set, so it is switched only when a batch needs a different mode */
    private premultipliedBlend = false;

    /** Draw call count of the last `flush()` */
    public drawCalls = 0;

    constructor(gl: WebGL2RenderingContext) {
        this.gl = gl;

        const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
        const program = gl.createProgram();
        if (!program) throw new Error("[renderer] createProgram failed");
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program) ?? "(no log)";
            throw new Error(`[renderer] shader link failed: ${info}`);
        }
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        this.program = program;

        const up = gl.getUniformLocation(program, "u_projection");
        const ut = gl.getUniformLocation(program, "u_texture");
        if (!up || !ut) throw new Error("[renderer] uniform locations not found");
        this.uProjection = up;
        this.uTexture = ut;

        const vao = gl.createVertexArray();
        const vbo = gl.createBuffer();
        if (!vao || !vbo) throw new Error("[renderer] failed to create VAO/VBO");
        this.vao = vao;
        this.instanceVbo = vbo;

        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

        const stride = FLOATS_PER_INSTANCE * 4;
        INSTANCE_ATTRIBS.forEach((attr, location) => {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, attr.size, gl.FLOAT, false, stride, attr.offset * 4);
            gl.vertexAttribDivisor(location, 1);
        });

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    /** For tests: inspect the batch split (read-only) */
    public get batchesForTest(): ReadonlyArray<Batch> {
        return this.batches.items;
    }

    /** Start a frame: reset instances, batches, blend state and the upload watermark. */
    public begin(): void {
        this.instances.reset();
        this.batches.reset();
        this.uploaded = 0;
        this.drawCalls = 0;
        this.setStraightBlend();
    }

    /** Restore straight-alpha blending; also used before vector draws change the layer. */
    public setStraightBlend(): void {
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
        this.premultipliedBlend = false;
    }

    /** Record one sprite; same-texture draws merge into the current batch. */
    public draw(texture: Texture, call: SpriteDrawCall): void {
        const start = this.instances.count;
        this.instances.push(call);
        this.batches.add(texture, start);
    }

    /** Set the world → clip projection (computed from the camera by `Renderer2D`). */
    public setProjection(m: Mat3): void {
        this.projection.copyFrom(m);
    }

    /** Number of sprite instances written this frame */
    public get instanceCount(): number {
        return this.instances.count;
    }

    /** Submit: upload the newly appended instances, then one draw per texture batch. */
    public flush(): void {
        const first = this.uploaded;
        const count = this.instances.count;
        this.drawCalls = 0;
        if (count <= first) return;
        const gl = this.gl;

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);

        this.projection.toMat3Array(this.projectionArray);
        gl.uniformMatrix3fv(this.uProjection, false, this.projectionArray);
        gl.uniform1i(this.uTexture, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
        const stride = FLOATS_PER_INSTANCE * 4;
        const offset = first * stride;
        const needed = count * stride;
        if (needed > this.glCapacityBytes) {
            // Orphan the old store and grow by doubling; already-encoded draws keep the old one.
            let cap = Math.max(1024, this.glCapacityBytes);
            while (cap < needed) cap *= 2;
            gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
            this.glCapacityBytes = cap;
        }
        gl.bufferSubData(
            gl.ARRAY_BUFFER,
            offset,
            this.instances.data.subarray(first * FLOATS_PER_INSTANCE, count * FLOATS_PER_INSTANCE),
        );

        gl.activeTexture(gl.TEXTURE0);
        for (const batch of this.batches.items) {
            const premultiplied = batch.texture.premultiplied === true;
            if (premultiplied !== this.premultipliedBlend) {
                if (premultiplied) {
                    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                } else {
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                }
                this.premultipliedBlend = premultiplied;
            }
            gl.bindTexture(gl.TEXTURE_2D, batch.texture.handle);
            const base = batch.start * stride;
            for (let i = 0; i < INSTANCE_ATTRIBS.length; i++) {
                const attr = INSTANCE_ATTRIBS[i] as { size: number; offset: number };
                gl.vertexAttribPointer(i, attr.size, gl.FLOAT, false, stride, base + attr.offset * 4);
            }
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count);
            this.drawCalls++;
        }

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        // Instances stay in the buffer for the whole frame; only the consumed batches are dropped.
        this.uploaded = count;
        this.batches.reset();
    }

    public dispose(): void {
        const gl = this.gl;
        gl.deleteBuffer(this.instanceVbo);
        gl.deleteVertexArray(this.vao);
        gl.deleteProgram(this.program);
    }
}
