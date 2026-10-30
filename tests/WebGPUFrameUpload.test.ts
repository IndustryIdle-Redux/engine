/**
 * WebGPU per-frame upload regression test.
 *
 * Background (the bug this locks down): `WebGPUDevice` used to upload the frame's instance/vertex
 * data with one `queue.writeBuffer(buffer, 0, ...)` **per flush**, reusing the same GPU buffer.
 * `queue.writeBuffer` is not a draw-time upload — every write enqueued before a submit is applied
 * *before* that submit's commands run — so all draws of the frame read the **last** write:
 * the earlier flushes (deposits + buildings + rings) were rendered from the later flush's data
 * (the transport-dot instances), i.e. the buildings silently vanished and came back frame by frame
 * (reported as "factories twitch when the resource-transport particles are on").
 *
 * The invariant asserted here is exactly the one the GPU must satisfy:
 * for every encoded draw, the **last** write covering the range the draw reads must have been
 * enqueued *before* that draw was encoded (i.e. by the same flush). A frame-wide staging buffer
 * with disjoint per-flush ranges satisfies it; overwriting offset 0 per flush does not.
 */

import { describe, expect, it } from "vitest";
import { Mat3 } from "../src/Mat3";
import { Color } from "../src/Color";
import { FLOATS_PER_INSTANCE } from "../src/InstanceBuffer";
import { WebGPUDevice } from "../src/renderer/WebGPUDevice";
import type { RenderTexture } from "../src/renderer/RenderDevice";
import type { SpriteDrawCall } from "../src/InstanceBuffer";

/* ------------------------------------------------------------------ *
 * Minimal fake WebGPU device (records the queue/encoder operations)
 * ------------------------------------------------------------------ */

interface FakeBuffer {
    size: number;
    destroyed: boolean;
    destroy(): void;
}

interface Op {
    kind: "write" | "draw";
    buffer: FakeBuffer;
    offset: number;
    size: number;
    seq: number;
    label: string;
}

interface SamplerDesc {
    magFilter: string;
    minFilter: string;
    addressModeU: string;
    addressModeV: string;
}

class FakeGpu {
    public readonly ops: Op[] = [];
    /** `createSampler` descriptors, in creation order */
    public readonly samplers: SamplerDesc[] = [];
    /** `copyExternalImageToTexture` destination descriptors (records `premultipliedAlpha`) */
    public readonly copies: Array<{ premultipliedAlpha: boolean | undefined }> = [];
    public submitted = 0;
    private seq = 0;
    /** op index of the most recent submission — writes after it belong to the next frame */
    private lastSubmitOp = -1;

