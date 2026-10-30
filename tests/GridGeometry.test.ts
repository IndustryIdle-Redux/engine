/**
 * Grid geometry tests.
 *
 * Reference data comes from running the honeycomb library, so "same pixels as the original"
 * is verified rather than re-derived. For size=32: tile center row 0 = (27.713, 32), row step
 * 48 = 1.5R, odd/even rows staggered by 27.713 = √3R/2.
 */

import { describe, expect, it } from "vitest";
import {
    buildHexGridLines,
    buildHexGridLinesFast,
    buildSquareGridLines,
    gridLineCount,
    hexCenter,
    hexCornerOffsets,
    hexMetrics,
    linesToVertices,
} from "../src/renderer/GridGeometry";

const R = 32;
const SQRT3 = Math.sqrt(3);

describe("Pointy-top hexagon geometry (aligns with honeycomb)", () => {
    it("metrics: width=√3R, height=2R, row step=1.5R", () => {
        const m = hexMetrics(R);
        expect(m.width).toBeCloseTo(SQRT3 * R, 9);
        expect(m.height).toBeCloseTo(2 * R, 9);
        expect(m.rowStep).toBeCloseTo(1.5 * R, 9);
        expect(m.colStep).toBeCloseTo(SQRT3 * R, 9);
    });

    it("first tile center = (√3R/2, R) -- matches honeycomb's toPoint+center", () => {
        const c = hexCenter(0, 0, hexMetrics(R));
        expect(c.x).toBeCloseTo(27.713, 3);
        expect(c.y).toBeCloseTo(32, 3);
    });

    it("row step 48, odd/even rows staggered horizontally by √3R/2", () => {
        const m = hexMetrics(R);
        const r0 = hexCenter(0, 0, m);
        const r1 = hexCenter(0, 1, m);
        const r2 = hexCenter(0, 2, m);
        // Rows increase with y: honeycomb's toPoint()+center() is used directly as world coordinates.
        expect(r1.y - r0.y).toBeCloseTo(48, 9); // 1.5R
        expect(r2.y - r1.y).toBeCloseTo(48, 9);
        // Odd rows shift right by half a tile
        expect(r1.x - r0.x).toBeCloseTo(27.713, 3);
        expect(r2.x - r0.x).toBeCloseTo(0, 9);
    });

    it("corners relative to the center: ±√3R/2 left/right, ±R up/down", () => {
        const corners = hexCornerOffsets(R);
        expect(corners).toHaveLength(6);
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        expect(Math.max(...xs)).toBeCloseTo((SQRT3 * R) / 2, 9);
        expect(Math.min(...xs)).toBeCloseTo((-SQRT3 * R) / 2, 9);
        expect(Math.max(...ys)).toBeCloseTo(R, 9);
        expect(Math.min(...ys)).toBeCloseTo(-R, 9);
    });

    it("all six corners are equidistant from the center (regular hexagon)", () => {
        const corners = hexCornerOffsets(R);
        for (const c of corners) {
            expect(Math.hypot(c.x, c.y)).toBeCloseTo(R, 9);
        }
    });

    it("distance between adjacent corners = R (side length = circumradius)", () => {
        const corners = hexCornerOffsets(R);
        for (let i = 0; i < 6; i++) {
            const a = corners[i] as { x: number; y: number };
            const b = corners[(i + 1) % 6] as { x: number; y: number };
            expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(R, 9);
        }
    });
});

describe("Square grid (positions align with the original drawGrid)", () => {
    it("full map: 2×maxTile lines (deliberately excludes the last row/column boundary)", () => {
        const lines = buildSquareGridLines(10, 50);
        expect(lines).toHaveLength(20); // 10 vertical + 10 horizontal
    });

    it("line positions match the original: verticals at x = k×tileSize, horizontals at y = k×tileSize", () => {
        const tileSize = 50;
        const lines = buildSquareGridLines(5, tileSize);
        const verticals = lines.filter((l) => l.x0 === l.x1);
        const horizontals = lines.filter((l) => l.y0 === l.y1);
        expect(verticals.map((l) => l.x0)).toEqual([0, 50, 100, 150, 200]);
        expect(horizontals.map((l) => l.y0)).toEqual([0, 50, 100, 150, 200]);
    });

    it("generates the visible area only: far fewer lines than the full map", () => {
        const full = buildSquareGridLines(100, 50);
        // Only the 800×600 viewport
        const visible = buildSquareGridLines(100, 50, { x: 0, y: 0, width: 800, height: 600 });
        expect(full).toHaveLength(200);
        expect(visible.length).toBeLessThan(50);
    });
});

