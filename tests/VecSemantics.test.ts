/**
 * Vector arithmetic semantics regression test.
 *
 * ### Why this file must exist
 * Cocos' instance methods `add` / `sub` / `mul` / `scale` / `div` / `neg`
 * **always return a new vector and never modify themselves**; the in-place versions are the `*Self` family.
 *
 * This is extremely easy to get backwards (writing an in-place modification), and **type checking cannot catch it at all** --
 * the symptom is silently wrong geometry. Real incident: in `pos.sub(other).magSqr()`, `pos` was a
 * `Object.freeze`d tile center, so an in-place write throws outright in strict mode (ESM):
 * `Cannot assign to read only property 'x'`; whereas in the original Cocos non-strict build it
 * only fails silently and computes a wrong distance.
 *
 * Authoritative source: Cocos Creator 2.4.11 source
 * `engine/cocos2d/core/value-types/vec3.ts`:
 * ```ts
 * sub (vector, out?) { return Vec3.subtract(out || new Vec3(), this, vector); }
 * subSelf = Vec3.prototype.subtract;
 * ```
 */
import { describe, expect, it } from "vitest";
import { Vec2 } from "../src/Vec2";
import { Vec3 } from "../src/Vec3";

describe("Vec3 — Cocos-compatible semantics", () => {
    it("add / sub / mul / scale / div / neg all leave the receiver unchanged", () => {
        const a = new Vec3(3, 4, 5);
        const b = new Vec3(1, 2, 3);
        const snapshot = { x: a.x, y: a.y, z: a.z };

        const add = a.add(b);
        const sub = a.sub(b);
        const mul = a.mul(2);
        const scale = a.scale(b);
        const div = a.div(2);
        const neg = a.neg();

        // The receiver is unchanged
        expect({ x: a.x, y: a.y, z: a.z }).toEqual(snapshot);
        // The results are new objects
        for (const r of [add, sub, mul, scale, div, neg]) expect(r).not.toBe(a);
        // And the values are correct
        expect([add.x, add.y, add.z]).toEqual([4, 6, 8]);
        expect([sub.x, sub.y, sub.z]).toEqual([2, 2, 2]);
        expect([mul.x, mul.y, mul.z]).toEqual([6, 8, 10]);
        expect([scale.x, scale.y, scale.z]).toEqual([3, 8, 15]);
        expect([div.x, div.y, div.z]).toEqual([1.5, 2, 2.5]);
        expect([neg.x, neg.y, neg.z]).toEqual([-3, -4, -5]);
    });

    it("addSelf / subSelf / mulSelf / scaleSelf / divSelf / negSelf modify in place", () => {
        const a = new Vec3(3, 4, 5);
        const b = new Vec3(1, 2, 3);

        expect(a.addSelf(b)).toBe(a);
        expect([a.x, a.y, a.z]).toEqual([4, 6, 8]);
        expect(a.subSelf(b)).toBe(a);
        expect([a.x, a.y, a.z]).toEqual([3, 4, 5]);
        expect(a.mulSelf(2)).toBe(a);
        expect([a.x, a.y, a.z]).toEqual([6, 8, 10]);
        expect(a.scaleSelf(b)).toBe(a);
        expect([a.x, a.y, a.z]).toEqual([6, 16, 30]);
        expect(a.divSelf(2)).toBe(a);
        expect([a.x, a.y, a.z]).toEqual([3, 8, 15]);
        expect(a.negSelf()).toBe(a);
        expect([a.x, a.y, a.z]).toEqual([-3, -8, -15]);
    });

    it("sub works on an Object.freeze'd vector (this is exactly the scene that crashed in production)", () => {
        const frozen = Object.freeze(new Vec3(10, 20, 0));
        const other = new Vec3(1, 2, 0);
        // Must not throw, and must return a new vector
        const d = frozen.sub(other);
        expect([d.x, d.y, d.z]).toEqual([9, 18, 0]);
        expect(frozen.magSqr()).toBe(500);
    });

    it("the out parameter can reuse a receiver object (aligns with Cocos' third parameter)", () => {
        const a = new Vec3(5, 5, 0);
        const out = new Vec3();
        expect(a.sub(new Vec3(1, 1, 0), out)).toBe(out);
        expect([out.x, out.y, out.z]).toEqual([4, 4, 0]);
    });

    it("mul multiplies by a scalar, scale multiplies component-wise (the two are not interchangeable)", () => {
        const a = new Vec3(2, 3, 4);
        expect([a.mul(3).x, a.mul(3).y, a.mul(3).z]).toEqual([6, 9, 12]);
        const s = a.scale(new Vec3(3, 3, 3));
        expect([s.x, s.y, s.z]).toEqual([6, 9, 12]);
        // Passing a vector to mul yields NaN, and passing a scalar to scale does too -- which is why they must be distinguished at the type level
        expect(Number.isNaN(a.scale(new Vec3(1, 1, 1)).x)).toBe(false);
    });
});

