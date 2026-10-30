/// <reference types="@webgpu/types" />
/**
 * WebGPU render device.
 *
 * Frame data is staged once per frame and each flush uploads only its own disjoint range:
 * `queue.writeBuffer` is not stream-ordered, so reusing an offset per flush would make every
 * draw of the frame read the last write.
 *
 * Creation runs all resource creation inside a validation error scope before the canvas is
 * bound, so a driver that rejects a pipeline still leaves the canvas available for the WebGL2
 * fallback. A lost device can be rebuilt with `recover()`.
 */

import { Color } from "../Color";
import type { Mat3 } from "../Mat3";
import { BatchList, type Batch } from "./SpriteBatch";
import { InstanceBuffer, INSTANCE_ATTRIBS, FLOATS_PER_INSTANCE, type SpriteDrawCall } from "../InstanceBuffer";
import { assertTextureSize } from "./RenderDevice";
import type { RenderDevice, RenderTexture, Segment, TextureOptions, TextureSource } from "./RenderDevice";

type Layer = "sprite" | "vector" | null;

const FLOATS_PER_VERTEX = 6; // x, y, r, g, b, a

export interface WebGPUDeviceOptions {
    alpha?: boolean;
    antialias?: boolean;
}

class GpuTexture implements RenderTexture {
    public readonly kind = "webgpu" as const;
    public texture: GPUTexture;
    public width: number;
    public height: number;
    public premultiplied: boolean;
    public sampler: GPUSampler;
    public bindGroup: GPUBindGroup | null = null;
    public source: TextureSource;

