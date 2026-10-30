/**
 * Engine-agnostic 2D/3D vector.
 *
 * Goal: replace `cc.Vec2` / `cc.Vec3` / `cc.v2()` / `cc.v3()`.
 *
 * Design trade-offs:
 *  - **Mutable + chainable**, matching Cocos semantics (`add()` mutates in place and returns this),
 *    so swapping this in leaves business code behavior unchanged and does not force an immutable style.
 *  - `x/y/z` are **plain number fields**, so they can be used directly as `{x,y,z}` in structural types,
 *    and it stays easy to move to SoA/TypedArray later without touching callers.
 *  - `length` is a **getter** returning the magnitude -- same semantics as Cocos's `v.length`.
 *    The static form is named `magnitude()` rather than `length()`: a static `length` would collide
 *    with JS's built-in `Function.length` (TS2699).
 */

export class Vec3 {
    public x: number;
    public y: number;
    public z: number;

    constructor(x: number = 0, y: number = 0, z: number = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    /* ---------------- Static constants ---------------- */

    public static readonly ZERO = new Vec3(0, 0, 0);
    public static readonly ONE = new Vec3(1, 1, 1);
    public static readonly UP = new Vec3(0, 1, 0);
    public static readonly RIGHT = new Vec3(1, 0, 0);
    public static readonly FORWARD = new Vec3(0, 0, 1);

    /* ---------------- Static computation ---------------- */

    /**
     * Magnitude (static form).
     *
     * Note: **must not be named `length`** -- a static `Vec3.length` property would collide with JS's built-in
     * `Function.length` (parameter count) (TS2699); this is also why stock Cocos only exposes `length` on instances.
     */
    public static magnitude(v: Vec3): number {
        return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    }

    /** Distance between two points */
    public static distance(a: Vec3, b: Vec3): number {
        return Vec3.sub(new Vec3(), a, b).mag();
    }

    /** a - b, result written into out */
    public static sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
        out.x = a.x - b.x;
        out.y = a.y - b.y;
        out.z = a.z - b.z;
        return out;
    }

