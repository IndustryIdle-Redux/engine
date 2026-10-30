/**
 * Engine-agnostic 2D/3D vector.
 *
 * Mutable and chainable, like Cocos `cc.Vec2` / `cc.Vec3`: the plain instance methods
 * return new vectors, and only the `*Self` variants (plus their aliases) mutate the
 * receiver. `x/y/z` are plain number fields, so instances also satisfy `{x,y,z}` shapes.
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

    /* ---------------- static constants ---------------- */

    public static readonly ZERO = new Vec3(0, 0, 0);
    public static readonly ONE = new Vec3(1, 1, 1);
    public static readonly UP = new Vec3(0, 1, 0);
    public static readonly RIGHT = new Vec3(1, 0, 0);
    public static readonly FORWARD = new Vec3(0, 0, 1);

    /* ---------------- static computation ---------------- */

    /**
     * Magnitude (static form). Not named `length`: a static `Vec3.length` would collide
     * with JS's built-in `Function.length` (TS2699).
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

    /* ---------------- instance methods ---------------- */

    /** Magnitude (same semantics as Cocos' `v.length` getter) */
    public get length(): number {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    }

    public mag(): number {
        return this.length;
    }

    /** Squared magnitude (avoids the sqrt; used for distance comparisons) */
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

    /** Addition: returns a new vector; does not mutate the receiver */
    public add(other: Vec3, out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = this.x + other.x;
        o.y = this.y + other.y;
        o.z = this.z + other.z;
        return o;
    }

    /** In-place addition */
    public addSelf(other: Vec3): Vec3 {
        this.x += other.x;
        this.y += other.y;
        this.z += other.z;
        return this;
    }

    /** Subtraction: returns a new vector; does not mutate the receiver */
    public sub(other: Vec3, out?: Vec3): Vec3 {
        return Vec3.subtract(out ?? new Vec3(), this, other);
    }

    /** In-place subtraction */
    public subSelf(other: Vec3): Vec3 {
        return Vec3.subtract(this, this, other);
    }

    /**
     * Multiply by a scalar: returns a new vector; does not mutate the receiver.
     * Note `mul`/`div` take a scalar, while `scale` is the component-wise variant.
     */
    public mul(num: number, out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = this.x * num;
        o.y = this.y * num;
        o.z = this.z * num;
        return o;
    }

    /** In-place multiply by a scalar */
    public mulSelf(num: number): Vec3 {
        this.x *= num;
        this.y *= num;
        this.z *= num;
        return this;
    }

    /** Component-wise multiply: returns a new vector; does not mutate the receiver */
    public scale(other: Vec3, out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = this.x * other.x;
        o.y = this.y * other.y;
        o.z = this.z * other.z;
        return o;
    }

    /** In-place component-wise multiply */
    public scaleSelf(other: Vec3): Vec3 {
        this.x *= other.x;
        this.y *= other.y;
        this.z *= other.z;
        return this;
    }

    /** Divide by a scalar: returns a new vector; does not mutate the receiver */
    public div(num: number, out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = this.x / num;
        o.y = this.y / num;
        o.z = this.z / num;
        return o;
    }

    /** In-place divide by a scalar */
    public divSelf(num: number): Vec3 {
        this.x /= num;
        this.y /= num;
        this.z /= num;
        return this;
    }

    /** Negate: returns a new vector; does not mutate the receiver */
    public neg(out?: Vec3): Vec3 {
        const o = out ?? new Vec3();
        o.x = -this.x;
        o.y = -this.y;
        o.z = -this.z;
        return o;
    }

    /** In-place negate */
    public negSelf(): Vec3 {
        this.x = -this.x;
        this.y = -this.y;
        this.z = -this.z;
        return this;
    }

    /** Fuzzy equality: each component differs by < 1e-6 */
    public fuzzyEquals(other: Vec3): boolean {
        return (
            Math.abs(this.x - other.x) < 1e-6 &&
            Math.abs(this.y - other.y) < 1e-6 &&
            Math.abs(this.z - other.z) < 1e-6
        );
    }

    /** In-place subtraction (Cocos `subtract`); `sub` is the non-mutating form */
    public subtract(other: Vec3): Vec3 {
        return Vec3.subtract(this, this, other);
    }

    /** Static subtraction: `out = a - b` */
    public static subtract(out: Vec3, a: Vec3, b: Vec3): Vec3 {
        out.x = a.x - b.x;
        out.y = a.y - b.y;
        out.z = a.z - b.z;
        return out;
    }

    /** Alias of `mul`: multiplies by a scalar and returns a new vector */
    public multiplyScalar(scalar: number): Vec3 {
        return this.mul(scalar);
    }

    /** Alias of `scale`: component-wise multiply returning a new vector */
    public multiply(other: Vec3): Vec3 {
        return this.scale(other);
    }

    /** Alias of `div`: divide by a scalar returning a new vector */
    public divideScalar(scalar: number): Vec3 {
        return this.div(scalar);
    }

    public dot(other: Vec3): number {
        return this.x * other.x + this.y * other.y + this.z * other.z;
    }

    /** Cross product: returns a new vector */
    public cross(other: Vec3, out?: Vec3): Vec3 {
        const { x, y, z } = this;
        const o = out ?? new Vec3();
        o.x = y * other.z - z * other.y;
        o.y = z * other.x - x * other.z;
        o.z = x * other.y - y * other.x;
        return o;
    }

    /** Normalize: returns a new vector; a zero vector stays zero */
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

    /** In-place normalize */
    public normalizeSelf(): Vec3 {
        const len = this.length;
        if (len > 0) {
            this.x /= len;
            this.y /= len;
            this.z /= len;
        }
        return this;
    }

    /** Linear interpolation: returns a new vector; does not mutate the receiver */
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

    /** In-place clamp to [min, max] */
    public clampf(min: Vec3, max: Vec3): Vec3 {
        this.x = this.x < min.x ? min.x : this.x > max.x ? max.x : this.x;
        this.y = this.y < min.y ? min.y : this.y > max.y ? max.y : this.y;
        this.z = this.z < min.z ? min.z : this.z > max.z ? max.z : this.z;
        return this;
    }

    /** Angle with the +X axis (radians) */
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

    /** Alias of `scaleSelf`: component-wise divide in place */
    public divide(other: Vec3): Vec3 {
        this.x /= other.x;
        this.y /= other.y;
        this.z /= other.z;
        return this;
    }

    /** Alias of `neg`: returns a new negated vector */
    public negate(): Vec3 {
        return this.neg();
    }

    /** Alias of `magSqr` */
    public lengthSqr(): number {
        return this.magSqr();
    }
}

/** Compatibility factory for Cocos's `cc.v3(x, y, z)` */
export function v3(x?: number | Vec3, y?: number, z?: number): Vec3 {
    return typeof x === "object" ? new Vec3(x.x, x.y, x.z) : new Vec3(x ?? 0, y ?? 0, z ?? 0);
}
