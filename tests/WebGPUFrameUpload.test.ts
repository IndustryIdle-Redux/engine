/**
 * WebGPU device tests with a recording fake device.
 *
 * Covered: per-frame upload ranges (each draw must read data written by its own flush),
 * instance buffer rotation past the initial capacity, premultiplied/MSAA pipeline selection,
 * texture create/update/dispose, `create()` validation-scope fallback behaviour and device
 * loss/recovery.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Mat3 } from "../src/Mat3";
import { Color } from "../src/Color";
import { FLOATS_PER_INSTANCE } from "../src/InstanceBuffer";
import { WebGPUDevice, type WebGPUDeviceOptions } from "../src/renderer/WebGPUDevice";
import type { RenderTexture } from "../src/renderer/RenderDevice";
import type { SpriteDrawCall } from "../src/InstanceBuffer";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Fake WebGPU device
 * ------------------------------------------------------------------ */

interface FakeBuffer {
    size: number;
    usage: number;
    destroyed: boolean;
    destroyedAtSubmit: number;
    destroy(): void;
}

interface FakePipeline {
    id: number;
    stepMode: "instance" | "vertex";
    premultiplied: boolean;
}

interface FakeTexture {
    desc: { size?: number[]; sampleCount?: number };
    destroyed: boolean;
    createView(): object;
    destroy(): void;
}

interface Op {
    kind: "write" | "draw";
    buffer: FakeBuffer;
    offset: number;
    size: number;
    seq: number;
    label: string;
    pipeline: FakePipeline | null;
}

interface SamplerDesc {
    magFilter: string;
    minFilter: string;
    addressModeU: string;
    addressModeV: string;
}

class FakeGpu {
    public readonly ops: Op[] = [];
    public readonly samplers: SamplerDesc[] = [];
    public readonly copies: Array<{ premultipliedAlpha: boolean | undefined }> = [];
    public readonly pipelines: FakePipeline[] = [];
    /** raw createRenderPipeline descriptors, in creation order */
    public readonly pipelineDescs: Array<Record<string, unknown>> = [];
    public readonly buffers: FakeBuffer[] = [];
    public readonly textures: FakeTexture[] = [];
    public readonly passDescs: Array<Record<string, unknown>> = [];
    public readonly configured: Array<{ alphaMode?: string }> = [];
    public submitted = 0;
    public pushedScopes = 0;
    public deviceDestroyed = 0;
    /** results returned by successive `popErrorScope` calls */
    public errorResults: Array<object | null> = [];
    public lost = false;
    private lostResolve: (() => void) | null = null;
    private readonly lostPromise = new Promise<void>((resolve) => {
        this.lostResolve = resolve;
    });
    private seq = 0;
    /** op index of the most recent submission */
    private lastSubmitOp = -1;
    private pending: { buffer: FakeBuffer; offset: number; size: number | null } | null = null;
    private pipeline: FakePipeline | null = null;

    public loseDevice(): void {
        this.lost = true;
        this.lostResolve?.();
    }

    public readonly queue = {
        writeBuffer: (
            buffer: FakeBuffer,
            bufferOffset: number,
            _data: ArrayBufferView,
            _dataOffset?: number,
            size?: number,
        ): void => {
            this.ops.push({
                kind: "write",
                buffer,
                offset: bufferOffset,
                size: size ?? 0,
                seq: this.seq++,
                label: "writeBuffer",
                pipeline: null,
            });
        },
        submit: (): void => {
            this.submitted++;
            this.lastSubmitOp = this.ops.length;
        },
        copyExternalImageToTexture: (_src: unknown, dst: { premultipliedAlpha?: boolean }): void => {
            this.copies.push({ premultipliedAlpha: dst.premultipliedAlpha });
        },
    };

