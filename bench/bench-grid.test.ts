/** Wrap the benchmark as a test and run it through vitest's TS parsing (results go to stdout) */
import { it } from "vitest";
import { buildHexGridLines, buildSquareGridLines } from "../src/renderer/GridGeometry";

const R = 32;
function bench(label: string, fn: () => unknown[], iters = 50): void {
    fn();
    fn();
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < iters; i++) n = fn().length;
    const ms = (performance.now() - t0) / iters;
    console.log(`${label.padEnd(44)} ${ms.toFixed(3).padStart(8)} ms   edges ${n}`);
}

it("grid geometry generation benchmark", () => {
    console.log("\nOriginal measured: HexagonGrid.drawGrid 100×100 full map = 13.1~15.0 ms / 10,000 strokes\n");
    bench("hex 100×100 full map (one shot)", () => buildHexGridLines(100, R));
    bench("hex 100×100 visible area 1920×1080", () => buildHexGridLines(100, R, { x: 0, y: 0, width: 1920, height: 1080 }));
    bench("hex 100×100 visible area 800×600", () => buildHexGridLines(100, R, { x: 0, y: 0, width: 800, height: 600 }));
    bench("square 100×100 full map", () => buildSquareGridLines(100, 50));
    bench("square 100×100 visible area 1920×1080", () => buildSquareGridLines(100, 50, { x: 0, y: 0, width: 1920, height: 1080 }));
});