    constructor(texture: GPUTexture, sampler: GPUSampler, source: TextureSource) {
        this.texture = texture;
        this.sampler = sampler;
        this.source = source;
        this.width = source.width;
        this.height = source.height;
        this.premultiplied = source.options.premultiplyAlpha === true;
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
    public onLost: (() => void) | null = null;

    private device: GPUDevice;
    private context: GPUCanvasContext | null;
    private readonly format: GPUTextureFormat;
    private readonly antialias: boolean;
    private readonly alphaMode: GPUCanvasAlphaMode;
    private lost = false;
    private disposed = false;

    private spritePipelines!: { straight: GPURenderPipeline; premultiplied: GPURenderPipeline };
    private vectorPipeline!: GPURenderPipeline;
    private projBuffer!: GPUBuffer;
    private sampler!: GPUSampler;
    private readonly samplerCache = new Map<string, GPUSampler>();
    private bindGroupLayout!: GPUBindGroupLayout;
    private vectorBindGroup!: GPUBindGroup;

    /** shared instance packing (16 floats per instance, same layout as WebGL2) */
    private readonly instances = new InstanceBuffer(1024);
    private instanceBuffer!: GPUBuffer;
    private instanceCapacity = 1024;
    private instanceBase = 0;
    private instanceUploaded = 0;
    private spriteEncoded = false;
    private lastFrameInstances = 0;

    private vectorData = new Float32Array(4096 * FLOATS_PER_VERTEX);
    private vectorVertices = 0;
    private vectorBuffer!: GPUBuffer;
    private vectorCapacity = 4096;
    private vectorBase = 0;
    private vectorUploaded = 0;
    private vectorEncoded = false;
    private lastFrameVectorVertices = 0;

    /** Buffers replaced mid-frame; destroyed after the frame's submit hands them to the GPU. */
    private retiredBuffers: GPUBuffer[] = [];

    private readonly batches = new BatchList();
    private layer: Layer = null;
    private totals = { drawCalls: 0, instances: 0, triangles: 0 };
    private projArray = new Float32Array(12);
    private projScratch = new Float32Array(9);

    private pass: GPURenderPassEncoder | null = null;
    private encoder: GPUCommandEncoder | null = null;

    private msaaTexture: GPUTexture | null = null;
    private msaaWidth = 0;
    private msaaHeight = 0;

    private readonly textures = new Set<GpuTexture>();

    private constructor(
        device: GPUDevice,
        context: GPUCanvasContext | null,
        format: GPUTextureFormat,
        options: WebGPUDeviceOptions = {},
    ) {
        this.device = device;
        this.context = context;
        this.format = format;
        this.antialias = options.antialias !== false;
        this.alphaMode = options.alpha === true ? "premultiplied" : "opaque";
        this.buildResources();
        this.watchLost(device);
        if (context) this.configureContext();
    }

    /** async factory (GPUDevice acquisition is async; the facade picks the backend at boot) */
    public static async create(
        canvas: HTMLCanvasElement,
        options: WebGPUDeviceOptions = {},
    ): Promise<WebGPUDevice | null> {
        const gpu = globalThis.navigator?.gpu;
        if (!gpu) return null;
        const adapter = await gpu.requestAdapter().catch(() => null);
        if (!adapter) return null;
        const device = await adapter.requestDevice().catch(() => null);
        if (!device) return null;

        // Build every resource inside the validation scope, before touching the canvas: once
        // getContext("webgpu") succeeds the canvas can no longer hand out a WebGL2 context.
        device.pushErrorScope("validation");
        let probe: WebGPUDevice | null = null;
        try {
            probe = new WebGPUDevice(device, null, gpu.getPreferredCanvasFormat(), options);
        } catch {
            probe = null;
        }
        let failed = false;
        let error: GPUError | null = null;
        try {
            error = await device.popErrorScope();
        } catch {
            failed = true;
        }
        if (failed || !probe || error) {
            device.destroy();
            return null;
        }

        const context = canvas.getContext("webgpu");
        if (!context) {
            device.destroy();
            return null;
        }
        probe.context = context;
        try {
            probe.configureContext();
        } catch {
            device.destroy();
            return null;
        }
        return probe;
    }

    public get isLost(): boolean {
        return this.lost;
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

    public resize(pixelWidth: number, pixelHeight: number): void {
        // The MSAA attachment tracks the swap-chain size; rebuild it on the next frame.
        if (this.msaaWidth !== pixelWidth || this.msaaHeight !== pixelHeight) {
            this.msaaWidth = pixelWidth;
            this.msaaHeight = pixelHeight;
            this.releaseMsaa();
        }
    }

    /* ---------------- device lifecycle ---------------- */

    private watchLost(device: GPUDevice): void {
        device.lost.then(
            () => {
                if (this.disposed || this.device !== device) return;
                this.lost = true;
                this.layer = null;
                this.pass = null;
                this.encoder = null;
                this.onLost?.();
            },
            () => {},
        );
    }

    private configureContext(): void {
        this.context?.configure({ device: this.device, format: this.format, alphaMode: this.alphaMode });
    }

    /** (Re)create pipelines, buffers and bind groups for the current device. */
    private buildResources(): void {
        const device = this.device;
        this.samplerCache.clear();
        this.releaseMsaa();
        this.retiredBuffers = [];

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

        const spriteModule = device.createShaderModule({ code: SPRITE_SHADER });
        const spriteLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
        this.spritePipelines = {
            straight: this.createSpritePipeline(device, spriteModule, spriteLayout, false),
            premultiplied: this.createSpritePipeline(device, spriteModule, spriteLayout, true),
        };

        const vectorModule = device.createShaderModule({ code: VECTOR_SHADER });
        const vectorLayout = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
        });
        this.vectorPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [vectorLayout] }),
            vertex: {
                module: vectorModule,
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
                module: vectorModule,
                entryPoint: "fs",
                targets: [{ format: this.format, blend: this.blendState(false) }],
            },
            primitive: { topology: "triangle-list" },
            multisample: { count: this.antialias ? 4 : 1 },
        });
        this.vectorBindGroup = device.createBindGroup({
            layout: vectorLayout,
            entries: [{ binding: 0, resource: { buffer: this.projBuffer } }],
        });

        this.instanceBuffer = device.createBuffer({
            size: this.instanceCapacity * FLOATS_PER_INSTANCE * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.vectorBuffer = device.createBuffer({
            size: this.vectorCapacity * FLOATS_PER_VERTEX * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
    }

    private createSpritePipeline(
        device: GPUDevice,
        module: GPUShaderModule,
        layout: GPUPipelineLayout,
        premultiplied: boolean,
    ): GPURenderPipeline {
        return device.createRenderPipeline({
            layout,
            vertex: {
                module,
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
                module,
                entryPoint: "fs",
                targets: [{ format: this.format, blend: this.blendState(premultiplied) }],
            },
            primitive: { topology: "triangle-list" },
            multisample: { count: this.antialias ? 4 : 1 },
        });
    }

    private blendState(premultiplied: boolean): GPUBlendState {
        return {
            color: premultiplied
                ? { srcFactor: "one", dstFactor: "one-minus-src-alpha" }
                : { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        };
    }

    private ensureMsaa(width: number, height: number): GPUTexture {
        if (this.msaaTexture && this.msaaWidth === width && this.msaaHeight === height) return this.msaaTexture;
        this.releaseMsaa();
        this.msaaWidth = width;
        this.msaaHeight = height;
        this.msaaTexture = this.device.createTexture({
            size: [width, height],
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            sampleCount: 4,
        });
        return this.msaaTexture;
    }

    private releaseMsaa(): void {
        this.msaaTexture?.destroy();
        this.msaaTexture = null;
    }

    /** Reset all per-frame bookkeeping (also after a device rebuild). */
    private resetFrameState(): void {
        this.instances.reset();
        this.batches.reset();
        this.instanceBase = 0;
        this.instanceUploaded = 0;
        this.spriteEncoded = false;
        this.lastFrameInstances = 0;
        this.vectorVertices = 0;
        this.vectorBase = 0;
        this.vectorUploaded = 0;
        this.vectorEncoded = false;
        this.lastFrameVectorVertices = 0;
        this.layer = null;
        this.pass = null;
        this.encoder = null;
        this.totals = { drawCalls: 0, instances: 0, triangles: 0 };
    }

    public async recover(): Promise<boolean> {
        if (this.disposed) return false;
        if (!this.lost) return true;
        const gpu = globalThis.navigator?.gpu;
        if (!gpu) return false;
        const adapter = await gpu.requestAdapter().catch(() => null);
        if (!adapter) return false;
        const device = await adapter.requestDevice().catch(() => null);
        if (!device) return false;

        this.device.destroy();
        this.device = device;
        device.pushErrorScope("validation");
        try {
            this.buildResources();
            this.configureContext();
        } catch {
            device.destroy();
            return false;
        }
        let failed = false;
        let error: GPUError | null = null;
        try {
            error = await device.popErrorScope();
        } catch {
            failed = true;
        }
        if (failed || error) {
            device.destroy();
            return false;
        }

        this.watchLost(device);
        for (const texture of this.textures) {
            texture.texture = this.createGpuTexture(texture.width, texture.height);
            texture.sampler = this.samplerFor(texture.source.options);
            texture.bindGroup = null;
            this.uploadTexture(texture);
        }
        this.resetFrameState();
        this.lost = false;
        return true;
    }

    /* ---------------- frame ---------------- */

    public beginFrame(clearColor: Color | undefined, projection: Mat3): void {
        if (this.lost) return;
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
        // Size buffers for this frame while nothing references them; a frame that outgrows the
        // previous one rotates to a fresh buffer mid-frame.
        this.reserveInstanceCapacity(this.lastFrameInstances);
        this.reserveVectorCapacity(this.lastFrameVectorVertices);

        // mat3x3 in WGSL is column-major with a 16-byte column stride
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
        const clearValue = { r: c.r / 255, g: c.g / 255, b: c.b / 255, a: c.a / 255 };
        const context = this.context;
        if (!context) return;
        const current = context.getCurrentTexture();
        this.encoder = this.device.createCommandEncoder();
        const colorAttachment: GPURenderPassColorAttachment = this.antialias
            ? {
                  view: this.ensureMsaa(current.width, current.height).createView(),
                  resolveTarget: current.createView(),
                  clearValue,
                  loadOp: "clear",
                  storeOp: "discard",
              }
            : {
                  view: current.createView(),
                  clearValue,
                  loadOp: "clear",
                  storeOp: "store",
              };
        this.pass = this.encoder.beginRenderPass({ colorAttachments: [colorAttachment] });
    }

    public endFrame(): void {
        if (this.lost) return;
        if (this.layer === "vector") this.flushVectors();
        if (this.layer === "sprite") this.flushSprites();
        this.layer = null;
        this.pass?.end();
        this.pass = null;
        if (this.encoder) {
            this.device.queue.submit([this.encoder.finish()]);
            this.encoder = null;
        }
        // The submit keeps replaced buffers alive until the GPU is done with them.
        for (const buffer of this.retiredBuffers) buffer.destroy();
        this.retiredBuffers.length = 0;
        this.lastFrameInstances = this.instances.count;
        this.lastFrameVectorVertices = this.vectorVertices;
    }

    /* ---------------- frame-wide buffers ---------------- */

    /**
     * Grow the sprite instance buffer before the frame starts. Mid-frame, when earlier draws
     * already reference the buffer, `flushSprites` rotates to a new one instead.
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

    /** Start a fresh instance buffer for the not-yet-uploaded data; earlier draws keep the old one. */
    private rotateInstanceBuffer(): void {
        const needed = this.instances.count - this.instanceUploaded;
        let cap = Math.max(1024, this.instanceCapacity);
        while (cap < needed) cap *= 2;
        this.retiredBuffers.push(this.instanceBuffer);
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
        this.retiredBuffers.push(this.vectorBuffer);
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
                        { binding: 1, resource: tex.sampler },
                        { binding: 2, resource: tex.texture.createView() },
                    ],
                });
            }
            this.pass!.setPipeline(tex.premultiplied ? this.spritePipelines.premultiplied : this.spritePipelines.straight);
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
        const count = this.vectorVertices - first;
        this.pass!.draw(count, 1, first - this.vectorBase);
        this.totals.drawCalls++;
        this.totals.triangles += count / 3;
        this.vectorUploaded = this.vectorVertices;
        this.vectorEncoded = true;
    }

    /* ---------------- textures ---------------- */

    private createGpuTexture(width: number, height: number): GPUTexture {
        return this.device.createTexture({
            size: [width, height],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }

    /** `flipY` matches the GL backend's UNPACK_FLIP_Y, so atlas UVs are identical on both. */
    private uploadTexture(texture: GpuTexture): void {
        this.device.queue.copyExternalImageToTexture(
            { source: texture.source.image as CanvasImageSource, flipY: true },
            { texture: texture.texture, premultipliedAlpha: texture.premultiplied },
            [texture.source.width, texture.source.height],
        );
    }

    public createTexture(
        image: TexImageSource,
        width: number,
        height: number,
        options: TextureOptions = {},
    ): RenderTexture {
        if (this.disposed) throw new Error("[renderer] device has been disposed");
        if (this.lost) throw new Error("[renderer] device is lost");
        assertTextureSize(image, width, height);
        const texture = new GpuTexture(this.createGpuTexture(width, height), this.samplerFor(options), {
            image,
            width,
            height,
            options,
        });
        this.textures.add(texture);
        this.uploadTexture(texture);
        return texture;
    }

    public updateTexture(
        texture: RenderTexture,
        image: TexImageSource,
        width: number,
        height: number,
        options?: TextureOptions,
    ): void {
        const owned = this.ownedTexture(texture);
        if (this.lost) throw new Error("[renderer] device is lost");
        assertTextureSize(image, width, height);
        const opts = options ?? owned.source.options;
        owned.texture.destroy();
        owned.texture = this.createGpuTexture(width, height);
        owned.source = { image, width, height, options: opts };
        owned.width = width;
        owned.height = height;
        owned.premultiplied = opts.premultiplyAlpha === true;
        owned.sampler = this.samplerFor(opts);
        owned.bindGroup = null;
        this.uploadTexture(owned);
    }

    public disposeTexture(texture: RenderTexture): void {
        const owned = this.ownedTexture(texture);
        this.textures.delete(owned);
        owned.bindGroup = null;
        owned.texture.destroy();
    }

    private ownedTexture(texture: RenderTexture): GpuTexture {
        if (texture.kind !== this.kind) {
            throw new Error(`[renderer] texture belongs to the ${texture.kind} backend, not webgpu`);
        }
        if (!(texture instanceof GpuTexture) || !this.textures.has(texture)) {
            throw new Error("[renderer] texture was not created by this device");
        }
        return texture;
    }

    /** Sampler for a texture-option set; defaults match WebGL's linear + clamp-to-edge. */
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

    /* ---------------- drawing ---------------- */

    public drawSprite(texture: RenderTexture, call: SpriteDrawCall): void {
        if (this.lost) return;
        if (texture.kind !== this.kind) {
            throw new Error(`[renderer] texture belongs to the ${texture.kind} backend, not webgpu`);
        }
        if (this.layer === "vector") this.flushVectors();
        this.layer = "sprite";
        const start = this.instances.count;
        this.instances.push(call);
        this.batches.add(texture as unknown as Batch["texture"], start);
    }

    public addTriangles(points: readonly number[], color: Color | undefined, dx: number, dy: number): void {
        if (this.lost) return;
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
        if (this.lost) return;
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
            const x0n = s.x0 + nx;
            const y0n = s.y0 + ny;
            const x1n = s.x1 + nx;
            const y1n = s.y1 + ny;
            const x0p = s.x0 - nx;
            const y0p = s.y0 - ny;
            const x1p = s.x1 - nx;
            const y1p = s.y1 - ny;
            // two triangles per segment
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
        for (const texture of this.textures) texture.texture.destroy();
        this.textures.clear();
        this.releaseMsaa();
        this.instanceBuffer.destroy();
        this.vectorBuffer.destroy();
        for (const buffer of this.retiredBuffers) buffer.destroy();
        this.retiredBuffers = [];
        this.projBuffer.destroy();
        this.device.destroy();
    }
}
