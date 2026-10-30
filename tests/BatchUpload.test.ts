/**
 * WebGL2 device tests with a recording fake context.
 *
 * Covered:
 *  - frame upload bookkeeping (disjoint ranges, no per-flush store allocation)
 *  - the per-batch attribute pointer offset `batch.start * stride`
 *  - texture create/update/dispose and size validation
 *  - context lost/restored: no-op rendering, one `onLost` call and re-upload on restore
 *  - premultiplied blend selection per batch
 */

import { describe, expect, it } from "vitest";
import { Mat3 } from "../src/Mat3";
import { Color } from "../src/Color";
import { FLOATS_PER_INSTANCE, INSTANCE_ATTRIBS } from "../src/InstanceBuffer";
import { WebGL2Device } from "../src/renderer/WebGL2Device";
import { Texture } from "../src/renderer/Texture";
import type { RenderTexture } from "../src/renderer/RenderDevice";

/* ------------------------------------------------------------------ *
 * Recording fake WebGL2 context
 * ------------------------------------------------------------------ */

interface Upload {
    /** id of the GPU buffer the write targeted (sprite and vector batches own separate buffers) */
    buffer: number;
    /** byte offset the data was written at (`bufferData` always writes a fresh store, offset 0) */
    offset: number;
    /** bytes written */
    size: number;
    /** true when only a capacity hint was passed (no payload) */
    sizeHint: boolean;
    seq: number;
}

interface FakeTexture {
    id: number;
}

class FakeGL {
    public readonly uploads: Upload[] = [];
    /** instance counts of `drawArraysInstanced` calls, in order */
    public readonly instanceDraws: number[] = [];
    /** vertex counts of `drawArrays` calls, in order */
    public readonly vertexDraws: number[] = [];
    /** attribute pointer byte offsets, in call order */
    public readonly pointerOffsets: number[] = [];
    /** blend factor pairs, in call order */
    public readonly blendCalls: Array<[number, number]> = [];
    /** textures created by the fake, in order */
    public readonly texturesCreated: FakeTexture[] = [];
    public readonly texturesDeleted: FakeTexture[] = [];
    public texImageCalls = 0;
    public bufferDataCalls = 0;
    public bufferSubDataCalls = 0;
    /** the fake canvas doubles as the context-loss event target */
    public readonly canvas = new EventTarget();
    private seq = 0;
    private nextBufferId = 1;
    private nextTextureId = 1;
    private boundBuffer = 0;

    public readonly TEXTURE0 = 0x84c0;
    public readonly ARRAY_BUFFER = 0x8892;
    public readonly FLOAT = 0x1406;
    public readonly TRIANGLES = 0x0004;
    public readonly VERTEX_SHADER = 0x8b31;
    public readonly FRAGMENT_SHADER = 0x8b30;
    public readonly COMPILE_STATUS = 0x8b81;
    public readonly LINK_STATUS = 0x8b82;
    public readonly DYNAMIC_DRAW = 0x88e8;
    public readonly TEXTURE_2D = 0x0de1;
    public readonly DEPTH_TEST = 0x0b71;
    public readonly BLEND = 0x0be2;
    public readonly SRC_ALPHA = 0x0302;
    public readonly ONE = 0x0001;
    public readonly ONE_MINUS_SRC_ALPHA = 0x0303;
    public readonly COLOR_BUFFER_BIT = 0x4000;
    public readonly RGBA = 0x1908;
    public readonly UNSIGNED_BYTE = 0x1401;
    public readonly NEAREST = 0x2600;
    public readonly LINEAR = 0x2601;
    public readonly REPEAT = 0x2901;
    public readonly CLAMP_TO_EDGE = 0x812f;
    public readonly TEXTURE_MIN_FILTER = 0x2801;
    public readonly TEXTURE_MAG_FILTER = 0x2800;
    public readonly TEXTURE_WRAP_S = 0x2802;
    public readonly TEXTURE_WRAP_T = 0x2803;
    public readonly UNPACK_FLIP_Y_WEBGL = 0x9240;
    public readonly UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;

