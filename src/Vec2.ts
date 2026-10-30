/**
 * Engine-agnostic 2D vector. Replaces `cc.Vec2` / `cc.v2()`.
 *
 * Like `Vec3`, it uses "mutable + chainable" semantics so that swapping it in does not change behavior.
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

    /** Magnitude (matches the semantics of Cocos' `v.length` accessor) */
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

    /** Addition (matches Cocos `Vec2.prototype.add`): **returns a new vector** */
    public add(other: Vec2, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x + other.x;
        o.y = this.y + other.y;
        return o;
    }

    /** In-place addition (matches Cocos `addSelf`) */
    public addSelf(other: Vec2): Vec2 {
        this.x += other.x;
        this.y += other.y;
        return this;
    }

    /** Subtraction (matches Cocos `Vec2.prototype.sub`): **returns a new vector** */
    public sub(other: Vec2, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x - other.x;
        o.y = this.y - other.y;
        return o;
    }

    /** In-place subtraction (matches Cocos `subSelf`) */
    public subSelf(other: Vec2): Vec2 {
        this.x -= other.x;
        this.y -= other.y;
        return this;
    }

    /** Multiply by a scalar (matches Cocos `Vec2.prototype.mul`): returns a new vector */
    public mul(num: number, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x * num;
        o.y = this.y * num;
        return o;
    }

    /** In-place multiply by a scalar (matches Cocos `mulSelf`) */
    public mulSelf(num: number): Vec2 {
        this.x *= num;
        this.y *= num;
        return this;
    }

    /** Component-wise multiply (matches Cocos `Vec2.prototype.scale(vector)`): returns a new vector */
    public scale(other: Vec2, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x * other.x;
        o.y = this.y * other.y;
        return o;
    }

    /** In-place component-wise multiply (matches Cocos `scaleSelf`) */
    public scaleSelf(other: Vec2): Vec2 {
        this.x *= other.x;
        this.y *= other.y;
        return this;
    }

    /** Divide by a scalar (matches Cocos `Vec2.prototype.div`): returns a new vector */
    public div(num: number, out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = this.x / num;
        o.y = this.y / num;
        return o;
    }

    /** In-place divide by a scalar (matches Cocos `divSelf`) */
    public divSelf(num: number): Vec2 {
        this.x /= num;
        this.y /= num;
        return this;
    }

    /** Negate (matches Cocos `Vec2.prototype.neg`): returns a new vector */
    public neg(out?: Vec2): Vec2 {
        const o = out ?? new Vec2();
        o.x = -this.x;
        o.y = -this.y;
        return o;
    }

    /** In-place negate (matches Cocos `negSelf`) */
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

    /** Normalize (matches Cocos `Vec2.prototype.normalize`): **returns a new vector** */
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

    /** In-place normalize (matches Cocos `normalizeSelf`) */
    public normalizeSelf(): Vec2 {
        const len = this.length;
        if (len > 0) {
            this.x /= len;
            this.y /= len;
        }
        return this;
    }

    /** Linear interpolation (matches Cocos `Vec2.prototype.lerp`): **returns a new vector** */
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

    /** The custom extension `cc.Vec2.prototype.clampDistance` from the original code */
    public clampDistance(min: number, max: number): Vec2 {
        const d = this.length;
        if (d === 0) return this;
        const target = d < min ? min : d > max ? max : d;
        // ⚠️ Must be `mulSelf`: `mul` is Cocos-compatible and returns a **new** vector
        // (see `VecSemantics.test.ts`), so `this.mul(target / d)` left the receiver untouched and
        // `clampDistance` was a silent no-op. Cocos' own `clampDistance` scales in place.
        if (target !== d) this.mulSelf(target / d);
        return this;
    }

    public toArray(): number[] {
        return [this.x, this.y];
    }

    public toString(): string {
        return `(${this.x}, ${this.y})`;
    }

    /** Fuzzy equality (matches Cocos `fuzzyEquals`): each component differs by < 1e-6 */
    public fuzzyEquals(other: Vec2): boolean {
        return Math.abs(this.x - other.x) < 1e-6 && Math.abs(this.y - other.y) < 1e-6;
    }

    /** Clamp in place to [min, max] */
    public clampf(min: Vec2, max: Vec2): Vec2 {
        this.x = this.x < min.x ? min.x : this.x > max.x ? max.x : this.x;
        this.y = this.y < min.y ? min.y : this.y > max.y ? max.y : this.y;
        return this;
    }

    /** Alias: subtraction (matches Cocos `subtract`) */
    public subtract(other: Vec2): Vec2 {
        return this.sub(other);
    }

    /** Multiply by a scalar (matches Cocos `Vec2.prototype.multiplyScalar`) */
    public multiplyScalar(s: number): Vec2 {
        return this.mulSelf(s);
    }
}

/** Cocos-compatible `cc.v2(x, y)` factory */
export function v2(x?: number | Vec2, y?: number): Vec2 {
    return typeof x === "object" ? new Vec2(x.x, x.y) : new Vec2(x ?? 0, y ?? 0);
}