    /** a + b, result written into out */
    public static add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
        out.x = a.x + b.x;
        out.y = a.y + b.y;
        out.z = a.z + b.z;
        return out;
    }

    /** Linear interpolation, result written into out */
    public static lerp(out: Vec3, a: Vec3, b: Vec3, ratio: number): Vec3 {
        out.x = a.x + (b.x - a.x) * ratio;
        out.y = a.y + (b.y - a.y) * ratio;
        out.z = a.z + (b.z - a.z) * ratio;
        return out;
    }

    /* ---------------- Instance methods (mutable, chainable) ---------------- */

    /** Magnitude (matches Cocos's `v.length` getter semantics) */
    public get length(): number {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    }

    /** Magnitude (Cocos also has `v.mag()`; kept) */
    public mag(): number {
        return this.length;
    }

    /** Squared magnitude (avoids the sqrt, used for distance comparisons). Originally a game-defined `magSqr` extension. */
    public magSqr(): number {
        return this.x * this.x + this.y * this.y + this.z * this.z;
    }

    public clone(): Vec3 {
        return new Vec3(this.x, this.y, this.z);
    }

    public set(x: number | Vec3, y?: number, z?: number): Vec3 {
        if (typeof x === "object") {
            this.x = x.x;
            this.y = x.y;
            this.z = x.z;
        } else {
            this.x = x;
            this.y = y ?? 0;
            this.z = z ?? 0;
        }
        return this;
    }

    public copy(other: Vec3): Vec3 {
        this.x = other.x;
        this.y = other.y;
        this.z = other.z;
        return this;
    }

    /** Addition (matches Cocos `Vec3.prototype.add`): **returns a new vector**, does not mutate self */
    public add(other: Vec3, out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = this.x + other.x;
        o.y = this.y + other.y;
        o.z = this.z + other.z;
        return o;
    }

    /** In-place addition (matches Cocos `addSelf`) */
    public addSelf(other: Vec3): Vec3 {
        this.x += other.x;
        this.y += other.y;
        this.z += other.z;
        return this;
    }

    /** Subtraction (matches Cocos `Vec3.prototype.sub`): **returns a new vector**, does not mutate self */
    public sub(other: Vec3, out?: Vec3): Vec3 {
        return Vec3.subtract(out ?? new Vec3(), this, other);
    }

    /** In-place subtraction (matches Cocos `subSelf`) */
    public subSelf(other: Vec3): Vec3 {
        return Vec3.subtract(this, this, other);
    }

    /**
     * Multiply by a **scalar** (matches Cocos `Vec3.prototype.mul`): **returns a new vector**.
     *
     * ⚠ In Cocos the semantics of `mul` and `scale` are easy to mix up:
     *  - instance `mul(num)` / `div(num)` → multiply/divide every component by the same **scalar**
     *  - instance `scale(vector)` → **component-wise multiply**
     * In game code, `dir.mul(speed * dt)` relies on exactly this "multiply by scalar" semantics.
     *
     * Also note: **Cocos instance methods never mutate self** (only the `*Self` variants do).
     * Get this backwards and the geometry silently computes wrong (tsc cannot catch it).
     */
    public mul(num: number, out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = this.x * num;
        o.y = this.y * num;
        o.z = this.z * num;
        return o;
    }

    /** In-place multiply by scalar (matches Cocos `mulSelf`) */
    public mulSelf(num: number): Vec3 {
        this.x *= num;
        this.y *= num;
        this.z *= num;
        return this;
    }

    /** Component-wise multiply (matches the Cocos instance method `Vec3.prototype.scale(vector)`): returns a new vector */
    public scale(other: Vec3, out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = this.x * other.x;
        o.y = this.y * other.y;
        o.z = this.z * other.z;
        return o;
    }

    /** In-place component-wise multiply (matches Cocos `scaleSelf`) */
    public scaleSelf(other: Vec3): Vec3 {
        this.x *= other.x;
        this.y *= other.y;
        this.z *= other.z;
        return this;
    }

    /** Divide by scalar (matches Cocos `Vec3.prototype.div`): returns a new vector */
    public div(num: number, out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = this.x / num;
        o.y = this.y / num;
        o.z = this.z / num;
        return o;
    }

    /** In-place divide by scalar (matches Cocos `divSelf`) */
    public divSelf(num: number): Vec3 {
        this.x /= num;
        this.y /= num;
        this.z /= num;
        return this;
    }

    /** Negate (matches Cocos `Vec3.prototype.neg`): returns a new vector */
    public neg(out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = -this.x;
        o.y = -this.y;
        o.z = -this.z;
        return o;
    }

    /** In-place negate (matches Cocos `negSelf`) */
    public negSelf(): Vec3 {
        this.x = -this.x;
        this.y = -this.y;
        this.z = -this.z;
        return this;
    }



    /** Approximately equal (matches Cocos `fuzzyEquals`): per-component difference < 1e-6 */
    public fuzzyEquals(other: Vec3): boolean {
        return (
            Math.abs(this.x - other.x) < 1e-6 &&
            Math.abs(this.y - other.y) < 1e-6 &&
            Math.abs(this.z - other.z) < 1e-6
        );
    }

    /**
     * In-place subtraction (matches Cocos `Vec3.prototype.subtract` = `subSelf`).
     *
     * Note this is **in-place** (Cocos uses it to implement `subSelf`);
     * do not confuse it with `sub()` (which returns a new vector).
     */
    public subtract(other: Vec3): Vec3 {
        return Vec3.subtract(this, this, other);
    }

    /** Static subtraction: `out = a - b` (matches Cocos `Vec3.subtract`) */
    public static subtract(out: Vec3, a: Vec3, b: Vec3): Vec3 {
        out.x = a.x - b.x;
        out.y = a.y - b.y;
        out.z = a.z - b.z;
        return out;
    }


    /** Multiply by scalar (matches Cocos's static alias `multiplyScalar` / `scale`) */
    public multiplyScalar(scalar: number): Vec3 {
        return this.mul(scalar);
    }

    /** Component-wise multiply (matches Cocos `Vec3.prototype.multiply`) */
    public multiply(other: Vec3): Vec3 {
        return this.scale(other);
    }

    /** Divide by scalar (matches Cocos `Vec3.prototype.divideScalar`) */
    public divideScalar(scalar: number): Vec3 {
        return this.div(scalar);
    }

    /**
     * In-place clamp (matches Cocos's free-function form of `clampf`; this class already provides the instance form clampf(min,max)).
     */

    public dot(other: Vec3): number {
        return this.x * other.x + this.y * other.y + this.z * other.z;
    }

    /** Cross product (matches Cocos `Vec3.prototype.cross`): **returns a new vector** */
    public cross(other: Vec3, out?: Vec3): Vec3 {
        const { x, y, z } = this;
        const o = out ?? new Vec3();
        o.x = y * other.z - z * other.y;
        o.y = z * other.x - x * other.z;
        o.z = x * other.y - y * other.x;
        return o;
    }

    /** Normalize (matches Cocos `Vec3.prototype.normalize`): **returns a new vector**; a zero vector stays zero */
    public normalize(out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        const len = this.length;
        if (len > 0) {
            o.x = this.x / len;
            o.y = this.y / len;
            o.z = this.z / len;
        } else {
            o.x = this.x;
            o.y = this.y;
            o.z = this.z;
        }
        return o;
    }

    /** In-place normalize (matches Cocos `normalizeSelf`) */
    public normalizeSelf(): Vec3 {
        const len = this.length;
        if (len > 0) {
            this.x /= len;
            this.y /= len;
            this.z /= len;
        }
        return this;
    }

    /** Linear interpolation (matches Cocos `Vec3.prototype.lerp`): **returns a new vector** */
    public lerp(to: Vec3, ratio: number, out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = this.x + (to.x - this.x) * ratio;
        o.y = this.y + (to.y - this.y) * ratio;
        o.z = this.z + (to.z - this.z) * ratio;
        return o;
    }

    public distance(other: Vec3): number {
        const dx = this.x - other.x;
        const dy = this.y - other.y;
        const dz = this.z - other.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    public equals(other: Vec3): boolean {
        return this.x === other.x && this.y === other.y && this.z === other.z;
    }

    /** In-place clamp to [min, max] (matches the `.clampf` usage in the original code) */
    public clampf(min: Vec3, max: Vec3): Vec3 {
        this.x = this.x < min.x ? min.x : this.x > max.x ? max.x : this.x;
        this.y = this.y < min.y ? min.y : this.y > max.y ? max.y : this.y;
        this.z = this.z < min.z ? min.z : this.z > max.z ? max.z : this.z;
        return this;
    }

    /** Angle with the +X axis (radians), matching Cocos `Vec3.prototype.angle` semantics */
    public angle(other: Vec3): number {
        const denom = this.length * other.length;
        if (denom === 0) return 0;
        return Math.acos(Math.max(-1, Math.min(1, this.dot(other) / denom)));
    }

    public toArray(): number[] {
        return [this.x, this.y, this.z];
    }

    public toString(): string {
        return `(${this.x}, ${this.y}, ${this.z})`;
    }

    /** Alias: component-wise divide (matches Cocos `divide`) */
    public divide(other: Vec3): Vec3 {
        this.x /= other.x;
        this.y /= other.y;
        this.z /= other.z;
        return this;
    }

    /** Alias: negate (matches Cocos `negate`) */
    public negate(): Vec3 {
        return this.neg();
    }

    /** Squared magnitude (matches Cocos `lengthSqr`) */
    public lengthSqr(): number {
        return this.magSqr();
    }
}

/** Compatibility factory for Cocos's `cc.v3(x, y, z)` */
export function v3(x?: number | Vec3, y?: number, z?: number): Vec3 {
    return typeof x === "object" ? new Vec3(x.x, x.y, x.z) : new Vec3(x ?? 0, y ?? 0, z ?? 0);
}