    public createShader(): object {
        return {};
    }
    public shaderSource(): void {}
    public compileShader(): void {}
    public getShaderParameter(): boolean {
        return true;
    }
    public getShaderInfoLog(): string {
        return "";
    }
    public deleteShader(): void {}
    public createProgram(): object {
        return {};
    }
    public attachShader(): void {}
    public linkProgram(): void {}
    public getProgramParameter(): boolean {
        return true;
    }
    public getProgramInfoLog(): string {
        return "";
    }
    public getUniformLocation(): object {
        return {};
    }
    public createVertexArray(): object {
        return {};
    }
    public createBuffer(): object {
        return { id: this.nextBufferId++ };
    }
    public bindVertexArray(): void {}
    public bindBuffer(_target: number, buffer: { id: number } | null): void {
        this.boundBuffer = buffer ? buffer.id : 0;
    }
    public enableVertexAttribArray(): void {}
    public vertexAttribPointer(_location: number, _size: number, _type: number, _norm: boolean, _stride: number, offset = 0): void {
        this.pointerOffsets.push(offset);
    }
    public vertexAttribDivisor(): void {}
    public useProgram(): void {}
    public uniformMatrix3fv(): void {}
    public uniform1i(): void {}
    public activeTexture(): void {}
    public bindTexture(): void {}
    public createTexture(): FakeTexture {
        const texture = { id: this.nextTextureId++ };
        this.texturesCreated.push(texture);
        return texture;
    }
    public deleteTexture(texture: FakeTexture): void {
        this.texturesDeleted.push(texture);
    }
    public texImage2D(): void {
        this.texImageCalls++;
    }
    public texParameteri(): void {}
    public pixelStorei(): void {}
    public deleteBuffer(): void {}
    public deleteVertexArray(): void {}
    public deleteProgram(): void {}
    public disable(): void {}
    public enable(): void {}
    public blendFunc(src: number, dst: number): void {
        this.blendCalls.push([src, dst]);
    }
    public viewport(): void {}
    public clearColor(): void {}
    public clear(): void {}

    public bufferData(_target: number, dataOrSize: ArrayBufferView | number): void {
        this.bufferDataCalls++;
        const sizeHint = typeof dataOrSize === "number";
        this.uploads.push({
            buffer: this.boundBuffer,
            offset: 0,
            size: sizeHint ? (dataOrSize as number) : (dataOrSize as ArrayBufferView).byteLength,
            sizeHint,
            seq: this.seq++,
        });
    }

    public bufferSubData(_target: number, offset: number, data: ArrayBufferView): void {
        this.bufferSubDataCalls++;
        this.uploads.push({ buffer: this.boundBuffer, offset, size: data.byteLength, sizeHint: false, seq: this.seq++ });
    }

    public drawArraysInstanced(_mode: number, _first: number, _count: number, instances: number): void {
        this.instanceDraws.push(instances);
    }

    public drawArrays(_mode: number, _first: number, _count: number): void {
        this.vertexDraws.push(_count);
    }

    /** payload uploads only (a `bufferData` size hint carries no bytes) */
    public get payloads(): Upload[] {
        return this.uploads.filter((u) => !u.sizeHint);
    }
}

const IMAGE_2X2 = { width: 2, height: 2 } as unknown as TexImageSource;
const ATLAS = { kind: "webgl2", width: 1024, height: 1024, premultiplied: false } as RenderTexture;
const FONT = { kind: "webgl2", width: 512, height: 512, premultiplied: false } as RenderTexture;

function makeDevice(): { gl: FakeGL; device: WebGL2Device } {
    const gl = new FakeGL();
    const device = new WebGL2Device(gl as unknown as WebGL2RenderingContext);
    return { gl, device };
}

/** A frame that alternates layers `flushes` times, with `perFlush` sprites in each sprite chunk */
function runAlternatingFrame(device: WebGL2Device, flushes: number, perFlush: number): void {
    device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
    for (let f = 0; f < flushes; f++) {
        for (let i = 0; i < perFlush; i++) {
            device.drawSprite(ATLAS, { x: i, y: i, w: 8, h: 8, color: Color.WHITE });
        }
        // switch to the vector layer (flushes the sprites), then back on the next round
        device.addTriangles([0, 0, 1, 0, 0, 1], Color.WHITE, 0, 0);
    }
    device.endFrame();
}

/** Assert that no two uploads into the same GPU buffer overlap */
function assertDisjoint(uploads: Upload[]): void {
    for (let i = 0; i < uploads.length; i++) {
        for (let j = i + 1; j < uploads.length; j++) {
            const a = uploads[i] as Upload;
            const b = uploads[j] as Upload;
            if (a.buffer !== b.buffer) continue;
            const overlap = a.offset < b.offset + b.size && b.offset < a.offset + a.size;
            expect(
                overlap,
                `uploads overlap: [${a.offset},${a.offset + a.size}) and [${b.offset},${b.offset + b.size})`,
            ).toBe(false);
        }
    }
}