describe("Shared edge dedup", () => {
    it("full 10×10 map: far fewer edges than \"6 per tile\"", () => {
        const maxTile = 10;
        const naive = maxTile * maxTile * 6;
        const actual = buildHexGridLines(maxTile, R).length;
        // After dedup it should approach the theoretical value: horizontal edges like maxTile×(maxTile+1) plus diagonals
        expect(actual).toBeLessThan(naive * 0.6);
        // And it must cover every tile's edges (nothing may be under-drawn)
        expect(actual).toBeGreaterThan(maxTile * maxTile * 2);
    });

    it("an edge shared by two adjacent tiles appears only once", () => {
        const lines = buildHexGridLines(2, R);
        const seen = new Set<string>();
        for (const l of lines) {
            const a = `${l.x0.toFixed(3)},${l.y0.toFixed(3)}`;
            const b = `${l.x1.toFixed(3)},${l.y1.toFixed(3)}`;
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            expect(seen.has(key), `duplicate edge: ${key}`).toBe(false);
            seen.add(key);
        }
    });

    it("full 100×100 map: about 3 edges per tile after dedup", () => {
        const lines = buildHexGridLines(100, R);
        const perTile = lines.length / (100 * 100);
        expect(perTile).toBeGreaterThan(2.5);
        expect(perTile).toBeLessThan(3.5);
        // Far below the naive 6 edges per tile
        expect(lines.length).toBeLessThan(60000 * 0.6);
    });
});

describe("Visible-area clipping: the geometry depends only on the viewport (not on map size)", () => {
    it("for the same viewport, the visible edge counts of 50×50 and 100×100 are close", () => {
        const viewport = { x: -400, y: -300, width: 800, height: 600 };
        const small = gridLineCount("hex", 50, R, viewport);
        const large = gridLineCount("hex", 100, R, viewport);
        // The map is twice as large, but the visible edge count must not grow significantly
        expect(large).toBeLessThan(small * 1.5);
    });

    it("visible edge count is far below the full map (this is the root fix for zoom stutter)", () => {
        const full = buildHexGridLines(100, R).length;
        const visible = buildHexGridLines(100, R, { x: -400, y: -300, width: 800, height: 600 }).length;
        expect(visible).toBeLessThan(full / 10);
    });
});

describe("Vertex expansion", () => {
    it("4 floats per line segment (x0,y0,x1,y1)", () => {
        const lines = buildSquareGridLines(3, 10);
        const v = linesToVertices(lines);
        expect(v.length).toBe(lines.length * 4);
        const first = lines[0] as { x0: number; x1: number };
        expect(v[0]).toBe(first.x0);
        expect(v[2]).toBe(first.x1);
    });

    it("can reuse an external array (zero allocation on the hot path)", () => {
        const lines = buildSquareGridLines(3, 10);
        const reuse = new Float32Array(lines.length * 4);
        expect(linesToVertices(lines, reuse)).toBe(reuse);
    });
});

describe("gridLineCount", () => {
    it("hex counts come from the fast builder the renderer uses", () => {
        const visible = { x: -400, y: -300, width: 800, height: 600 };
        expect(gridLineCount("hex", 100, R, visible)).toBe(buildHexGridLinesFast(100, R, visible).length);
        expect(gridLineCount("hex", 10, R)).toBe(buildHexGridLinesFast(10, R).length);
    });

    it("square counts match the square builder", () => {
        expect(gridLineCount("square", 10, 50)).toBe(buildSquareGridLines(10, 50).length);
    });
});

describe("Vertex expansion bounds", () => {
    it("throws a clear error when the external array is too small", () => {
        const lines = buildSquareGridLines(3, 10);
        const tooSmall = new Float32Array(lines.length * 4 - 1);
        expect(() => linesToVertices(lines, tooSmall)).toThrow(/output array too small/);
    });

    it("accepts an array larger than needed", () => {
        const lines = buildSquareGridLines(3, 10);
        const larger = new Float32Array(lines.length * 4 + 8);
        expect(() => linesToVertices(lines, larger)).not.toThrow();
    });
});