    public readonly queue = {
        writeBuffer: (
            buffer: FakeBuffer,
            bufferOffset: number,
            _data: ArrayBufferView,
            _dataOffset?: number,
            size?: number,
        ): void => {
            this.ops.push({ kind: "write", buffer, offset: bufferOffset, size: size ?? 0, seq: this.seq++, label: "writeBuffer" });
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
        createBuffer: (desc: { size: number }): FakeBuffer => {
            const buffer: FakeBuffer = {
                size: desc.size,
                destroyed: false,
                destroy(): void {
                    buffer.destroyed = true;
                },
            };
            return buffer;
        },
        createSampler: (desc: SamplerDesc): object => {
            this.samplers.push(desc);
            return { desc };
        },
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createShaderModule: () => ({}),
        // creation order: sprite pipeline first, vector pipeline second (see the constructor)
        createRenderPipeline: () => {
            const pipeline = { id: this.pipelines.length, kind: this.pipelines.length === 0 ? "sprite" : "vector" };
            this.pipelines.push(pipeline);
            return pipeline;
        },
        createBindGroup: () => ({}),
        createTexture: () => ({}),
        createCommandEncoder: () => ({
            beginRenderPass: () => this.pass,
            finish: () => ({}),
        }),
        destroy: (): void => {},
    };

    public readonly pipelines: Array<{ id: number; kind: string }> = [];
    /** bytes per element of the vector layout (x, y, r, g, b, a) */
    private static readonly VECTOR_STRIDE = 6 * 4;
    private static readonly INSTANCE_STRIDE = FLOATS_PER_INSTANCE * 4;

    public readonly pass = {
        setPipeline: (pipeline: { kind: string }): void => {
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
            const vector = this.pipeline?.kind === "vector";
            const offset = p.offset + (vector ? firstVertex * FakeGpu.VECTOR_STRIDE : 0);
            const size = vector
                ? vertexCount * FakeGpu.VECTOR_STRIDE
                : (p.size ?? instanceCount * FakeGpu.INSTANCE_STRIDE);
            this.ops.push({
                kind: "draw",
                buffer: p.buffer,
                offset,
                size,
                seq: this.seq++,
                label: vector ? `draw(vectorVertices=${vertexCount})` : `draw(instances=${instanceCount})`,
            });
        },
        end: (): void => {},
    };
    private pending: { buffer: FakeBuffer; offset: number; size: number | null } | null = null;
    private pipeline: { kind: string } | null = null;

    /** ops of the frame that is currently open (after the last submit) */
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

function makeDevice(): { fake: FakeGpu; device: WebGPUDevice } {
    const fake = new FakeGpu();
    const context = {
        getCurrentTexture: () => ({ createView: () => ({}) }),
        configure: () => {},
    };
    const ctor = WebGPUDevice as unknown as new (d: unknown, c: unknown, f: string) => WebGPUDevice;
    return { fake, device: new ctor(fake.device, context, "bgra8unorm") };
}

const texture = (): RenderTexture =>
    ({ width: 1024, height: 2048, bindGroup: null, texture: { createView: () => ({}) } }) as unknown as RenderTexture;

const sprite = (x: number, y: number): SpriteDrawCall => ({ x, y, w: 20, h: 20, u0: 0, v0: 0, du: 0.1, dv: 0.1, color: Color.WHITE });

describe("WebGPUDevice per-frame uploads", () => {
    it("every draw reads data written by its own flush (disjoint ranges, later writes do not win)", () => {
        const { fake, device } = makeDevice();
        const atlas = texture();
        const font = texture();

        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());

        // flush 1: a few sprites (deposits + buildings + rings)
        for (let i = 0; i < 40; i++) device.drawSprite(atlas, sprite(i, i));
        // a vector draw switches the layer -> flush 1 is encoded here
        device.addTriangles([0, 0, 10, 0, 0, 10], Color.WHITE, 0, 0);
        // flush 2: the transport dots (this is what used to overwrite flush 1's data)
        for (let i = 0; i < 25; i++) device.drawSprite(atlas, sprite(i * 2, i * 2));
        device.addSegments([{ x0: 0, y0: 0, x1: 5, y1: 5 }], 1, Color.WHITE);
        // flush 3: text (a second texture)
        for (let i = 0; i < 10; i++) device.drawSprite(font, sprite(i, i));
        device.addTriangles([1, 1, 2, 1, 1, 2], Color.WHITE, 0, 0);

        device.endFrame();

        const ops = fake.ops;
        expect(ops.filter((o) => o.kind === "draw").length).toBeGreaterThan(3);

        for (const draw of ops.filter((o) => o.kind === "draw")) {
            expect(draw.size).toBeGreaterThan(0);
            // the upload that supplies this draw: the LAST write covering its range before the draw
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
                `${draw.label} @${draw.offset}+${draw.size} would read data uploaded AFTER it was encoded ` +
                    `(write @${winner.offset}+${winner.size} seq=${winner.seq} > draw seq=${draw.seq})`,
            ).toBe(true);
        }

        // and the frame's upload ranges must not overlap each other
        const writes = ops.filter((o) => o.kind === "write");
        for (let i = 0; i < writes.length; i++) {
            for (let j = i + 1; j < writes.length; j++) {
                const a = writes[i] as Op;
                const b = writes[j] as Op;
                if (a.buffer !== b.buffer) continue;
                const overlap = a.offset < b.offset + b.size && b.offset < a.offset + a.size;
                expect(overlap, `uploads overlap: [${a.offset},${a.offset + a.size}) and [${b.offset},${b.offset + b.size})`).toBe(
                    false,
                );
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

        const firstFrameWrites = fake.ops.filter((o) => o.kind === "write");
        expect(firstFrameWrites.length).toBeGreaterThan(0);

        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        const countAfterBegin = fake.ops.length;
        for (let i = 0; i < 30; i++) device.drawSprite(atlas, sprite(i, i));
        device.addTriangles([0, 0, 1, 0, 0, 1], Color.WHITE, 0, 0);
        device.endFrame();

        const secondFrameWrites = fake.ops.slice(countAfterBegin).filter((o) => o.kind === "write");
        expect(secondFrameWrites.length).toBeGreaterThan(0);
        // the first upload of the second frame lands at offset 0 (a fresh frame range)
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
});

/* ------------------------------------------------------------------ *
 * Texture options parity with the WebGL2 backend
 * ------------------------------------------------------------------ */

describe("WebGPUDevice texture options match the WebGL2 backend", () => {
    const image = {} as unknown as TexImageSource;

    it("defaults to linear + clamp-to-edge (like `Texture.fromImage` with no options)", () => {
        const { fake, device } = makeDevice();
        const before = fake.samplers.length;
        const tex = device.createTexture(image, 4, 4);
        // the default sampler is created once in the constructor and reused
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
        // one default + one nearest sampler only
        expect(fake.samplers.length).toBe(2);
    });
});