describe("WebGL2 batch uploads", () => {
    it("a many-flush frame uploads every byte exactly once, at disjoint offsets", () => {
        const { gl, device } = makeDevice();
        runAlternatingFrame(device, 40, 4);

        const expected = 40 * 4 * FLOATS_PER_INSTANCE * 4 + 40 * 3 * 6 * 4;
        const payloads = gl.payloads;
        expect(payloads.reduce((a, u) => a + u.size, 0)).toBe(expected);
        assertDisjoint(payloads);
    });

    it("the number of GPU store allocations does not grow with the flush count", () => {
        const few = makeDevice();
        runAlternatingFrame(few.device, 50, 4);
        const many = makeDevice();
        runAlternatingFrame(many.device, 500, 4);

        expect(many.gl.bufferDataCalls).toBeLessThanOrEqual(few.gl.bufferDataCalls + 4);
        expect(many.gl.bufferDataCalls).toBeLessThanOrEqual(16);
        expect(many.gl.bufferSubDataCalls).toBeGreaterThanOrEqual(500);
    });

    it("begin() restarts the watermark: the second frame uploads at offset 0 again", () => {
        const { gl, device } = makeDevice();
        runAlternatingFrame(device, 3, 2);
        const firstFrame = gl.payloads.length;
        expect(firstFrame).toBeGreaterThan(0);

        runAlternatingFrame(device, 3, 2);
        const secondFrame = gl.payloads.slice(firstFrame);
        expect(secondFrame.length).toBe(firstFrame);
        expect(Math.min(...secondFrame.map((u) => u.offset))).toBe(0);
    });

    it("frame stats are the frame totals, not the last chunk's", () => {
        const { gl, device } = makeDevice();
        runAlternatingFrame(device, 7, 3);
        expect(device.instanceCount).toBe(7 * 3);
        expect(device.drawCalls).toBe(14);
        expect(device.triangleCount).toBe(7 * 1);
        expect(gl.instanceDraws.reduce((a, b) => a + b, 0)).toBe(7 * 3);
    });

    it("second batch's attribute pointers start at batch.start * stride", () => {
        const { gl, device } = makeDevice();
        gl.pointerOffsets.length = 0;
        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        for (let i = 0; i < 2; i++) device.drawSprite(ATLAS, { x: i, y: i, w: 8, h: 8, color: Color.WHITE });
        device.drawSprite(FONT, { x: 0, y: 0, w: 8, h: 8, color: Color.WHITE });
        device.endFrame();

        expect(gl.instanceDraws).toEqual([2, 1]);
        // seven pointers per batch: batch 2 must be offset by two instances
        expect(gl.pointerOffsets.length).toBe(2 * INSTANCE_ATTRIBS.length);
        const base = 2 * FLOATS_PER_INSTANCE * 4;
        for (let i = 0; i < INSTANCE_ATTRIBS.length; i++) {
            const attr = INSTANCE_ATTRIBS[i] as { offset: number };
            expect(gl.pointerOffsets[INSTANCE_ATTRIBS.length + i]).toBe(base + attr.offset * 4);
        }
    });
});

