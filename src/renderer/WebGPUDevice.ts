/// <reference types="@webgpu/types" />
/**
 * WebGPU render device — the **primary backend** (aggressive optimisation target).
 *
 * v1 mirrors the WebGL2 backend semantics exactly (same 16-float instance layout via the shared
 * `InstanceBuffer`, same non-premultiplied blending, same call-order-preserving layer flushes),
 * so the two backends are drop-in interchangeable behind `Renderer2D`.
 *
 * What the WebGPU backend buys over WebGL2 even at parity:
 *  - one render pass per frame instead of independent GL draw state juggling
 *  - `queue.writeBuffer` of only the used range, with no VAO rebinding dance per texture batch
 * and the door is open for the aggressive moves (compute density passes, cached static buffers,
 * compact instance formats) — those build on this class.
 */

import { Color } from "../Color";
import type { Mat3 } from "../Mat3";
import { BatchList, type Batch } from "./SpriteBatch";
import { InstanceBuffer, INSTANCE_ATTRIBS, FLOATS_PER_INSTANCE, type SpriteDrawCall } from "../InstanceBuffer";
import type { RenderDevice, RenderTexture, Segment, TextureOptions } from "./RenderDevice";

type Layer = "sprite" | "vector" | null;

const FLOATS_PER_VERTEX = 6; // x, y, r, g, b, a (same packing as GraphicsBatch)

class GpuTexture implements RenderTexture {
    public readonly width: number;
    public readonly height: number;
    public bindGroup: GPUBindGroup | null = null;
    constructor(
        public readonly texture: GPUTexture,
        width: number,
        height: number,
        /**
         * Sampler created from this texture's `TextureOptions`.
         *
         * The WebGL2 backend honours `linear` / `wrap` / `premultiplyAlpha` (`Texture.fromImage`); this
         * backend used to ignore them and hardcode linear + clamp-to-edge, so the same call produced
         * different sampling on the two backends. The sampler is per texture (cached by filter/address
         * mode) because a WebGPU bind group fixes the sampler, unlike GL's per-texture parameters.
         */
        public readonly sampler: GPUSampler,
    ) {
        this.width = width;
        this.height = height;
    }
}

const SPRITE_SHADER = /* wgsl */ `
struct Proj { m: mat3x3<f32> };
@group(0) @binding(0) var<uniform> proj: Proj;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VSIn {
    @builtin(vertex_index) vid: u32,
    @location(0) center: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) anchor: vec2<f32>,
    @location(3) rot: vec2<f32>,
    @location(4) uvPos: vec2<f32>,
    @location(5) uvSize: vec2<f32>,
    @location(6) color: vec4<f32>,
};
struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn vs(in: VSIn) -> VSOut {
    var qarr = array<vec2<f32>, 6>(
        vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
        vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
    );
    let q = qarr[in.vid];
    let local = (q - in.anchor) * in.size;
    let rotated = vec2(
        local.x * in.rot.x - local.y * in.rot.y,
        local.x * in.rot.y + local.y * in.rot.x,
    );
    let world = in.center + rotated;
    let clip = proj.m * vec3(world, 1.0);

    var out: VSOut;
    out.pos = vec4(clip.xy, 0.0, 1.0);
    out.uv = in.uvPos + q * in.uvSize;
    out.color = in.color;
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    return textureSample(tex, samp, in.uv) * in.color;
}
`;

const VECTOR_SHADER = /* wgsl */ `
struct Proj { m: mat3x3<f32> };
@group(0) @binding(0) var<uniform> proj: Proj;

struct VSIn {
    @location(0) pos: vec2<f32>,
    @location(1) color: vec4<f32>,
};
struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs(in: VSIn) -> VSOut {
    let clip = proj.m * vec3(in.pos, 1.0);
    var out: VSOut;
    out.pos = vec4(clip.xy, 0.0, 1.0);
    out.color = in.color;
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    return in.color;
}
`;

export class WebGPUDevice implements RenderDevice {
    public readonly kind = "webgpu" as const;

    private readonly spritePipeline: GPURenderPipeline;
    private readonly vectorPipeline: GPURenderPipeline;
    private readonly projBuffer: GPUBuffer;
    private readonly sampler: GPUSampler;
    /** Samplers keyed by `linear|wrap`, so the two texture-option combinations share one GPU sampler */
    private readonly samplerCache = new Map<string, GPUSampler>();
    private readonly bindGroupLayout: GPUBindGroupLayout;
    private readonly vectorBindGroup: GPUBindGroup;

