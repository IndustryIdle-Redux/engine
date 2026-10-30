/**
 * Instanced sprite batch -- the core of the renderer.
 *
 * Replaces Cocos's "one `cc.Node` + `cc.Sprite` per sprite" model.
 *
 * ### Why this is the key change
 * The original version measured **13,042 nodes** on a large save (10,000 of them overlay Labels, 28.7 MB of heap),
 * and every frame it walked the scene graph, wrote dirty flags and rebuilt dynamic buffers for each node.
 * Here it becomes "one `Float32Array` + one `drawArraysInstanced`":
 * the per-frame cost only depends on the **visible instance count**, with **zero allocations** in steady state (GC pressure gone).
 *
 * ### Structure
 *  - The **unit quad** (6 vertices) is generated in the vertex shader, so no quad VBO is needed
 *  - 16 floats per instance (see the layout notes in `InstanceBuffer`)
 *  - Only identical textures can merge into one draw call; this class batches by texture
 */

import { InstanceBuffer, INSTANCE_ATTRIBS, FLOATS_PER_INSTANCE } from "../InstanceBuffer";
import type { SpriteDrawCall } from "../InstanceBuffer";
import { Mat3 } from "../Mat3";
import { Texture } from "./Texture";

export const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

// Unit quad: generated from gl_VertexID, saving a quad VBO
// 6 vertices → (position, UV): two triangles
const vec2 QUAD[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);

// -- per-instance attributes --
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

    // Anchor: translate the [0,1] quad so the anchor lands at the origin
    vec2 local = (q - a_anchor) * a_size;

    // Instance rotation (cos/sin precomputed, so no trig in the shader)
    vec2 rotated = vec2(
        local.x * a_rot.x - local.y * a_rot.y,
        local.x * a_rot.y + local.y * a_rot.x
    );

    vec2 world = a_center + rotated;

    // The projection matrix maps world coordinates into clip space
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

/** Number of instance attribute locations used in the shader (must match the length of INSTANCE_ATTRIBS) */
export const SHADER_ATTRIBUTE_COUNT = 7;

/** One draw unit batched by texture */
export interface Batch {
    texture: Texture;
    /** Start instance index of this batch in the InstanceBuffer */
    start: number;
    /** Number of instances in this batch */
    count: number;
}

/**
 * Batch splitting (pure logic, no GL dependency, so it can be unit-tested directly).
 *
 * Why it is extracted: `flush()` must use `batch.start` to rebind the instance attribute pointers
 * (instance attributes fetch by `gl_InstanceID`, which restarts from 0 for every draw call);
 * get this `start` wrong and the picture goes **silently wrong** (the second batch reads the first batch's instances).
 * Living here, it can be locked down by unit tests without constructing a GL context.
 */
export class BatchList {
    public readonly items: Batch[] = [];

    public reset(): void {
        this.items.length = 0;
    }

    /**
     * Append one instance.
     * If the texture matches the previous batch it is merged in (only count increases), otherwise a new batch starts at `start`.
     * So **sorting the input by texture** gives the fewest draw calls.
     */
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

    /** Instance data (reused; zero allocations in steady state) */
    public readonly instances = new InstanceBuffer(1024);
    private readonly batches = new BatchList();
    private readonly projection = new Mat3();
    private readonly projectionArray = new Float32Array(9);

    /**
     * Instances already written to the GPU buffer this frame (the **upload watermark**).
     *
     * `flush()` writes only `[uploaded, instances.count)` and then advances the watermark, so every
     * byte is uploaded exactly once per frame and the ranges of successive flushes are **disjoint**.
     *
     * ⚠️ Why disjointness matters: a frame can flush many times (every vector/sprite layer switch),
     * and earlier draws may still be in flight when a later flush writes. Reusing offset 0 would
     * overwrite data those draws are still reading (GL only guarantees this is safe for a full
     * reallocation, i.e. orphaning). The WebGPU backend has the same invariant, for a stronger
     * reason (`WebGPUDevice.flushSprites`: `queue.writeBuffer` is not stream-ordered).
     */
    private uploaded = 0;
    /** GPU data-store size in bytes; `bufferData` is only called when growing, never per flush */
    private glCapacityBytes = 0;