describe("WebGL2 textures", () => {
    it("creates a texture with the backend kind and re-uploads on update", () => {
        const { gl, device } = makeDevice();
        const texture = device.createTexture(IMAGE_2X2, 2, 2, { linear: false }) as Texture;
        expect(texture.kind).toBe("webgl2");
        expect(texture.premultiplied).toBe(false);
        expect(texture.width).toBe(2);

        const handle = texture.handle;
        gl.texImageCalls = 0;
        device.updateTexture(texture, { width: 4, height: 4 } as TexImageSource, 4, 4);
        expect(gl.texImageCalls).toBe(1);
        expect(texture.handle).toBe(handle);
        expect(texture.width).toBe(4);
        expect(texture.height).toBe(4);
    });

    it("rejects a declared size that does not match the source image", () => {
        const { device } = makeDevice();
        expect(() => device.createTexture(IMAGE_2X2, 3, 3)).toThrow(/does not match/);
    });

    it("rejects a texture from the other backend", () => {
        const { device } = makeDevice();
        const foreign = { kind: "webgpu", width: 1, height: 1, premultiplied: false } as RenderTexture;
        expect(() => device.drawSprite(foreign, { x: 0, y: 0, w: 1, h: 1 })).toThrow(/webgpu backend/);
        expect(() => device.updateTexture(foreign, IMAGE_2X2, 2, 2)).toThrow(/webgpu backend/);
    });

    it("disposeTexture deletes the GL object and rejects further use", () => {
        const { gl, device } = makeDevice();
        const texture = device.createTexture(IMAGE_2X2, 2, 2);
        device.disposeTexture(texture);
        expect(gl.texturesDeleted.length).toBe(1);
        expect(() => device.updateTexture(texture, IMAGE_2X2, 2, 2)).toThrow(/not created by this device/);
    });

    it("device dispose deletes every tracked texture", () => {
        const { gl, device } = makeDevice();
        device.createTexture(IMAGE_2X2, 2, 2);
        device.createTexture(IMAGE_2X2, 2, 2);
        device.dispose();
        expect(gl.texturesDeleted.length).toBe(2);
        device.dispose();
        expect(gl.texturesDeleted.length).toBe(2);
    });
});

describe("WebGL2 premultiplied blending", () => {
    it("switches blendFunc per batch and restores straight alpha at frame start", () => {
        const { gl, device } = makeDevice();
        const premultiplied = device.createTexture(IMAGE_2X2, 2, 2, { premultiplyAlpha: true });

        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        device.drawSprite(premultiplied, { x: 0, y: 0, w: 8, h: 8 });
        device.drawSprite(ATLAS, { x: 0, y: 0, w: 8, h: 8 });
        device.endFrame();

        expect(gl.blendCalls).toContainEqual([gl.ONE, gl.ONE_MINUS_SRC_ALPHA]);
        expect(gl.blendCalls[gl.blendCalls.length - 1]).toEqual([gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA]);

        // the next frame starts straight even though the previous one ended on a sprite batch
        const before = gl.blendCalls.length;
        device.beginFrame(new Color(0, 0, 0, 255), new Mat3());
        expect(gl.blendCalls.slice(before)).toContainEqual([gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA]);
        device.endFrame();
    });
});

describe("WebGL2 context loss", () => {
    it("stops rendering while lost and reports loss once", () => {
        const { gl, device } = makeDevice();
        let lostCalls = 0;
        device.onLost = () => lostCalls++;

        const event = new Event("webglcontextlost", { cancelable: true });
        gl.canvas.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(device.isLost).toBe(true);
        expect(lostCalls).toBe(1);

        // repeated loss notifications do not call onLost again
        gl.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
        expect(lostCalls).toBe(1);

        const drawsBefore = gl.instanceDraws.length;
        runAlternatingFrame(device, 2, 2);
        expect(gl.instanceDraws.length).toBe(drawsBefore);
        expect(() => device.createTexture(IMAGE_2X2, 2, 2)).toThrow(/lost/);
    });

    it("rebuilds batches and re-uploads retained textures on restore", async () => {
        const { gl, device } = makeDevice();
        const texture = device.createTexture(IMAGE_2X2, 2, 2) as Texture;
        const oldHandle = texture.handle;
        let lostCalls = 0;
        device.onLost = () => lostCalls++;

        gl.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
        expect(await device.recover()).toBe(false);

        gl.texImageCalls = 0;
        gl.canvas.dispatchEvent(new Event("webglcontextrestored"));
        expect(device.isLost).toBe(false);
        expect(lostCalls).toBe(1);
        // a fresh GL object with a fresh upload
        expect(texture.handle).not.toBe(oldHandle);
        expect(gl.texImageCalls).toBe(1);

        const drawsBefore = gl.instanceDraws.length;
        runAlternatingFrame(device, 2, 3);
        expect(gl.instanceDraws.length).toBeGreaterThan(drawsBefore);
        expect(await device.recover()).toBe(true);
    });

    it("removes the listeners and deletes textures on dispose", () => {
        const { gl, device } = makeDevice();
        let lostCalls = 0;
        device.onLost = () => lostCalls++;
        device.createTexture(IMAGE_2X2, 2, 2);
        device.dispose();
        expect(gl.texturesDeleted.length).toBe(1);

        gl.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
        expect(lostCalls).toBe(0);
        expect(device.isLost).toBe(false);
    });
});