describe("Vec2 — Cocos-compatible semantics", () => {
    it("add / sub / mul / scale / div / neg all leave the receiver unchanged", () => {
        const a = new Vec2(3, 4);
        const b = new Vec2(1, 2);
        const snapshot = { x: a.x, y: a.y };

        const add = a.add(b);
        const sub = a.sub(b);
        const mul = a.mul(2);
        const scale = a.scale(b);
        const div = a.div(2);
        const neg = a.neg();

        expect({ x: a.x, y: a.y }).toEqual(snapshot);
        for (const r of [add, sub, mul, scale, div, neg]) expect(r).not.toBe(a);
        expect([add.x, add.y]).toEqual([4, 6]);
        expect([sub.x, sub.y]).toEqual([2, 2]);
        expect([mul.x, mul.y]).toEqual([6, 8]);
        expect([scale.x, scale.y]).toEqual([3, 8]);
        expect([div.x, div.y]).toEqual([1.5, 2]);
        expect([neg.x, neg.y]).toEqual([-3, -4]);
    });

    it("the *Self family modifies in place", () => {
        const a = new Vec2(3, 4);
        const b = new Vec2(1, 2);
        expect(a.addSelf(b)).toBe(a);
        expect([a.x, a.y]).toEqual([4, 6]);
        expect(a.subSelf(b)).toBe(a);
        expect([a.x, a.y]).toEqual([3, 4]);
        expect(a.mulSelf(2)).toBe(a);
        expect([a.x, a.y]).toEqual([6, 8]);
        expect(a.scaleSelf(b)).toBe(a);
        expect([a.x, a.y]).toEqual([6, 16]);
        expect(a.divSelf(2)).toBe(a);
        expect([a.x, a.y]).toEqual([3, 8]);
        expect(a.negSelf()).toBe(a);
        expect([a.x, a.y]).toEqual([-3, -8]);
    });

    it("sub works on a frozen vector", () => {
        const frozen = Object.freeze(new Vec2(10, 20));
        const d = frozen.sub(new Vec2(1, 2));
        expect([d.x, d.y]).toEqual([9, 18]);
        expect(frozen.magSqr()).toBe(500);
    });

    it("clampDistance scales in place and returns the receiver (not a new vector)", () => {
        // Regression: it called the non-mutating `mul`, so the receiver was never touched and the
        // method was a silent no-op -- `this.mul(x)` returns a new vector that was thrown away.
        const short = new Vec2(3, 4); // length 5
        expect(short.clampDistance(10, 20)).toBe(short);
        expect(short.length).toBeCloseTo(10, 9);
        expect([short.x, short.y]).toEqual([6, 8]);

        const long = new Vec2(30, 40); // length 50
        long.clampDistance(1, 10);
        expect(long.length).toBeCloseTo(10, 9);

        // length already inside [min,max] -> untouched
        const inside = new Vec2(3, 4);
        inside.clampDistance(1, 10);
        expect([inside.x, inside.y]).toEqual([3, 4]);

        // zero-length vector stays at the origin (no NaN from the normalization)
        const zero = new Vec2(0, 0);
        zero.clampDistance(5, 10);
        expect([zero.x, zero.y]).toEqual([0, 0]);
    });
});
