import { describe, expect, it } from "vitest";
import { Color } from "../src/Color";
import { FLOATS_PER_INSTANCE, InstanceBuffer } from "../src/InstanceBuffer";

/** Field offsets into an instance, spelled out for readability */
const F = {
    x: 0,
    y: 1,
    w: 2,
    h: 3,
    ax: 4,
    ay: 5,
    cos: 6,
    sin: 7,
    u0: 8,
    v0: 9,
    du: 10,
    dv: 11,
    r: 12,
    g: 13,
    b: 14,
    a: 15,
} as const;

describe("InstanceBuffer basic writes", () => {
    it("layout constants are self-consistent", () => {
        expect(FLOATS_PER_INSTANCE).toBe(16);
        expect(F.a).toBe(FLOATS_PER_INSTANCE - 1);
    });

    it("writes with minimal arguments, and the defaults are correct", () => {
        const buf = new InstanceBuffer(4);
        buf.push({ x: 10, y: 20, w: 32, h: 32 });
        expect(buf.count).toBe(1);
        expect(buf.at(0, F.x)).toBe(10);
        expect(buf.at(0, F.y)).toBe(20);
        expect(buf.at(0, F.w)).toBe(32);
        expect(buf.at(0, F.h)).toBe(32);
        // The default anchor is centered
        expect(buf.at(0, F.ax)).toBe(0.5);
        expect(buf.at(0, F.ay)).toBe(0.5);
        // No rotation by default → (cos,sin) = (1,0)
        expect(buf.at(0, F.cos)).toBe(1);
        expect(buf.at(0, F.sin)).toBe(0);
        // Full texture by default
        expect(buf.at(0, F.u0)).toBe(0);
        expect(buf.at(0, F.du)).toBe(1);
        expect(buf.at(0, F.dv)).toBe(1);
        // Opaque white by default
        expect(buf.at(0, F.r)).toBe(1);
        expect(buf.at(0, F.a)).toBe(1);
    });

    it("stores rotation as cos/sin (avoiding trig in the shader)", () => {
        const buf = new InstanceBuffer(2);
        const rot = Math.PI / 3;
        buf.push({ x: 0, y: 0, w: 1, h: 1, rotation: rot });
        expect(buf.at(0, F.cos)).toBeCloseTo(Math.cos(rot), 6);
        expect(buf.at(0, F.sin)).toBeCloseTo(Math.sin(rot), 6);
    });

    it("supports a custom anchor and an atlas UV sub-rect", () => {
        const buf = new InstanceBuffer(2);
        buf.push({ x: 0, y: 0, w: 10, h: 10, ax: 0, ay: 1, u0: 0.25, v0: 0.5, du: 0.125, dv: 0.25 });
        expect(buf.at(0, F.ax)).toBe(0);
        expect(buf.at(0, F.ay)).toBe(1);
        expect(buf.at(0, F.u0)).toBe(0.25);
        expect(buf.at(0, F.v0)).toBe(0.5);
        expect(buf.at(0, F.du)).toBe(0.125);
        expect(buf.at(0, F.dv)).toBe(0.25);
    });
});

describe("InstanceBuffer color normalization", () => {
    it("Color's 0~255 normalizes to 0~1 (at float32 precision)", () => {
        const buf = new InstanceBuffer(2);
        buf.push({ x: 0, y: 0, w: 1, h: 1, color: new Color(255, 128, 0, 255) });
        // Note: the data lives in a Float32Array with only ~7 significant digits,
        // so the assertions use 6 decimal places (f32(128/255) ≈ 0.5019608).
        expect(buf.at(0, F.r)).toBeCloseTo(1, 6);
        expect(buf.at(0, F.g)).toBeCloseTo(128 / 255, 6);
        expect(buf.at(0, F.b)).toBeCloseTo(0, 6);
        expect(buf.at(0, F.a)).toBeCloseTo(1, 6);
    });

    it("opacity affects only alpha and does not premultiply RGB", () => {
        // The blend is straight alpha, so premultiplying RGB by opacity here would apply it twice.
        const buf = new InstanceBuffer(2);
        buf.push({ x: 0, y: 0, w: 1, h: 1, color: new Color(255, 255, 255, 200), opacity: 128 });
        expect(buf.at(0, F.r)).toBeCloseTo(1, 6); // RGB stays as-is
        expect(buf.at(0, F.g)).toBeCloseTo(1, 6);
        expect(buf.at(0, F.b)).toBeCloseTo(1, 6);
        expect(buf.at(0, F.a)).toBeCloseTo((200 / 255) * (128 / 255), 6);
    });

    it("without a color, RGB is white and alpha comes from opacity", () => {
        const buf = new InstanceBuffer(2);
        buf.push({ x: 0, y: 0, w: 1, h: 1, opacity: 64 });
        expect(buf.at(0, F.r)).toBeCloseTo(1, 6);
        expect(buf.at(0, F.g)).toBeCloseTo(1, 6);
        expect(buf.at(0, F.b)).toBeCloseTo(1, 6);
        expect(buf.at(0, F.a)).toBeCloseTo(64 / 255, 6);
    });
});

describe("InstanceBuffer capacity management", () => {
    it("grows automatically past the initial capacity without losing data", () => {
        const buf = new InstanceBuffer(2);
        for (let i = 0; i < 100; i++) buf.push({ x: i, y: i * 2, w: 1, h: 1 });
        expect(buf.count).toBe(100);
        expect(buf.capacity).toBeGreaterThanOrEqual(100);
        for (let i = 0; i < 100; i++) {
            expect(buf.at(i, F.x)).toBe(i);
            expect(buf.at(i, F.y)).toBe(i * 2);
        }
    });

    it("ensure(n) reserves space for n instances", () => {
        const buf = new InstanceBuffer(1);
        buf.ensure(500);
        expect(buf.capacity).toBeGreaterThanOrEqual(500);
        expect(buf.count).toBe(0);
    });

    it("reset only zeroes the count and does not free memory (zero allocation in steady state)", () => {
        const buf = new InstanceBuffer(8);
        for (let i = 0; i < 8; i++) buf.push({ x: i, y: 0, w: 1, h: 1 });
        const dataRef = buf.data;
        const capBefore = buf.capacity;
        buf.reset();
        expect(buf.count).toBe(0);
        expect(buf.data).toBe(dataRef); // the same backing array
        expect(buf.capacity).toBe(capBefore);
    });

    it("view exposes only the written part (for bufferSubData upload)", () => {
        const buf = new InstanceBuffer(64);
        buf.push({ x: 1, y: 1, w: 1, h: 1 });
        buf.push({ x: 2, y: 2, w: 1, h: 1 });
        const v = buf.view();
        expect(v.length).toBe(2 * FLOATS_PER_INSTANCE);
        expect(v[0]).toBe(1);
        expect(v[FLOATS_PER_INSTANCE]).toBe(2);
    });
});

describe("InstanceBuffer capacity", () => {
    it("10k sprites occupy a single TypedArray", () => {
        const buf = new InstanceBuffer(16);
        for (let i = 0; i < 10000; i++) {
            buf.push({ x: i % 100, y: Math.floor(i / 100), w: 32, h: 32, u0: 0.1, v0: 0.2, du: 0.05, dv: 0.05 });
        }
        expect(buf.count).toBe(10000);
        // 10000 * 16 * 4 bytes = 640 KB
        expect(buf.view().byteLength).toBe(10000 * 16 * 4);
        expect(buf.view().byteLength).toBeLessThan(700_000);
    });
});
