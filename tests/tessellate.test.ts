import { describe, expect, it } from "vitest";
import {
    circlePath,
    dashSegment,
    regularPolygonPath,
    roundedRectPath,
    signedArea,
    strokePolyline,
    strokeSegments,
    triangulatePolygon,
} from "../src/renderer/tessellate";

/** Compute the total area of a set of triangles (used to verify tessellation coverage) */
function triangleAreaSum(v: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < v.length; i += 6) {
        const x0 = v[i] as number;
        const y0 = v[i + 1] as number;
        const x1 = v[i + 2] as number;
        const y1 = v[i + 3] as number;
        const x2 = v[i + 4] as number;
        const y2 = v[i + 5] as number;
        sum += Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2;
    }
    return sum;
}

describe("strokeSegments (grid line stroking)", () => {
    it("a single segment → 1 quad = 2 triangles = 6 vertices", () => {
        const v = strokeSegments([{ x0: 0, y0: 0, x1: 10, y1: 0 }], 2);
        expect(v.length / 2).toBe(6);
    });

    it("quad area ≈ line length × line width", () => {
        const v = strokeSegments([{ x0: 0, y0: 0, x1: 100, y1: 0 }], 4);
        expect(triangleAreaSum(v)).toBeCloseTo(100 * 4, 6);
    });

    it("zero-length segments are skipped (avoiding degenerate triangles)", () => {
        expect(strokeSegments([{ x0: 5, y0: 5, x1: 5, y1: 5 }], 2)).toHaveLength(0);
    });

    it("with a constant line width, area is proportional to the segment count", () => {
        const one = strokeSegments([{ x0: 0, y0: 0, x1: 10, y1: 0 }], 3);
        const three = strokeSegments(
            [
                { x0: 0, y0: 0, x1: 10, y1: 0 },
                { x0: 0, y0: 10, x1: 10, y1: 10 },
                { x0: 0, y0: 20, x1: 10, y1: 20 },
            ],
            3,
        );
        expect(triangleAreaSum(three)).toBeCloseTo(triangleAreaSum(one) * 3, 6);
    });

    it("a 100×100 hex grid (30,399 edges) expands to edge count × 6 vertices", () => {
        const segs = Array.from({ length: 30399 }, (_, i) => ({
            x0: i,
            y0: 0,
            x1: i + 1,
            y1: 1,
        }));
        const v = strokeSegments(segs, 1);
        expect(v.length / 2).toBe(30399 * 6);
    });
});

describe("strokePolyline (polyline stroking)", () => {
    it("two points are equivalent to a single segment", () => {
        const v = strokePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2);
        expect(v.length / 2).toBe(6);
    });

    it("open polyline: one quad per segment", () => {
        const v = strokePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], 2, false);
        expect(v.length / 2).toBe(12); // 2 segments × 6
    });

    it("closed polyline: the segment count equals the vertex count", () => {
        const v = strokePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 2, true);
        expect(v.length / 2).toBe(18); // 3 segments × 6
    });

    it("miter extension is capped by miterLimit (so a sharp corner cannot stretch indefinitely)", () => {
        // A very sharp corner
        const sharp = strokePolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 1 }], 4, false, 2);
        const maxX = Math.max(...sharp.filter((_, i) => i % 2 === 0));
        // After clamping it must not exceed the segment's own x range by much
        expect(maxX).toBeLessThan(120);
    });

    it("returns empty when there are too few points or the line width is 0", () => {
        expect(strokePolyline([{ x: 0, y: 0 }], 2)).toHaveLength(0);
        expect(strokePolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }], 0)).toHaveLength(0);
    });
});

describe("triangulatePolygon (filling)", () => {
    it("a square → 2 triangles, with the correct area", () => {
        const square = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ];
        const v = triangulatePolygon(square);
        expect(v.length / 2).toBe(6);
        expect(triangleAreaSum(v)).toBeCloseTo(100, 6);
    });

    it("any simple polygon: the sum of triangle areas = the polygon's area", () => {
        const poly = [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 55, y: 25 },
            { x: 30, y: 45 },
            { x: 0, y: 30 },
        ];
        const expected = Math.abs(signedArea(poly));
        expect(triangleAreaSum(triangulatePolygon(poly))).toBeCloseTo(expected, 6);
    });

    it("tessellates correctly with the vertex order reversed (clockwise)", () => {
        const cw = [
            { x: 0, y: 0 },
            { x: 0, y: 10 },
            { x: 10, y: 10 },
            { x: 10, y: 0 },
        ];
        expect(triangleAreaSum(triangulatePolygon(cw))).toBeCloseTo(100, 6);
    });

    it("circle approximation: the sum of triangle areas ≈ πr² (more segments, more accuracy)", () => {
        const r = 50;
        const v = triangulatePolygon(circlePath(0, 0, r, 256));
        const area = triangleAreaSum(v);
        expect(area).toBeGreaterThan(Math.PI * r * r * 0.99);
        expect(area).toBeLessThan(Math.PI * r * r * 1.01);
    });

    it("regular hexagon (tile highlight): area = (3√3/2)R²", () => {
        const R = 32;
        const v = triangulatePolygon(regularPolygonPath(0, 0, R, 6, Math.PI / 6));
        const expected = ((3 * Math.sqrt(3)) / 2) * R * R;
        expect(triangleAreaSum(v)).toBeCloseTo(expected, 4);
    });

    it("returns empty for fewer than 3 points", () => {
        expect(triangulatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toHaveLength(0);
    });
});

describe("Rounded rectangle", () => {
    it("a corner radius of 0 degenerates to 4 corner points", () => {
        expect(roundedRectPath(0, 0, 10, 10, 0)).toHaveLength(4);
    });

    it("the rounded path's area is smaller than the same-size rectangle (the corners are cut off)", () => {
        const v = triangulatePolygon(roundedRectPath(0, 0, 100, 60, 10));
        const area = triangleAreaSum(v);
        expect(area).toBeLessThan(100 * 60);
        expect(area).toBeGreaterThan(100 * 60 * 0.9);
    });

    it("the radius is clamped to half the side length (no self-intersection)", () => {
        const pts = roundedRectPath(0, 0, 20, 10, 100);
        // Every point must fall inside the rectangle's bounds
        for (const p of pts) {
            expect(p.x).toBeGreaterThanOrEqual(-1e-6);
            expect(p.x).toBeLessThanOrEqual(20 + 1e-6);
            expect(p.y).toBeGreaterThanOrEqual(-1e-6);
            expect(p.y).toBeLessThanOrEqual(10 + 1e-6);
        }
    });
});

describe("Dashed lines (replaces the cc.Graphics.prototype.dashedLine monkey patch)", () => {
    it("the total dash length ≤ the original length, and stays in bounds", () => {
        const dashes = dashSegment(0, 0, 100, 0, 10, 10);
        let total = 0;
        for (const d of dashes) {
            expect(d.x0).toBeGreaterThanOrEqual(-1e-9);
            expect(d.x1).toBeLessThanOrEqual(100 + 1e-9);
            total += d.x1 - d.x0;
        }
        expect(total).toBeLessThanOrEqual(100);
        expect(dashes.length).toBeGreaterThan(4);
    });

    it("a zero-length segment returns empty", () => {
        expect(dashSegment(3, 3, 3, 3)).toHaveLength(0);
    });
});