    public readonly device = {
        queue: this.queue,
        lost: this.lostPromise,
        pushErrorScope: (): void => {
            this.pushedScopes++;
        },
        popErrorScope: (): Promise<object | null> => Promise.resolve(this.errorResults.shift() ?? null),
        createBuffer: (desc: { size: number; usage?: number }): FakeBuffer => {
            const self = this;
            const buffer: FakeBuffer = {
                size: desc.size,
                usage: desc.usage ?? 0,
                destroyed: false,
                destroyedAtSubmit: -1,
                destroy(): void {
                    buffer.destroyed = true;
                    buffer.destroyedAtSubmit = self.submitted;
                },
            };
            this.buffers.push(buffer);
            return buffer;
        },
        createSampler: (desc: SamplerDesc): object => {
            this.samplers.push(desc);
            return { desc };
        },
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createShaderModule: (desc: { code: string }) => ({ code: desc.code }),
        createRenderPipeline: (desc: Record<string, unknown>): FakePipeline => {
            const vertex = (desc as unknown as { vertex: { buffers?: Array<{ stepMode?: string }> } }).vertex;
            const fragment = (desc as unknown as {
                fragment: { targets?: Array<{ blend?: { color?: { srcFactor?: string } } }> };
            }).fragment;
            const pipeline: FakePipeline = {
                id: this.pipelines.length,
                stepMode: vertex.buffers?.[0]?.stepMode === "instance" ? "instance" : "vertex",
                premultiplied: fragment.targets?.[0]?.blend?.color?.srcFactor === "one",
            };
            this.pipelines.push(pipeline);
            this.pipelineDescs.push(desc);
            return pipeline;
        },
        createBindGroup: () => ({}),
        createTexture: (desc: { size?: number[]; sampleCount?: number }): FakeTexture => {
            const texture: FakeTexture = {
                desc,
                destroyed: false,
                createView: () => ({}),
                destroy(): void {
                    texture.destroyed = true;
                },
            };
            this.textures.push(texture);
            return texture;
        },
        createCommandEncoder: () => ({
            beginRenderPass: (desc: Record<string, unknown>) => {
                this.passDescs.push(desc);
                return this.pass;
            },
            finish: () => ({}),
        }),
        destroy: (): void => {
            this.deviceDestroyed++;
        },
    };

    public readonly pass = {
        setPipeline: (pipeline: FakePipeline): void => {
            this.pipeline = pipeline;
        },
        setBindGroup: (): void => {},
        setVertexBuffer: (_slot: number, buffer: FakeBuffer, offset = 0, size?: number): void => {
            this.pending = { buffer, offset, size: size ?? null };
        },
        /** records the byte range the draw actually reads, so uploads can be checked against it */
        draw: (vertexCount: number, instanceCount = 1, firstVertex = 0): void => {
            const p = this.pending;
            if (!p) throw new Error("draw without setVertexBuffer");
            const vector = this.pipeline?.stepMode === "vertex";
            const stride = vector ? 6 * 4 : FLOATS_PER_INSTANCE * 4;
            const offset = p.offset + (vector ? firstVertex * stride : 0);
            const size = vector
                ? vertexCount * stride
                : (p.size ?? instanceCount * FLOATS_PER_INSTANCE * 4);
            this.ops.push({
                kind: "draw",
                buffer: p.buffer,
                offset,
                size,
                seq: this.seq++,
                label: vector ? `draw(vectorVertices=${vertexCount})` : `draw(instances=${instanceCount})`,
                pipeline: this.pipeline,
            });
        },
        end: (): void => {},
    };

    public currentFrameOps(): Op[] {
        return this.ops.slice(this.lastSubmitOp);
    }
}

/* ------------------------------------------------------------------ *
 * Globals the WebGPU device touches
 * ------------------------------------------------------------------ */

const g = globalThis as unknown as Record<string, unknown>;
g.GPUBufferUsage = { VERTEX: 1, COPY_DST: 2, UNIFORM: 4, INDEX: 8 };
g.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };

interface FakeContext {
    configureCalls: number;
    lastConfig?: { alphaMode?: string };
    getCurrentTexture(): { width: number; height: number; createView(): object };
    configure(config: { alphaMode?: string }): void;
}

