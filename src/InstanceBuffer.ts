/**
 * Data packer for instanced sprite batches (pure logic, no GL dependency).
 *
 * Why it is worth extracting on its own and unit-testing:
 *  This is exactly where the original Cocos version was most expensive -- it created **one `cc.Node` per sprite**
 *  (measured on a large save: 13,042 nodes, 10,000 of them overlay Labels taking 28.7 MB of heap).
 *  After switching to "one TypedArray + one `drawArraysInstanced`",
 *  the per-frame cost only depends on the **visible instance count**, not on the node count.
 *
 * So the correctness here (vertex order, UV, color normalization, capacity growth)
 * must be locked down by tests, not by eyeballing the rendered result.
 *
 * ### Instance data layout (16 floats per instance)
 *
 * | Offset | Meaning                                       |
 * |--------|-----------------------------------------------|
 * | 0,1    | World-space center (x, y)                     |
 * | 2,3    | Size (w, h), in pixels                        |
 * | 4,5    | Anchor (ax, ay), 0~1                          |
 * | 6,7    | Rotation (cos, sin)                           |
 * | 8,9    | Atlas UV top-left (u0, v0), normalized to 0~1 |
 * | 10,11  | Atlas UV size (du, dv)                        |
 * | 12-15  | Color RGBA, normalized to 0~1                 |
 */

import { Color } from "./Color";

export const FLOATS_PER_INSTANCE = 16;

/** Name and component count of each instance attribute in the vertex shader (used by the GL layer to set up the VAO) */
export const INSTANCE_ATTRIBS: ReadonlyArray<{ name: string; size: number; offset: number }> = (() => {
    const sizes = [
        { name: "a_center", size: 2 },
        { name: "a_size", size: 2 },
        { name: "a_anchor", size: 2 },
        { name: "a_rot", size: 2 },
        { name: "a_uvPos", size: 2 },
        { name: "a_uvSize", size: 2 },
        { name: "a_color", size: 4 },
    ];
    // offset is counted in **number of floats**, for the vertex attribute pointer;
    // SpriteBatch needs it plus batch.start to recompute the pointer offset when drawing in per-texture batches.
    let offset = 0;
    return sizes.map((a) => {
        const e = { ...a, offset };
        offset += a.size;
        return e;
    });
})();

/** Input parameters for one instance to draw */
export interface SpriteDrawCall {
    /** Center point in world coordinates */
    x: number;
    y: number;
    /** Sprite size (pixels) */
    w: number;
    h: number;
    /** Anchor, 0~1; the default (0.5, 0.5) means the center is the origin */
    ax?: number;
    ay?: number;
    /** Rotation (radians), default 0 */
    rotation?: number;
    /** Atlas UV (0~1), defaults to filling the whole texture */
    u0?: number;
    v0?: number;
    du?: number;
    dv?: number;
    /** Tint color, defaults to opaque white; used for tinting/fading */
    color?: Color;
    /** Opacity 0~255, default 255 */
    opacity?: number;
}

/**
 * Instance data buffer: capacity doubles on demand and **the same Float32Array is reused**.
 *
 * Key design: grow only when needed, and a normal frame only resets `count`,
 * so in steady state there are **zero allocations per frame** (GC pressure was one of the sources of the original version's 0.52%).
 */
export class InstanceBuffer {
    /** Raw float data, length = capacity × 16 */
    public data: Float32Array;
    /** Number of instances written so far */
    public count = 0;

    constructor(initialCapacity = 256) {
        this.data = new Float32Array(Math.max(1, initialCapacity) * FLOATS_PER_INSTANCE);
    }

    public get capacity(): number {
        return this.data.length / FLOATS_PER_INSTANCE;
    }

    /** Reset to 0 instances (memory is not released) */
    public reset(): void {
        this.count = 0;
    }

    /** Ensure at least n more instances can be written; if not enough, double the capacity */
    public ensure(n: number): void {
        const need = this.count + n;
        if (need <= this.capacity) return;
        let cap = this.capacity;
        while (cap < need) cap *= 2;
        const next = new Float32Array(cap * FLOATS_PER_INSTANCE);
        next.set(this.data.subarray(0, this.count * FLOATS_PER_INSTANCE));
        this.data = next;
    }

    /**
     * Write one sprite instance and return its starting float offset.
     *
     * Pure computation: no GL calls at all, so it can be asserted in Node.
     */
    public push(call: SpriteDrawCall): number {
        this.ensure(1);
        const o = this.count * FLOATS_PER_INSTANCE;
        const d = this.data;

        const ax = call.ax ?? 0.5;
        const ay = call.ay ?? 0.5;
        const rot = call.rotation ?? 0;
        const color = call.color;
        const opacity = call.opacity ?? 255;

        d[o + 0] = call.x;
        d[o + 1] = call.y;
        d[o + 2] = call.w;
        d[o + 3] = call.h;
        d[o + 4] = ax;
        d[o + 5] = ay;
        d[o + 6] = rot === 0 ? 1 : Math.cos(rot);
        d[o + 7] = rot === 0 ? 0 : Math.sin(rot);
        d[o + 8] = call.u0 ?? 0;
        d[o + 9] = call.v0 ?? 0;
        d[o + 10] = call.du ?? 1;
        d[o + 11] = call.dv ?? 1;
        /**
         * Color normalized to 0~1; **opacity applies to alpha only, do NOT premultiply it into RGB**.
         *
         * ⚠️ This is a serious bug that used to exist: the original implementation also multiplied RGB by `opacity/255`,
         * while the renderer's blend mode is `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` (**straight-through alpha**,
         * see `WebGL2Device.ts:38` and `WebGPUDevice.beginFrame`'s blend state) -- so the alpha in the vertex color gets multiplied **a second time**,
         * and the actual contribution becomes `opacity²`.
         *
         * Symptom: every draw with `opacity < 255` was disproportionately dark. Most obvious is the
         * **negative (red) value of the tile-modifier overlay**: the original uses `opacity = 55 + 200·percent`,
         * so for a negative modifier `percent→0` ⇒ opacity 55 (21%), which was already deliberately faint;
         * after premultiplying only `0.216² = 4.7%` remained, i.e. **4.6× darker**, practically invisible.
         *
         * Cocos's equivalent implementation writes opacity into vertex alpha only (`v_color = (r,g,b,a·opacity)`),
         * leaving RGB as-is -- this aligns with it.
         */
        const op = opacity / 255;
        d[o + 12] = color ? color.r / 255 : 1;
        d[o + 13] = color ? color.g / 255 : 1;
        d[o + 14] = color ? color.b / 255 : 1;
        d[o + 15] = color ? (color.a / 255) * op : op;

        this.count++;
        return o;
    }

    /** Read only the written part (for `bufferSubData` upload) */
    public view(): Float32Array {
        return this.data.subarray(0, this.count * FLOATS_PER_INSTANCE);
    }

    /** Read one component of instance i (for tests and debugging) */
    public at(index: number, field: number): number {
        return this.data[index * FLOATS_PER_INSTANCE + field] as number;
    }
}
