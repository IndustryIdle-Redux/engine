import { describe, expect, it } from "vitest";
import { Mat3 } from "../src/Mat3";
import { Vec2 } from "../src/Vec2";

describe("Mat3 basic transforms", () => {
    it("the identity matrix leaves points unchanged", () => {
        const p = Mat3.identity().transformPoint(3, 4);
        expect(p.x).toBe(3);
        expect(p.y).toBe(4);
    });

    it("translation", () => {
        const p = Mat3.translation(10, -5).transformPoint(1, 2);
        expect(p.x).toBe(11);
        expect(p.y).toBe(-3);
    });

    it("scaling", () => {
        const p = Mat3.scaling(2, 3).transformPoint(4, 5);
        expect(p.x).toBe(8);
        expect(p.y).toBe(15);
    });

    it("rotation by 90°: the +X axis maps to the +Y axis", () => {
        const p = Mat3.rotation(Math.PI / 2).transformPoint(1, 0);
        expect(p.x).toBeCloseTo(0, 10);
        expect(p.y).toBeCloseTo(1, 10);
    });

    it("transformVector ignores translation", () => {
        const v = Mat3.translation(100, 100).transformVector(1, 0);
        expect(v.x).toBe(1);
        expect(v.y).toBe(0);
    });
});

describe("Mat3 composition and order", () => {
    it("multiply semantics: the right operand is applied first", () => {
        // First scale by 2, then translate by (10,0)
        const m = new Mat3();
        Mat3.translation(10, 0).multiplyTo(m, Mat3.scaling(2));
        const p = m.transformPoint(1, 0);
        expect(p.x).toBe(12); // 1*2 + 10
        expect(p.y).toBe(0);
    });

    it("reversing the order gives a different result (proving it is not commutative)", () => {
        const a = new Mat3();
        Mat3.scaling(2).multiplyTo(a, Mat3.translation(10, 0));
        const p = a.transformPoint(1, 0);
        expect(p.x).toBe(22); // (1+10)*2
    });

    it("fromTRS is equivalent to composing translation × rotation × scale", () => {
        const x = 7;
        const y = -3;
        const rot = 0.7;
        const sx = 2;
        const sy = 3;

        const trs = Mat3.fromTRS(x, y, rot, sx, sy);

        const composed = new Mat3();
        Mat3.translation(x, y).multiplyTo(composed, Mat3.rotation(rot));
        const tmp = new Mat3();
        composed.multiplyTo(tmp, Mat3.scaling(sx, sy));

        for (const [px, py] of [
            [1, 0],
            [0, 1],
            [2.5, -4],
        ] as const) {
            const a = trs.transformPoint(px, py);
            const b = tmp.transformPoint(px, py);
            expect(a.x).toBeCloseTo(b.x, 10);
            expect(a.y).toBeCloseTo(b.y, 10);
        }
    });
});

describe("Mat3 inversion", () => {
    it("the inverse matrix restores points", () => {
        const m = Mat3.fromTRS(12, -8, 1.1, 3, 0.5);
        const inv = m.invert();
        const p = m.transformPoint(5, 9);
        const back = inv.transformPoint(p.x, p.y);
        expect(back.x).toBeCloseTo(5, 9);
        expect(back.y).toBeCloseTo(9, 9);
    });

    it("returns the identity matrix when the determinant degenerates to zero (avoiding NaN propagation)", () => {
        const degenerate = Mat3.scaling(0, 0);
        const inv = degenerate.invert();
        expect(inv.equals(Mat3.identity())).toBe(true);
    });

    it("the inverse of the inverse is the original", () => {
        const m = Mat3.fromTRS(3, 4, 0.3, 2, 2);
        const back = m.invert().invert();
        for (const k of ["a", "b", "c", "d", "tx", "ty"] as const) {
            expect(back[k]).toBeCloseTo(m[k], 9);
        }
    });
});

describe("Mat3 extra information", () => {
    it("getScale reads back the equivalent scale", () => {
        const m = Mat3.fromTRS(0, 0, 0, 2.5, 3.5);
        expect(m.getScaleX()).toBeCloseTo(2.5, 10);
        expect(m.getScaleY()).toBeCloseTo(3.5, 10);
    });

    it("getRotation reads back the equivalent rotation", () => {
        const m = Mat3.fromTRS(0, 0, 0.9, 1, 1);
        expect(m.getRotation()).toBeCloseTo(0.9, 10);
    });

    it("toMat3Array outputs 9 elements in column-major order (ready for uniformMatrix3fv)", () => {
        const m = new Mat3(1, 2, 3, 4, 5, 6);
        const arr = m.toMat3Array();
        expect(Array.from(arr)).toEqual([1, 2, 0, 3, 4, 0, 5, 6, 1]);
    });

    it("toMat3Array can reuse an external array", () => {
        const reused = new Float32Array(9);
        const out = new Mat3(1, 0, 0, 1, 2, 3).toMat3Array(reused);
        expect(out).toBe(reused);
        expect(out[6]).toBe(2);
        expect(out[7]).toBe(3);
    });
});

describe("Mat3 out parameters", () => {
    it("multiplyTo / toMat3Array reuse the objects passed in", () => {
        const out = new Mat3();
        const arr = new Float32Array(9);
        const v2 = new Vec2();
        for (let i = 0; i < 1000; i++) {
            Mat3.translation(i, i).multiplyTo(out, Mat3.scaling(2));
            out.toMat3Array(arr);
            out.transformPoint(1, 1, v2);
        }
        expect(out.tx).toBe(999);
    });
});