    /** shared instance packing (16 floats/instance — the WebGL2 layout) */
    private readonly instances = new InstanceBuffer(1024);
    private instanceBuffer: GPUBuffer;
    private instanceCapacity = 1024;
    /**
     * Frame-wide sprite staging (see `flushSprites`).
     *
     * ⚠️ `queue.writeBuffer` is **not** a draw-time upload: every write enqueued before a submit is
     * applied *before* that submit's commands execute. Writing the frame's instances into the same
     * buffer once per flush therefore makes **every** draw of the frame read the **last** write
     * (the earlier flushes' draws render garbage). So the instances accumulate for the whole frame
     * and each flush writes only its own disjoint range:
     *  - `instanceBase` — frame index the data currently in the GPU buffer starts at
     *  - `instanceUploaded` — frame index already written to the GPU buffer
     */
    private instanceBase = 0;
    private instanceUploaded = 0;
    /** whether a sprite draw has already been encoded this frame (the buffer is then referenced) */
    private spriteEncoded = false;
    /** instance count of the last completed frame — sizes the buffer before the frame starts */
    private lastFrameInstances = 0;

    private vectorData = new Float32Array(4096 * FLOATS_PER_VERTEX);
    private vectorVertices = 0;
    private vectorBuffer: GPUBuffer;
    /** same frame-wide accumulation rule as the sprite instances (`instanceBase`) */
    private vectorCapacity = 4096;
    private vectorBase = 0;
    private vectorUploaded = 0;
    private vectorEncoded = false;
    private lastFrameVectorVertices = 0;

    private readonly batches = new BatchList();
    private layer: Layer = null;
    private totals = { drawCalls: 0, instances: 0, triangles: 0 };
    private projArray = new Float32Array(12);
    private projScratch = new Float32Array(9);

    private pass: GPURenderPassEncoder | null = null;
    private encoder: GPUCommandEncoder | null = null;
    private disposed = false;