    /**
     * Draw call count of the **last** `flush()` (for the performance panel; replaces reading
     * cc.renderer.drawCalls). The device sums it across a frame's flushes.
     */
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

        // Set up per-instance attributes from INSTANCE_ATTRIBS; stride and divisor let the GPU fetch data per instance on its own
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

    /** Start a frame: reset instances, batches and the upload watermark (memory is not released) */
    public begin(): void {
        this.instances.reset();
        this.batches.reset();
        this.uploaded = 0;
        this.drawCalls = 0;
    }

    /**
     * Record one sprite.
     *
     * If the texture matches the previous batch it is merged into that batch, otherwise a new batch opens --
     * so **sorting the input by texture** yields the fewest draw calls.
     */
    public draw(texture: Texture, call: SpriteDrawCall): void {
        const start = this.instances.count;
        this.instances.push(call);
        this.batches.add(texture, start);
    }

    /**
     * Set the projection matrix (world coordinates → clip space).
     *
     * Computed by `Renderer2D` from the camera and passed in.
     */
    public setProjection(m: Mat3): void {
        this.projection.copyFrom(m);
    }

    /** Actually submit the draw: upload the newly appended instances + one draw call per batch */
    /** Number of sprite instances written this frame (for performance stats and benchmarks) */
    public get instanceCount(): number {
        return this.instances.count;
    }

    public flush(): void {
        const first = this.uploaded;
        const count = this.instances.count;
        // Reset the per-flush counter even on the no-op path, so the device never re-adds the previous flush's calls
        this.drawCalls = 0;
        if (count <= first) return;
        const gl = this.gl;

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);

        this.projection.toMat3Array(this.projectionArray);
        gl.uniformMatrix3fv(this.uProjection, false, this.projectionArray);
        gl.uniform1i(this.uTexture, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
        // Upload **only the newly appended range**. Re-uploading the whole written prefix per flush is
        // what made GL uploads grow with the number of flushes; measured on a synthetic 500-flush frame
        // (4 sprites each) this `bufferData` path issued **1000 store allocations for 164 KB** of payload
        // (`packages/engine/tests/BatchUpload.test.ts`). Now the store is allocated at most a logarithmic number of
        // times per frame and each byte is uploaded once, at a disjoint offset.
        const stride = FLOATS_PER_INSTANCE * 4;
        const offset = first * stride;
        const needed = count * stride;
        if (needed > this.glCapacityBytes) {
            // Grow by doubling so the store is reused across every subsequent flush of the frame.
            // `bufferData` orphans the old store, which is safe: the draws already encoded keep the old one.
            let cap = Math.max(1024, this.glCapacityBytes);
            while (cap < needed) cap *= 2;
            gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
            this.glCapacityBytes = cap;
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, offset, this.instances.data.subarray(first * FLOATS_PER_INSTANCE, count * FLOATS_PER_INSTANCE));

        // ⚠️ Key fix: instance attributes fetch by `gl_InstanceID`, and `gl_InstanceID`
        // **restarts from 0 for every draw call**, so `drawArraysInstanced(..., batch.count)`
        // would only ever read instances at the start of the buffer. With multiple textures you must **rebind the attribute pointers per batch.start**,
        // otherwise the second batch re-reads the first batch's instance data.
        //
        // Symptom: perfectly fine with a single texture; but once a font and an atlas are mixed, the font batch draws
        // the atlas sprite contents (showing up as "vertical bars where the text is"). This is a very subtle bug.
        // `batch.start` is a **frame-absolute** instance index (the buffer accumulates for the whole frame).
        gl.activeTexture(gl.TEXTURE0);
        for (const batch of this.batches.items) {
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
        // The instances stay in the buffer (frame-wide accumulation) -- only the consumed batches are dropped
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
