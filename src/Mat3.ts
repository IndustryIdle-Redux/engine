/**
 * 2D affine transform matrix (3×3, storing the 6 significant components in column-major order).
 *
 * Why write our own instead of using Cocos' `cc.AffineTransform`:
 * the renderer's transform math is a **hot path** (once per node per frame), so it needs:
 *  - to be pure and functional, batch-composable and inlinable (avoiding an allocation per call)
 *  - to be fully unit-testable in Node
 *
 * Storage order (matching WebGL's column-major `mat3`):
 *
 *     | a  c  tx |        a  c  tx
 *     | b  d  ty |   ⇒   [a, b, c, d, tx, ty]
 *     | 0  0  1  |
 *
 * So it can be used directly as the first three columns of the 9-element array for `uniformMatrix3fv` (see `toMat3Array`).
 */

import { Vec2 } from "./Vec2";

/** Column-major 2D affine matrix components (length 6) */
export interface Mat3Like {
    a: number;
    b: number;
    c: number;
    d: number;
    tx: number;
    ty: number;
}

export class Mat3 implements Mat3Like {
    public a: number;
    public b: number;
    public c: number;
    public d: number;
    public tx: number;
    public ty: number;

    constructor(a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0) {
        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.tx = tx;
        this.ty = ty;
    }

    /* ---------------- construction ---------------- */

    public static identity(): Mat3 {
        return new Mat3();
    }

    public static translation(x: number, y: number): Mat3 {
        return new Mat3(1, 0, 0, 1, x, y);
    }

    public static scaling(sx: number, sy: number = sx): Mat3 {
        return new Mat3(sx, 0, 0, sy, 0, 0);
    }

    /** Rotation (radians) */
    public static rotation(rad: number): Mat3 {
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        return new Mat3(c, s, -s, c, 0, 0);
    }

    /**
     * Composite transform: equivalent to scale → rotate → translate.
     *
     * This is the standard order for node transforms (matching Cocos `Node`),
     * and merging it into a single matrix avoids three matrix multiplications.
     */
    public static fromTRS(x: number, y: number, rotationRad: number, sx: number, sy: number): Mat3 {
        const c = Math.cos(rotationRad);
        const s = Math.sin(rotationRad);
        return new Mat3(c * sx, s * sx, -s * sy, c * sy, x, y);
    }

    /* ---------------- operations ---------------- */

    public set(a: number, b: number, c: number, d: number, tx: number, ty: number): this {
        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.tx = tx;
        this.ty = ty;
        return this;
    }

    public copyFrom(o: Mat3Like): this {
        return this.set(o.a, o.b, o.c, o.d, o.tx, o.ty);
    }

    public clone(): Mat3 {
        return new Mat3(this.a, this.b, this.c, this.d, this.tx, this.ty);
    }

    public identity(): this {
        return this.set(1, 0, 0, 1, 0, 0);
    }

    /**
     * In-place left multiply: `this = this × m`
     *
     * Semantics: fold `m` in as the "parent space → this node's space" transform,
     * i.e. the result applies m first and then this (consistent with matrix multiplication order).
     */
    public multiply(m: Mat3Like): this {
        const { a, b, c, d, tx, ty } = this;
        this.a = a * m.a + c * m.b;
        this.b = b * m.a + d * m.b;
        this.c = a * m.c + c * m.d;
        this.d = b * m.c + d * m.d;
        this.tx = a * m.tx + c * m.ty + tx;
        this.ty = b * m.tx + d * m.ty + ty;
        return this;
    }

    /** Write the result to out: `out = this × m` (does not modify itself) */
    public multiplyTo(out: Mat3, m: Mat3Like): Mat3 {
        const { a, b, c, d, tx, ty } = this;
        out.a = a * m.a + c * m.b;
        out.b = b * m.a + d * m.b;
        out.c = a * m.c + c * m.d;
        out.d = b * m.c + d * m.d;
        out.tx = a * m.tx + c * m.ty + tx;
        out.ty = b * m.tx + d * m.ty + ty;
        return out;
    }

    /** Transform a point (including translation) */
    public transformPoint(x: number, y: number, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        return r.set(this.a * x + this.c * y + this.tx, this.b * x + this.d * y + this.ty);
    }

    /** Transform a direction (without translation) */
    public transformVector(x: number, y: number, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        return r.set(this.a * x + this.c * y, this.b * x + this.d * y);
    }

    /**
     * Invert (an affine matrix always has an inverse unless the determinant is 0).
     * Used for the reverse mapping "screen coords → world coords" (hit-testing / clicks).
     */
    public invert(): Mat3 {
        const det = this.a * this.d - this.b * this.c;
        if (det === 0) {
            // degenerate matrix: return identity, to avoid NaN propagating into the whole scene
            return Mat3.identity();
        }
        const inv = 1 / det;
        const { a, b, c, d, tx, ty } = this;
        return new Mat3(
            d * inv,
            -b * inv,
            -c * inv,
            a * inv,
            (c * ty - d * tx) * inv,
            (b * tx - a * ty) * inv,
        );
    }

    /** Effective scale of the current matrix (used for LOD / line width) */
    public getScaleX(): number {
        return Math.hypot(this.a, this.b);
    }

    public getScaleY(): number {
        return Math.hypot(this.c, this.d);
    }

    /** Effective rotation of the current matrix (radians) */
    public getRotation(): number {
        return Math.atan2(this.b, this.a);
    }

    /**
     * Convert to the 9-element column-major array for a WebGL `mat3`.
     *
     * The result can be passed straight to `gl.uniformMatrix3fv`.
     * `out` can be reused to avoid an allocation per frame (hot path).
     */
    public toMat3Array(out?: Float32Array): Float32Array {
        const arr = out ?? new Float32Array(9);
        arr[0] = this.a;
        arr[1] = this.b;
        arr[2] = 0;
        arr[3] = this.c;
        arr[4] = this.d;
        arr[5] = 0;
        arr[6] = this.tx;
        arr[7] = this.ty;
        arr[8] = 1;
        return arr;
    }

    public equals(o: Mat3Like): boolean {
        return (
            this.a === o.a && this.b === o.b && this.c === o.c && this.d === o.d && this.tx === o.tx && this.ty === o.ty
        );
    }
}
