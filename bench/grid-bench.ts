/**
 * Pure CPU grid benchmark (no GL, and no vitest/vite dependency -- run directly with esbuild + node).
 *
 * Run: node tools/engine/bench-grid.mjs
 */
import { buildHexGridLines, buildHexGridLinesFast } from "../src/renderer/GridGeometry";

function bench(label: string, fn: () => number, iters = 40): number {
    let n = 0;
    for (let i = 0; i < 5; i++) n = fn();
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) n = fn();
    const ms = (performance.now() - t0) / iters;
    console.log(`  ${label.padEnd(38)} ${ms.toFixed(3).padStart(8)} ms   edges ${n}`);
    return ms;
}

console.log("\nOriginal measured: HexagonGrid.drawGrid 100×100 = 13.1~15.0 ms (10,000 strokes)");
console.log("(Below is pure JS geometry generation time, excluding GPU upload)\n");

/*
 * The rects use the current tile coordinate convention: `hexCenter` places tile (col,row)
 * at x = (col + odd/2)·√3·tile + √3·tile/2 and y = tile + row·1.5·tile, so a 100×100 map
 * with tile=32 spans x ∈ [27.7, 5543] and y ∈ [32, 4784] (y grows with row).
 */
const full = { x: 0, y: 0, width: 5600, height: 4800 };
bench("dedup     full map (10,000 tiles)", () => buildHexGridLines(100, 32, full).length);
bench("no-dedup  full map (10,000 tiles)", () => buildHexGridLinesFast(100, 32, full).length);

const mid = { x: 1400, y: 1600, width: 2560, height: 1600 };
bench("dedup     visible area 2560×1600", () => buildHexGridLines(100, 32, mid).length);
bench("no-dedup  visible area 2560×1600", () => buildHexGridLinesFast(100, 32, mid).length);

const near = { x: 1400, y: 1600, width: 853, height: 533 };
bench("no-dedup  visible area 853×533", () => buildHexGridLinesFast(100, 32, near).length);