function makeContext(): FakeContext {
    const context: FakeContext = {
        configureCalls: 0,
        getCurrentTexture: () => ({ width: 64, height: 64, createView: () => ({}) }),
        configure: (config): void => {
            context.configureCalls++;
            context.lastConfig = config;
        },
    };
    return context;
}

function makeDevice(options: WebGPUDeviceOptions = {}): {
    fake: FakeGpu;
    device: WebGPUDevice;
    context: FakeContext;
} {
    const fake = new FakeGpu();
    const context = makeContext();
    const ctor = WebGPUDevice as unknown as new (
        d: unknown,
        c: unknown,
        f: string,
        o?: WebGPUDeviceOptions,
    ) => WebGPUDevice;
    return { fake, device: new ctor(fake.device, context, "bgra8unorm", options), context };
}

const texture = (premultiplied = false): RenderTexture =>
    ({
        kind: "webgpu",
        width: 1024,
        height: 2048,
        premultiplied,
        bindGroup: null,
        texture: { createView: () => ({}) },
        sampler: {},
    }) as unknown as RenderTexture;

const sprite = (x: number, y: number): SpriteDrawCall => ({
    x,
    y,
    w: 20,
    h: 20,
    u0: 0,
    v0: 0,
    du: 0.1,
    dv: 0.1,
    color: Color.WHITE,
});

describe("WebGPUDevice per-frame uploads", () => {
    it("every draw reads data written by its own flush (disjoint ranges, later writes do not win)", () => {
        const { fake, device } = makeDevice();
        const atlas = texture();
        const font = texture();

        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());

        for (let i = 0; i < 40; i++) device.drawSprite(atlas, sprite(i, i));
        device.addTriangles([0, 0, 10, 0, 0, 10], Color.WHITE, 0, 0);
        for (let i = 0; i < 25; i++) device.drawSprite(atlas, sprite(i * 2, i * 2));
        device.addSegments([{ x0: 0, y0: 0, x1: 5, y1: 5 }], 1, Color.WHITE);
        for (let i = 0; i < 10; i++) device.drawSprite(font, sprite(i, i));
        device.addTriangles([1, 1, 2, 1, 1, 2], Color.WHITE, 0, 0);

        device.endFrame();

        const ops = fake.ops;
        expect(ops.filter((o) => o.kind === "draw").length).toBeGreaterThan(3);

        for (const draw of ops.filter((o) => o.kind === "draw")) {
            expect(draw.size).toBeGreaterThan(0);
            const covering = ops.filter(
                (o) =>
                    o.kind === "write" &&
                    o.buffer === draw.buffer &&
                    o.offset <= draw.offset &&
                    o.offset + o.size >= draw.offset + draw.size,
            );
            expect(covering.length, `no upload covers ${draw.label} @${draw.offset}+${draw.size}`).toBeGreaterThan(0);
            const winner = covering[covering.length - 1] as Op;
            expect(
                winner.seq < draw.seq,
                `${draw.label} would read data uploaded after it was encoded`,
            ).toBe(true);
        }

        const writes = ops.filter((o) => o.kind === "write");
        for (let i = 0; i < writes.length; i++) {
            for (let j = i + 1; j < writes.length; j++) {
                const a = writes[i] as Op;
                const b = writes[j] as Op;
                if (a.buffer !== b.buffer) continue;
                const overlap = a.offset < b.offset + b.size && b.offset < a.offset + a.size;
                expect(overlap, `uploads overlap: [${a.offset},${a.offset + a.size})`).toBe(false);
            }
        }
    });

    it("uploads stay frame-scoped: the next frame starts at offset 0 again", () => {
        const { fake, device } = makeDevice();
        const atlas = texture();

        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        for (let i = 0; i < 30; i++) device.drawSprite(atlas, sprite(i, i));
        device.addTriangles([0, 0, 1, 0, 0, 1], Color.WHITE, 0, 0);
        for (let i = 0; i < 5; i++) device.drawSprite(atlas, sprite(i, i));
        device.endFrame();

        expect(fake.ops.filter((o) => o.kind === "write").length).toBeGreaterThan(0);

        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        const countAfterBegin = fake.ops.length;
        for (let i = 0; i < 30; i++) device.drawSprite(atlas, sprite(i, i));
        device.addTriangles([0, 0, 1, 0, 0, 1], Color.WHITE, 0, 0);
        device.endFrame();

        const secondFrameWrites = fake.ops.slice(countAfterBegin).filter((o) => o.kind === "write");
        expect(secondFrameWrites.length).toBeGreaterThan(0);
        expect(Math.min(...secondFrameWrites.map((w) => w.offset))).toBe(0);
    });

    it("keeps the instance stride consistent with the shared layout", () => {
        const { fake, device } = makeDevice();
        const atlas = texture();
        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        for (let i = 0; i < 3; i++) device.drawSprite(atlas, sprite(i, i));
        device.addTriangles([0, 0, 1, 0, 0, 1], Color.WHITE, 0, 0);
        for (let i = 0; i < 2; i++) device.drawSprite(atlas, sprite(i, i));
        device.endFrame();
        const spriteWrites = fake.ops.filter((o) => o.kind === "write" && o.size % (FLOATS_PER_INSTANCE * 4) === 0);
        expect(spriteWrites.length).toBe(2);
        expect((spriteWrites[0] as Op).offset).toBe(0);
        expect((spriteWrites[1] as Op).offset).toBe(3 * FLOATS_PER_INSTANCE * 4);
    });

    it("rotates the instance buffer past its capacity and destroys moved-away buffers after submit", () => {
        const { fake, device } = makeDevice({ antialias: false });
        const atlas = texture();
        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        for (let round = 0; round < 3; round++) {
            for (let i = 0; i < 600; i++) device.drawSprite(atlas, sprite(i, i));
            device.addTriangles([0, 0, 1, 0, 0, 1], Color.WHITE, 0, 0);
        }
        device.endFrame();

        const instanceBuffers = fake.buffers.filter((b) => (b.usage & 1) !== 0);
        expect(instanceBuffers.length).toBeGreaterThan(2);
        const destroyed = instanceBuffers.filter((b) => b.destroyed);
        expect(destroyed.length).toBeGreaterThanOrEqual(2);
        for (const buffer of destroyed) expect(buffer.destroyedAtSubmit).toBe(1);
        expect(fake.submitted).toBe(1);
        // the last buffer of the frame is still live
        const live = instanceBuffers.filter((b) => !b.destroyed);
        expect(live.length).toBeGreaterThanOrEqual(1);
    });
});

