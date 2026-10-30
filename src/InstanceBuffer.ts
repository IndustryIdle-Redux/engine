/**
 * Data packer for instanced sprite batches (pure logic, no GL dependency).
 *
 * Instance data layout, 16 floats per instance: center (2), size (2), anchor (2),
 * rotation cos/sin (2), UV origin (2), UV size (2), RGBA (4).
 */

import { Color } from "./Color";

export const FLOATS_PER_INSTANCE = 16;

/** Name, component count and float offset of each instance attribute */
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
    // Offsets are in floats; SpriteBatch adds batch.start to rebuild the pointer per batch.
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

/** Instance data buffer: capacity doubles on demand and the backing array is reused. */
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
     * Write one sprite instance and return its starting float offset. Pure computation,
     * no GL calls.
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
        // Opacity applies to alpha only. Premultiplying RGB here would apply it twice
        // (the blend is straight alpha), making translucent sprites too dark.

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
