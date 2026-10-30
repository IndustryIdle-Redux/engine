/**
 * GL buffer upload bookkeeping.
 *
 * The WebGL2 backend keeps one GPU buffer per batch kind. Historically every `flush()` uploaded its
 * chunk with `gl.bufferData(...)`, which **reallocates the buffer's data store** (orphaning). A frame
 * that alternates vector/sprite work — the overlay used to do that once per visible tile — therefore
 * performed one GPU allocation per layer switch, regardless of how small the chunk was.
 *
 * The invariants locked down here:
 *  1. a frame's uploads are **disjoint** and cover exactly the written range once (each byte uploaded once)
 *  2. the number of `bufferData` store allocations does **not** grow with the flush count
 *  3. `begin()` (once per frame) restarts the watermark, `flush()` (many times per frame) does not
 */

import { describe, expect, it } from "vitest";
import { Mat3 } from "../src/Mat3";
import { Color } from "../src/Color";
import { FLOATS_PER_INSTANCE } from "../src/InstanceBuffer";
import { WebGL2Device } from "../src/renderer/WebGL2Device";
import type { RenderTexture } from "../src/renderer/RenderDevice";

/* ------------------------------------------------------------------ *
 * Recording fake WebGL2 context
 * ------------------------------------------------------------------ */

interface Upload {
    /** id of the GPU buffer the write targeted (the sprite and vector batches own separate buffers) */
    buffer: number;
    /** byte offset the data was written at (`bufferData` always writes a fresh store, offset 0) */
    offset: number;
    /** bytes written (`bufferData` with a size hint instead of data is recorded with `sizeHint`) */
    size: number;
    /** true when only a capacity hint was passed (no payload) */
    sizeHint: boolean;
    seq: number;
}

class FakeGL {
    public readonly uploads: Upload[] = [];
    /** instance counts of `drawArraysInstanced` calls, in order */
    public readonly instanceDraws: number[] = [];
    /** vertex counts of `drawArrays` calls, in order */
    public readonly vertexDraws: number[] = [];
    public bufferDataCalls = 0;
    public bufferSubDataCalls = 0;
    private seq = 0;
    private nextBufferId = 1;
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
    public readonly ONE_MINUS_SRC_ALPHA = 0x0303;
    public readonly COLOR_BUFFER_BIT = 0x4000;

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
    public vertexAttribPointer(): void {}
    public vertexAttribDivisor(): void {}
    public useProgram(): void {}
    public uniformMatrix3fv(): void {}
    public uniform1i(): void {}
    public activeTexture(): void {}
    public bindTexture(): void {}
    public deleteBuffer(): void {}
    public deleteVertexArray(): void {}
    public deleteProgram(): void {}
    public disable(): void {}
    public enable(): void {}
    public blendFunc(): void {}
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

    public drawArrays(_mode: number, first: number, count: number): void {
        this.vertexDraws.push(count);
        void first;
    }

    /** payload uploads only (a `bufferData` size hint carries no bytes) */
    public get payloads(): Upload[] {
        return this.uploads.filter((u) => !u.sizeHint);
    }
}

const ATLAS = { width: 1024, height: 1024 } as unknown as RenderTexture;

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
            expect(overlap, `uploads overlap: [${a.offset},${a.offset + a.size}) and [${b.offset},${b.offset + b.size})`).toBe(
                false,
            );
        }
    }
}

describe("WebGL2 batch uploads", () => {
    it("a many-flush frame uploads every byte exactly once, at disjoint offsets", () => {
        const { gl, device } = makeDevice();
        runAlternatingFrame(device, 40, 4);

        // sprite chunks: 40 * (4 instances * 64 B) = 10240 B; vector chunks: 40 * (3 vertices * 24 B) = 2880 B
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

        // 10x the flushes: the two stores grow logarithmically (doubling), never once per flush.
        // Before this change the same frame issued one `bufferData` per flush (measured: 1000 for 500 flushes).
        expect(many.gl.bufferDataCalls).toBeLessThanOrEqual(few.gl.bufferDataCalls + 4);
        expect(many.gl.bufferDataCalls).toBeLessThanOrEqual(16);
        // every flush after the stores are big enough is a plain sub-data write
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
        // the first chunk of the second frame starts at offset 0
        expect(Math.min(...secondFrame.map((u) => u.offset))).toBe(0);
    });

    it("frame stats are the frame totals, not the last chunk's", () => {
        const { gl, device } = makeDevice();
        runAlternatingFrame(device, 7, 3);
        expect(device.instanceCount).toBe(7 * 3);
        // 7 sprite chunks (one per flush) + 7 vector chunks
        expect(device.drawCalls).toBe(14);
        expect(device.triangleCount).toBe(7 * 1);
        expect(gl.instanceDraws.reduce((a, b) => a + b, 0)).toBe(7 * 3);
    });

    it("regression: the pre-change behaviour allocated a GPU store per flush (measurement record)", () => {
        // The old code called `bufferData(view())` inside every flush, i.e. one store allocation per
        // layer switch: measured 1000 allocations / 164 KB of payload for a 500-flush, 2000-instance frame.
        // Keep the numbers documented so the invariant above is not "optimised" back.
        const { gl, device } = makeDevice();
        runAlternatingFrame(device, 500, 4);
        expect(gl.bufferDataCalls).toBeLessThanOrEqual(16);
        expect(gl.bufferSubDataCalls).toBeGreaterThanOrEqual(1000);
    });
});