/* ------------------------------------------------------------------ *
 * Textures and pipelines
 * ------------------------------------------------------------------ */

describe("WebGPUDevice textures", () => {
    const image = {} as unknown as TexImageSource;

    it("defaults to linear + clamp-to-edge (like the WebGL2 backend)", () => {
        const { fake, device } = makeDevice();
        const before = fake.samplers.length;
        const tex = device.createTexture(image, 4, 4);
        expect(fake.samplers.length).toBe(before);
        expect((tex as unknown as { sampler: object }).sampler).toBeDefined();
    });

    it("maps NEAREST / REPEAT / premultiply-alpha onto the sampler and the copy", () => {
        const { fake, device } = makeDevice();
        device.createTexture(image, 8, 8, { linear: false, wrap: true, premultiplyAlpha: true });
        const desc = fake.samplers[fake.samplers.length - 1] as SamplerDesc;
        expect(desc.magFilter).toBe("nearest");
        expect(desc.minFilter).toBe("nearest");
        expect(desc.addressModeU).toBe("repeat");
        expect(desc.addressModeV).toBe("repeat");
        expect(fake.copies[fake.copies.length - 1]?.premultipliedAlpha).toBe(true);
    });

    it("caches samplers per filter/address combination", () => {
        const { fake, device } = makeDevice();
        const nearest = device.createTexture(image, 1, 1, { linear: false }) as unknown as { sampler: object };
        const nearest2 = device.createTexture(image, 1, 1, { linear: false }) as unknown as { sampler: object };
        const linear = device.createTexture(image, 1, 1) as unknown as { sampler: object };
        expect(nearest.sampler).toBe(nearest2.sampler);
        expect(nearest.sampler).not.toBe(linear.sampler);
        expect(fake.samplers.length).toBe(2);
    });

    it("updates in place and disposes", () => {
        const { fake, device } = makeDevice();
        const texture = device.createTexture(image, 2, 2) as unknown as {
            width: number;
            height: number;
            texture: FakeTexture;
        };
        const oldGpu = texture.texture;
        const copiesBefore = fake.copies.length;
        device.updateTexture(texture as unknown as RenderTexture, image, 4, 4);
        expect(texture.width).toBe(4);
        expect(texture.height).toBe(4);
        expect(oldGpu.destroyed).toBe(true);
        expect(fake.copies.length).toBe(copiesBefore + 1);

        device.disposeTexture(texture as unknown as RenderTexture);
        expect(texture.texture.destroyed).toBe(true);
        expect(() => device.disposeTexture(texture as unknown as RenderTexture)).toThrow(/not created by this device/);
    });

    it("rejects a mismatched declared size and a texture from the other backend", () => {
        const { device } = makeDevice();
        expect(() => device.createTexture({ width: 2, height: 2 } as unknown as TexImageSource, 3, 3)).toThrow(
            /does not match/,
        );
        const foreign = { kind: "webgl2", width: 1, height: 1, premultiplied: false } as RenderTexture;
        expect(() => device.drawSprite(foreign, sprite(0, 0))).toThrow(/webgl2 backend/);
    });

    it("selects the pipeline matching the texture's premultiplied flag", () => {
        const { fake, device } = makeDevice({ antialias: false });
        const straight = texture();
        const premultiplied = texture(true);
        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        device.drawSprite(straight, sprite(0, 0));
        device.drawSprite(premultiplied, sprite(1, 1));
        device.endFrame();

        const draws = fake.ops.filter((o) => o.kind === "draw");
        expect(draws.length).toBe(2);
        expect(draws[0]?.pipeline?.stepMode).toBe("instance");
        expect(draws[0]?.pipeline?.premultiplied).toBe(false);
        expect(draws[1]?.pipeline?.premultiplied).toBe(true);
    });
});

