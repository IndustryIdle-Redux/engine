/**
 * Engine-agnostic 2D vector.
 *
 * Mutable and chainable, like Cocos `cc.Vec2`: the plain instance methods return new
 * vectors, and only the `*Self` variants (plus their aliases) mutate the receiver.
 */

export class Vec2 {
    public x: number;
    public y: number;

    constructor(x: number = 0, y: number = 0) {
        this.x = x;
        this.y = y;
    }

    public static readonly ZERO = new Vec2(0, 0);
    public static readonly ONE = new Vec2(1, 1);
    public static readonly UP = new Vec2(0, 1);
    public static readonly RIGHT = new Vec2(1, 0);

    public static distance(a: Vec2, b: Vec2): number {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /** Magnitude (same semantics as Cocos' `v.length` accessor) */
    public get length(): number {
        return Math.sqrt(this.x * this.x + this.y * this.y);
    }

    public mag(): number {
        return this.length;
    }

    /** Squared magnitude (avoids the sqrt; used for distance comparisons) */
    public magSqr(): number {
        return this.x * this.x + this.y * this.y;
    }

    public clone(): Vec2 {
        return new Vec2(this.x, this.y);
    }

    public set(x: number | Vec2, y?: number): Vec2 {
        if (typeof x === "object") {
            this.x = x.x;
            this.y = x.y;
        } else {
            this.x = x;
            this.y = y ?? 0;
        }
        return this;
    }

    public copy(other: Vec2): Vec2 {
        this.x = other.x;
        this.y = other.y;
        return this;
    }

    /** Addition: returns a new vector; does not mutate the receiver */
    public add(other: Vec2, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x + other.x;
        o.y = this.y + other.y;
        return o;
    }

    /** In-place addition */
    public addSelf(other: Vec2): Vec2 {
        this.x += other.x;
        this.y += other.y;
        return this;
    }

    /** Subtraction: returns a new vector; does not mutate the receiver */
    public sub(other: Vec2, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x - other.x;
        o.y = this.y - other.y;
        return o;
    }

    /** In-place subtraction */
    public subSelf(other: Vec2): Vec2 {
        this.x -= other.x;
        this.y -= other.y;
        return this;
    }

    /** Multiply by a scalar: returns a new vector; does not mutate the receiver */
    public mul(num: number, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x * num;
        o.y = this.y * num;
        return o;
    }

    /** In-place multiply by a scalar */
    public mulSelf(num: number): Vec2 {
        this.x *= num;
        this.y *= num;
        return this;
    }

    /** Component-wise multiply: returns a new vector; does not mutate the receiver */
    public scale(other: Vec2, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x * other.x;
        o.y = this.y * other.y;
        return o;
    }

    /** In-place component-wise multiply */
    public scaleSelf(other: Vec2): Vec2 {
        this.x *= other.x;
        this.y *= other.y;
        return this;
    }

    /** Divide by a scalar: returns a new vector; does not mutate the receiver */
    public div(num: number, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x / num;
        o.y = this.y / num;
        return o;
    }

    /** In-place divide by a scalar */
    public divSelf(num: number): Vec2 {
        this.x /= num;
        this.y /= num;
        return this;
    }

    /** Negate: returns a new vector; does not mutate the receiver */
    public neg(out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = -this.x;
        o.y = -this.y;
        return o;
    }

    /** In-place negate */
    public negSelf(): Vec2 {
        this.x = -this.x;
        this.y = -this.y;
        return this;
    }

    public dot(other: Vec2): number {
        return this.x * other.x + this.y * other.y;
    }

    public cross(other: Vec2): number {
        return this.x * other.y - this.y * other.x;
    }

    /** Normalize: returns a new vector; does not mutate the receiver */
    public normalize(out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        const len = this.length;
        if (len > 0) {
            o.x = this.x / len;
            o.y = this.y / len;
        } else {
            o.x = this.x;
            o.y = this.y;
        }
        return o;
    }

    /** In-place normalize */
    public normalizeSelf(): Vec2 {
        const len = this.length;
        if (len > 0) {
            this.x /= len;
            this.y /= len;
        }
        return this;
    }

    /** Linear interpolation: returns a new vector; does not mutate the receiver */
    public lerp(to: Vec2, ratio: number, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x + (to.x - this.x) * ratio;
        o.y = this.y + (to.y - this.y) * ratio;
        return o;
    }

    public distance(other: Vec2): number {
        return Vec2.distance(this, other);
    }

    public equals(other: Vec2): boolean {
        return this.x === other.x && this.y === other.y;
    }

    /** Angle with the +X axis (radians) */
    public angle(other: Vec2): number {
        const denom = this.length * other.length;
        if (denom === 0) return 0;
        return Math.acos(Math.max(-1, Math.min(1, this.dot(other) / denom)));
    }

    /** Clamp the length into [min, max] in place; a zero vector stays at the origin */
    public clampDistance(min: number, max: number): Vec2 {
        const d = this.length;
        if (d === 0) return this;
        const target = d < min ? min : d > max ? max : d;
        // Scale in place: `mul` returns a new vector and would leave the receiver untouched.
        if (target !== d) this.mulSelf(target / d);
        return this;
    }

    public toArray(): number[] {
        return [this.x, this.y];
    }

    public toString(): string {
        return `(${this.x}, ${this.y})`;
    }

    /** Fuzzy equality: each component differs by < 1e-6 */
    public fuzzyEquals(other: Vec2): boolean {
        return Math.abs(this.x - other.x) < 1e-6 && Math.abs(this.y - other.y) < 1e-6;
    }

    /** Clamp in place to [min, max] */
    public clampf(min: Vec2, max: Vec2): Vec2 {
        this.x = this.x < min.x ? min.x : this.x > max.x ? max.x : this.x;
        this.y = this.y < min.y ? min.y : this.y > max.y ? max.y : this.y;
        return this;
    }

    /** Alias of `subSelf`: subtracts in place and returns the receiver */
    public subtract(other: Vec2): Vec2 {
        return this.subSelf(other);
    }

    /** Alias of `mul`: multiplies by a scalar and returns a new vector */
    public multiplyScalar(s: number): Vec2 {
        return this.mul(s);
    }
}

/** Cocos-compatible `cc.v2(x, y)` factory */
export function v2(x?: number | Vec2, y?: number): Vec2 {
    return typeof x === "object" ? new Vec2(x.x, x.y) : new Vec2(x ?? 0, y ?? 0);
}
