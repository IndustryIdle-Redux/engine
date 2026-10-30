/**
 * Correctness and performance of grid generation without dedup (`buildHexGridLinesFast`).
 *
 * Correctness criterion: the produced edge set must be identical to the dedup version
 * (compared edge by edge, order ignored), because one missing edge means a missing grid line
 * and one extra edge means double drawing.
 */

import { describe, expect, it } from "vitest";
import { buildHexGridLines, buildHexGridLinesFast, gridLineCount } from "../src/renderer/GridGeometry";
import type { LineSegment } from "../src/renderer/GridGeometry";

/** Normalize edges into an order-independent key set */
function edgeSet(lines: LineSegment[], precision = 3): Set<string> {
    const s = new Set<string>();
    for (const l of lines) {
        const a = `${l.x0.toFixed(precision)},${l.y0.toFixed(precision)}`;
        const b = `${l.x1.toFixed(precision)},${l.y1.toFixed(precision)}`;
        s.add(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
    return s;
}

describe("buildHexGridLinesFast matches the dedup version's edge set", () => {
    for (const [maxTile, tileSize] of [
        [2, 32],
        [3, 32],
        [5, 32],
        [10, 32],
        [7, 50],
    ] as const) {
        it(`${maxTile}×${maxTile} tile=${tileSize}: full-map edge sets are exactly identical`, () => {
            const slow = buildHexGridLines(maxTile, tileSize);
            const fast = buildHexGridLinesFast(maxTile, tileSize);
            // The fast version must not contain duplicates
            expect(fast.length).toBe(edgeSet(fast).size);
            // The edge sets must be identical
            expect([...edgeSet(fast)].sort()).toEqual([...edgeSet(slow)].sort());
        });
    }

    it("also exactly identical under visible-area clipping", () => {
        const visible = { x: -200, y: -150, width: 900, height: 700 };
        const slow = buildHexGridLines(20, 32, visible);
        const fast = buildHexGridLinesFast(20, 32, visible);
        expect(fast.length).toBe(edgeSet(fast).size);
        expect([...edgeSet(fast)].sort()).toEqual([...edgeSet(slow)].sort());
    });

    it("no duplicate edges (the same edge is never drawn twice)", () => {
        const fast = buildHexGridLinesFast(12, 32);
        expect(fast.length).toBe(edgeSet(fast).size);
    });

    it("edge count is 3×tile count + boundary extras (far below 6×tile count)", () => {
        const n = 10;
        const fast = buildHexGridLinesFast(n, 32);
        const naive = n * n * 6;
        // 3 edges per tile + about 4n boundary edges, far below 6 edges per tile
        expect(fast.length).toBeGreaterThan(3 * n * n);
        expect(fast.length).toBeLessThan(3 * n * n + 8 * n);
        expect(fast.length).toBeLessThan(naive * 0.6);
    });

    it("gridLineCount reports the fast builder's count", () => {
        const visible = { x: -200, y: -150, width: 900, height: 700 };
        expect(gridLineCount("hex", 20, 32, visible)).toBe(buildHexGridLinesFast(20, 32, visible).length);
    });
});

describe("Performance: the gain from removing string-based dedup", () => {
    it("significantly faster for a 2560×1600 visible area (the real scenario at zoom≈0.5)", () => {
        const visible = { x: 0, y: 0, width: 2560, height: 1600 };
        const bench = (fn: () => unknown[]): number => {
            fn();
            fn();
            const t0 = performance.now();
            for (let i = 0; i < 30; i++) fn();
            return (performance.now() - t0) / 30;
        };
        const slowMs = bench(() => buildHexGridLines(100, 32, visible));
        const fastMs = bench(() => buildHexGridLinesFast(100, 32, visible));
        const edges = buildHexGridLinesFast(100, 32, visible).length;
        console.log(
            `Visible-area grid generation: dedup version ${slowMs.toFixed(3)} ms → fast version ${fastMs.toFixed(3)} ms ` +
                `(${edges} edges, ${(slowMs / fastMs).toFixed(1)}× speedup)`,
        );
        // Must be significantly faster (at least 3x)
        expect(fastMs).toBeLessThan(slowMs / 3);
    });
});