/* ------------------------------------------------------------------ *
 * alpha / antialias
 * ------------------------------------------------------------------ */

describe("WebGPUDevice options", () => {
    it("honours alpha in the canvas configuration", () => {
        const opaque = makeDevice();
        expect(opaque.context.lastConfig?.alphaMode).toBe("opaque");
        const alpha = makeDevice({ alpha: true });
        expect(alpha.context.lastConfig?.alphaMode).toBe("premultiplied");
    });

    it("uses 4x MSAA with a resolve target by default", () => {
        const { fake, device } = makeDevice();
        expect(fake.pipelines.length).toBeGreaterThan(0);
        for (const desc of fake.pipelineDescs) {
            expect((desc as unknown as { multisample: { count: number } }).multisample.count).toBe(4);
        }
        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        const attachment = (fake.passDescs[0] as unknown as {
            colorAttachments: Array<{ resolveTarget?: object; storeOp?: string }>;
        }).colorAttachments[0];
        expect(attachment?.resolveTarget).toBeDefined();
        expect(attachment?.storeOp).toBe("discard");
        device.endFrame();
    });

    it("disables MSAA when antialias is false", () => {
        const { fake, device } = makeDevice({ antialias: false });
        for (const desc of fake.pipelineDescs) {
            expect((desc as unknown as { multisample: { count: number } }).multisample.count).toBe(1);
        }
        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        const attachment = (fake.passDescs[0] as unknown as {
            colorAttachments: Array<{ resolveTarget?: object; storeOp?: string }>;
        }).colorAttachments[0];
        expect(attachment?.resolveTarget).toBeUndefined();
        expect(attachment?.storeOp).toBe("store");
        device.endFrame();
    });
});