    private constructor(
        private readonly device: GPUDevice,
        private readonly context: GPUCanvasContext,
        format: GPUTextureFormat,
    ) {
        this.projBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.sampler = device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });
        this.samplerCache.set("linear|clamp", this.sampler);
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            ],
        });

        this.spritePipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            vertex: {
                module: device.createShaderModule({ code: SPRITE_SHADER }),
                entryPoint: "vs",
                buffers: [
                    {
                        arrayStride: FLOATS_PER_INSTANCE * 4,
                        stepMode: "instance",
                        attributes: INSTANCE_ATTRIBS.map((a, i) => ({
                            shaderLocation: i,
                            offset: a.offset * 4,
                            format: ("float32x" + Math.min(4, a.size)) as GPUVertexFormat,
                        })),
                    },
                ],
            },
            fragment: {
                module: device.createShaderModule({ code: SPRITE_SHADER }),
                entryPoint: "fs",
                targets: [
                    {
                        format,
                        // ⚠️ without this blend state the pipeline REPLACES the framebuffer, so the
                        // transparent texels of every atlas sprite paint solid black (matches the
                        // GL backend's SRC_ALPHA / ONE_MINUS_SRC_ALPHA)
                        blend: {
                            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                        },
                    },
                ],
            },
            primitive: { topology: "triangle-list" },
        });

        // vector pipeline: interleaved x,y,r,g,b,a
        const vecLayout = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
        });
        this.vectorPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [vecLayout] }),
            vertex: {
                module: device.createShaderModule({ code: VECTOR_SHADER }),
                entryPoint: "vs",
                buffers: [
                    {
                        arrayStride: FLOATS_PER_VERTEX * 4,
                        stepMode: "vertex",
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: "float32x2" },
                            { shaderLocation: 1, offset: 8, format: "float32x4" },
                        ],
                    },
                ],
            },
            fragment: {
                module: device.createShaderModule({ code: VECTOR_SHADER }),
                entryPoint: "fs",
                targets: [
                    {
                        format,
                        blend: {
                            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                        },
                    },
                ],
            },
            primitive: { topology: "triangle-list" },
        });
        this.vectorBindGroup = device.createBindGroup({
            layout: vecLayout,
            entries: [{ binding: 0, resource: { buffer: this.projBuffer } }],
        });

        this.instanceBuffer = device.createBuffer({
            size: this.instanceCapacity * FLOATS_PER_INSTANCE * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.vectorBuffer = device.createBuffer({
            size: this.vectorData.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
    }

    /** async factory (GPUDevice acquisition is async; the facade picks the backend at boot) */
    public static async create(canvas: HTMLCanvasElement): Promise<WebGPUDevice | null> {
        if (!globalThis.navigator?.gpu) return null;
        const adapter = await navigator.gpu.requestAdapter().catch(() => null);
        if (!adapter) return null;
        const device = await adapter.requestDevice().catch(() => null);
        if (!device) return null;
        const context = canvas.getContext("webgpu");
        if (!context) return null;
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: "opaque" });
        return new WebGPUDevice(device, context, format);
    }

    public get drawCalls(): number {
        return this.totals.drawCalls;
    }
    public get instanceCount(): number {
        return this.totals.instances;
    }
    public get triangleCount(): number {
        return this.totals.triangles;
    }

    public resize(_pixelWidth: number, _pixelHeight: number): void {
        // the canvas context follows the canvas size automatically
    }

    public beginFrame(clearColor: Color | undefined, projection: Mat3): void {
        this.totals = { drawCalls: 0, instances: 0, triangles: 0 };
        this.instances.reset();
        this.batches.reset();
        this.instanceBase = 0;
        this.instanceUploaded = 0;
        this.spriteEncoded = false;
        this.vectorVertices = 0;
        this.vectorBase = 0;
        this.vectorUploaded = 0;
        this.vectorEncoded = false;
        this.layer = null;
        // Size the GPU buffers for this frame while nothing references them yet: the previous frame
        // reports what a frame needs, and a frame that outgrows it rotates to a fresh buffer mid-frame.
        this.reserveInstanceCapacity(this.lastFrameInstances);
        this.reserveVectorCapacity(this.lastFrameVectorVertices);

        // mat3x3 in WGSL is column-major with 16B column stride; copy each of Mat3's three columns into a vec3 slot
        const m = projection.toMat3Array(this.projScratch);
        const p = this.projArray;
        for (let col = 0; col < 3; col++) {
            p[col * 4] = m[col * 3] ?? 0;
            p[col * 4 + 1] = m[col * 3 + 1] ?? 0;
            p[col * 4 + 2] = m[col * 3 + 2] ?? 0;
            p[col * 4 + 3] = 0;
        }
        this.device.queue.writeBuffer(this.projBuffer, 0, p.buffer, p.byteOffset, 48);

        const c = clearColor ?? new Color(0, 0, 0, 0);
        this.encoder = this.device.createCommandEncoder();
        this.pass = this.encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.context.getCurrentTexture().createView(),
                    clearValue: { r: c.r / 255, g: c.g / 255, b: c.b / 255, a: c.a / 255 },
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        });
    }

    public endFrame(): void {
        if (this.layer === "vector") this.flushVectors();
        if (this.layer === "sprite") this.flushSprites();
        this.layer = null;
        this.pass?.end();
        this.pass = null;
        if (this.encoder) {
            this.device.queue.submit([this.encoder.finish()]);
            this.encoder = null;
        }
        // remember the frame's size so `beginFrame` can size the buffers before the next frame starts
        this.lastFrameInstances = this.instances.count;
        this.lastFrameVectorVertices = this.vectorVertices;
    }

    /* ---------------- frame-wide buffers ---------------- */

    /**
     * Make the sprite instance buffer hold `instances` instances.
     *
     * Growing is safe **only while no draw of this frame references the buffer**; mid-frame it has to
     * rotate instead (see `flushSprites`), so the already-encoded draws keep their own buffer.
     */
    private reserveInstanceCapacity(needed: number): void {
        if (needed <= this.instanceCapacity) return;
        let cap = this.instanceCapacity;
        while (cap < needed) cap *= 2;
        this.instanceBuffer.destroy();
        this.instanceBuffer = this.device.createBuffer({
            size: cap * FLOATS_PER_INSTANCE * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.instanceCapacity = cap;
    }

    /** Grow the vertex buffer while it is still unreferenced this frame */
    private reserveVectorCapacity(needed: number): void {
        if (needed <= this.vectorCapacity) return;
        let cap = this.vectorCapacity;
        while (cap < needed) cap *= 2;
        this.vectorBuffer.destroy();
        this.vectorBuffer = this.device.createBuffer({
            size: cap * FLOATS_PER_VERTEX * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.vectorCapacity = cap;
    }

    /**
     * Start a fresh instance buffer for the data that is still un-uploaded (the draws encoded so far
     * keep reading the old buffer, which stays alive until the GPU is done with it).
     */
    private rotateInstanceBuffer(): void {
        const needed = this.instances.count - this.instanceUploaded;
        let cap = Math.max(1024, this.instanceCapacity);
        while (cap < needed) cap *= 2;
        this.instanceBuffer = this.device.createBuffer({
            size: cap * FLOATS_PER_INSTANCE * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.instanceCapacity = cap;
        this.instanceBase = this.instanceUploaded;
    }

    private rotateVectorBuffer(): void {
        const needed = this.vectorVertices - this.vectorUploaded;
        let cap = Math.max(4096, this.vectorCapacity);
        while (cap < needed) cap *= 2;
        this.vectorBuffer = this.device.createBuffer({
            size: cap * FLOATS_PER_VERTEX * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.vectorCapacity = cap;
        this.vectorBase = this.vectorUploaded;
    }

    private flushSprites(): void {
        const first = this.instanceUploaded;
        if (this.instances.count <= first) return;
        const stride = FLOATS_PER_INSTANCE * 4;
        if (this.instances.count - this.instanceBase > this.instanceCapacity) {
            if (this.spriteEncoded) this.rotateInstanceBuffer();
            else this.reserveInstanceCapacity(this.instances.count);
        }
        // only the range [first, count) is new — every earlier flush already wrote its own range
        const view = this.instances.view();
        const byteOffset = (first - this.instanceBase) * stride;
        const byteLength = (this.instances.count - first) * stride;
        this.device.queue.writeBuffer(
            this.instanceBuffer,
            byteOffset,
            view.buffer,
            view.byteOffset + first * stride,
            byteLength,
        );
        for (const batch of this.batches.items as Batch[]) {
            const tex = batch.texture as unknown as GpuTexture;
            if (!tex.bindGroup) {
                tex.bindGroup = this.device.createBindGroup({
                    layout: this.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: this.projBuffer } },
                        { binding: 1, resource: tex.sampler ?? this.sampler },
                        { binding: 2, resource: tex.texture.createView() },
                    ],
                });
            }
            this.pass!.setPipeline(this.spritePipeline);
            this.pass!.setBindGroup(0, tex.bindGroup);
            this.pass!.setVertexBuffer(
                0,
                this.instanceBuffer,
                (batch.start - this.instanceBase) * stride,
                batch.count * stride,
            );
            this.pass!.draw(6, batch.count);
            this.totals.drawCalls++;
        }
        this.totals.instances += this.instances.count - first;
        this.instanceUploaded = this.instances.count;
        this.spriteEncoded = true;
        // keep the instances: the buffer accumulates for the whole frame, only the batches are consumed
        this.batches.reset();
    }

    private flushVectors(): void {
        const first = this.vectorUploaded;
        if (this.vectorVertices <= first) return;
        const stride = FLOATS_PER_VERTEX * 4;
        if (this.vectorVertices - this.vectorBase > this.vectorCapacity) {
            if (this.vectorEncoded) this.rotateVectorBuffer();
            else this.reserveVectorCapacity(this.vectorVertices);
        }
        const byteOffset = (first - this.vectorBase) * stride;
        const bytes = (this.vectorVertices - first) * stride;
        this.device.queue.writeBuffer(
            this.vectorBuffer,
            byteOffset,
            this.vectorData.buffer,
            this.vectorData.byteOffset + first * stride,
            bytes,
        );
        this.pass!.setPipeline(this.vectorPipeline);
        this.pass!.setBindGroup(0, this.vectorBindGroup);
        this.pass!.setVertexBuffer(0, this.vectorBuffer);
        // draw only this flush's range; `firstVertex` is relative to the bound buffer's origin
        const count = this.vectorVertices - first;
        this.pass!.draw(count, 1, first - this.vectorBase);
        this.totals.drawCalls++;
        this.totals.triangles += count / 3;
        this.vectorUploaded = this.vectorVertices;
        this.vectorEncoded = true;
    }

    public createTexture(
        image: TexImageSource,
        width: number,
        height: number,
        options: TextureOptions = {},
    ): RenderTexture {
        const texture = this.device.createTexture({
            size: [width, height],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        // `flipY` matches the GL backend's `UNPACK_FLIP_Y_WEBGL`, so UV math is identical.
        // `premultipliedAlpha` mirrors `UNPACK_PREMULTIPLY_ALPHA_WEBGL` (GL's default is false, same here).
        const premultipliedAlpha = options.premultiplyAlpha === true;
        this.device.queue.copyExternalImageToTexture(
            { source: image as CanvasImageSource, flipY: true },
            { texture, premultipliedAlpha },
            [width, height],
        );
        return new GpuTexture(texture, width, height, this.samplerFor(options));
    }

    /** Sampler for a texture-option set; `linear !== false` matches WebGL's `Texture.fromImage` defaults */
    private samplerFor(options: TextureOptions): GPUSampler {
        const linear = options.linear !== false;
        const wrap = options.wrap === true;
        const key = `${linear ? "linear" : "nearest"}|${wrap ? "repeat" : "clamp"}`;
        const cached = this.samplerCache.get(key);
        if (cached) return cached;
        const filter: GPUFilterMode = linear ? "linear" : "nearest";
        const addressMode: GPUAddressMode = wrap ? "repeat" : "clamp-to-edge";
        const sampler = this.device.createSampler({
            magFilter: filter,
            minFilter: filter,
            addressModeU: addressMode,
            addressModeV: addressMode,
        });
        this.samplerCache.set(key, sampler);
        return sampler;
    }

    public drawSprite(texture: RenderTexture, call: SpriteDrawCall): void {
        if (this.layer === "vector") this.flushVectors();
        this.layer = "sprite";
        const start = this.instances.count;
        this.instances.push(call);
        this.batches.add(texture as unknown as Batch["texture"], start);
    }

    public addTriangles(points: readonly number[], color: Color | undefined, dx: number, dy: number): void {
        if (this.layer === "sprite") this.flushSprites();
        this.layer = "vector";
        const n = (points.length / 2) | 0;
        this.ensureVectorCapacity(n);
        const d = this.vectorData;
        const r = color ? color.r / 255 : 1;
        const g = color ? color.g / 255 : 1;
        const b = color ? color.b / 255 : 1;
        const a = color ? color.a / 255 : 1;
        let o = this.vectorVertices * FLOATS_PER_VERTEX;
        for (let i = 0; i < n; i++) {
            d[o++] = (points[i * 2] as number) + dx;
            d[o++] = (points[i * 2 + 1] as number) + dy;
            d[o++] = r;
            d[o++] = g;
            d[o++] = b;
            d[o++] = a;
        }
        this.vectorVertices += n;
    }

    public addSegments(segments: readonly Segment[], width: number, color: Color | undefined): void {
        if (segments.length === 0 || width <= 0) return;
        if (this.layer === "sprite") this.flushSprites();
        this.layer = "vector";
        this.ensureVectorCapacity(segments.length * 6);
        const d = this.vectorData;
        const half = width / 2;
        const r = color ? color.r / 255 : 1;
        const g = color ? color.g / 255 : 1;
        const b = color ? color.b / 255 : 1;
        const a = color ? color.a / 255 : 1;
        let o = this.vectorVertices * FLOATS_PER_VERTEX;
        for (const s of segments) {
            const dx = s.x1 - s.x0;
            const dy = s.y1 - s.y0;
            const len = Math.hypot(dx, dy);
            if (len < 1e-9) continue;
            const nx = (-dy / len) * half;
            const ny = (dx / len) * half;
            const x0n = s.x0 + nx, y0n = s.y0 + ny, x1n = s.x1 + nx, y1n = s.y1 + ny;
            const x0p = s.x0 - nx, y0p = s.y0 - ny, x1p = s.x1 - nx, y1p = s.y1 - ny;
            // two triangles: (x0n,y0n) (x1n,y1n) (x0p,y0p) — (x0p,y0p) (x1n,y1n) (x1p,y1p)
            const verts = [x0n, y0n, x1n, y1n, x0p, y0p, x0p, y0p, x1n, y1n, x1p, y1p];
            for (let i = 0; i < 6; i++) {
                d[o++] = verts[i * 2] as number;
                d[o++] = verts[i * 2 + 1] as number;
                d[o++] = r;
                d[o++] = g;
                d[o++] = b;
                d[o++] = a;
            }
            this.vectorVertices += 6;
        }
    }

    private ensureVectorCapacity(vertices: number): void {
        const need = (this.vectorVertices + vertices) * FLOATS_PER_VERTEX;
        if (need <= this.vectorData.length) return;
        let cap = this.vectorData.length;
        while (cap < need) cap *= 2;
        const next = new Float32Array(cap);
        next.set(this.vectorData.subarray(0, this.vectorVertices * FLOATS_PER_VERTEX));
        this.vectorData = next;
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.instanceBuffer.destroy();
        this.vectorBuffer.destroy();
        this.projBuffer.destroy();
        this.device.destroy();
    }
}