/* ------------------------------------------------------------------ *
 * create() and device loss
 * ------------------------------------------------------------------ */

function makeCanvas(getContext: (type: string) => unknown): HTMLCanvasElement {
    return { getContext } as unknown as HTMLCanvasElement;
}

function stubGpu(device: FakeGpu): void {
    vi.stubGlobal("navigator", {
        gpu: {
            requestAdapter: async () => ({ requestDevice: async () => device.device }),
            getPreferredCanvasFormat: () => "bgra8unorm",
        },
    });
}

describe("WebGPUDevice.create", () => {
    it("returns a device and only then binds the canvas context", async () => {
        const fake = new FakeGpu();
        stubGpu(fake);
        const context = makeContext();
        const getContext = vi.fn(() => context);
        const created = await WebGPUDevice.create(makeCanvas(getContext), { antialias: false });
        expect(created).not.toBeNull();
        expect(getContext).toHaveBeenCalledWith("webgpu");
        expect(fake.deviceDestroyed).toBe(0);
        created?.dispose();
    });

    it("returns null and leaves the canvas untouched on a validation error", async () => {
        const fake = new FakeGpu();
        fake.errorResults.push({ message: "invalid pipeline" });
        stubGpu(fake);
        const getContext = vi.fn(() => makeContext());
        const created = await WebGPUDevice.create(makeCanvas(getContext), { antialias: false });
        expect(created).toBeNull();
        expect(getContext).not.toHaveBeenCalled();
        expect(fake.deviceDestroyed).toBe(1);
    });

    it("returns null when the canvas cannot provide a WebGPU context", async () => {
        const fake = new FakeGpu();
        stubGpu(fake);
        const created = await WebGPUDevice.create(makeCanvas(() => null));
        expect(created).toBeNull();
        expect(fake.deviceDestroyed).toBe(1);
    });
});

describe("WebGPUDevice loss and recovery", () => {
    it("reports loss once and ignores rendering while lost", async () => {
        const { fake, device } = makeDevice();
        let lostCalls = 0;
        device.onLost = () => lostCalls++;
        fake.loseDevice();
        await Promise.resolve();
        expect(device.isLost).toBe(true);
        expect(lostCalls).toBe(1);

        const ops = fake.ops.length;
        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        device.drawSprite(texture(), sprite(0, 0));
        device.endFrame();
        expect(fake.ops.length).toBe(ops);
        expect(() => device.createTexture({} as TexImageSource, 1, 1)).toThrow(/lost/);
    });

    it("does not report loss after dispose", async () => {
        const { fake, device } = makeDevice();
        let lostCalls = 0;
        device.onLost = () => lostCalls++;
        device.dispose();
        fake.loseDevice();
        await Promise.resolve();
        expect(lostCalls).toBe(0);
        expect(device.isLost).toBe(false);
    });

    it("recover() re-acquires the device, rebuilds pipelines and re-uploads textures", async () => {
        const { fake, device, context } = makeDevice({ antialias: false });
        device.createTexture({} as TexImageSource, 4, 4);
        fake.loseDevice();
        await Promise.resolve();
        expect(device.isLost).toBe(true);

        const replacement = new FakeGpu();
        stubGpu(replacement);
        expect(await device.recover()).toBe(true);
        expect(device.isLost).toBe(false);
        expect(replacement.pipelines.length).toBe(fake.pipelines.length);
        expect(replacement.copies.length).toBe(1);
        expect(context.configureCalls).toBe(2);
        expect(await device.recover()).toBe(true);
    });

    it("recover() returns false when the replacement device fails validation", async () => {
        const { fake, device } = makeDevice({ antialias: false });
        fake.loseDevice();
        await Promise.resolve();
        const replacement = new FakeGpu();
        replacement.errorResults.push({ message: "invalid pipeline" });
        stubGpu(replacement);
        expect(await device.recover()).toBe(false);
        expect(replacement.deviceDestroyed).toBe(1);
    });
});
