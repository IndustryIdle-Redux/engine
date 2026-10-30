/**
 * Grid line geometry generation (pure functions, cacheable, unit-testable).
 *
 * Replaces `HexagonGrid.drawGrid` / `SquareGrid.drawGrid` (the original used `cc.Graphics`).
 *
 * ### How expensive the original was (measured)
 * - **square**: `2×maxTile` segments, but **each one calls `stroke()` separately** → 200 stroke calls
 * - **hex**: **each hexagon becomes its own path + a separate `stroke()`** → 10,000 stroke calls, 70,000 points
 *
 * ### The three layers of optimization here
 * 1. **Batch into a single vertex buffer**: one submit instead of per-segment `stroke()`
 * 2. **Shared-edge dedup**: for hex, each adjacent pair of edges is drawn once → from 6 per tile down to about 3 per tile
 * 3. **Generate only the visible area**: derive the row/column range from the camera viewport, so the geometry depends only on **viewport size**,
 *    not on the map's total tile count (max 100×100)
 *
 * Point 3 matters most — it makes "rebuild the grid on zoom" meaningless in the first place:
 * the visible area has at most a few thousand edges, so rebuild cost drops from 14~23 ms to sub-millisecond.
 */

import { Vec2 } from "../Vec2";

/** One line segment (world coordinates, pixels) */
export interface LineSegment {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Visible world rect */
export interface VisibleRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Build square grid lines.
 *
 * **Semantically equivalent to the original**: the original starts at `(0,0)` and draws to `maxTile` in steps of `tileSize`,
 * i.e. in the x direction from `0 .. (maxTile-1)*tileSize`, with line length `size.y`.
 * Here we additionally support generating only the visible area (when `visible` is passed),
 * so **line positions still line up exactly with the original** (locked down by unit tests).
 */
export function buildSquareGridLines(
    maxTile: number,
    tileSize: number,
    visible?: VisibleRect,
): LineSegment[] {
    const lines: LineSegment[] = [];
    // the original's range
    const worldMinX = 0;
    const worldMaxX = (maxTile - 1) * tileSize;
    const worldMinY = 0;
    const worldMaxY = (maxTile - 1) * tileSize;

    if (!visible) {
        for (let x = 0; x < maxTile; x++) {
            lines.push({ x0: x * tileSize, y0: worldMinY, x1: x * tileSize, y1: worldMaxY });
        }
        for (let y = 0; y < maxTile; y++) {
            lines.push({ x0: worldMinX, y0: y * tileSize, x1: worldMaxX, y1: y * tileSize });
        }
        return lines;
    }

    const minCol = Math.max(0, Math.floor(visible.x / tileSize));
    const maxCol = Math.min(maxTile - 1, Math.ceil((visible.x + visible.width) / tileSize));
    const minRow = Math.max(0, Math.floor(visible.y / tileSize));
    const maxRow = Math.min(maxTile - 1, Math.ceil((visible.y + visible.height) / tileSize));

    for (let x = minCol; x <= maxCol; x++) {
        lines.push({ x0: x * tileSize, y0: worldMinY, x1: x * tileSize, y1: worldMaxY });
    }
    for (let y = minRow; y <= maxRow; y++) {
        lines.push({ x0: worldMinX, y0: y * tileSize, x1: worldMaxX, y1: y * tileSize });
    }
    return lines;
}

/* ------------------------------------------------------------------ *
 * Pointy-top hexagons (consistent with the honeycomb library)
 * ------------------------------------------------------------------ */

/** Geometric constants of a pointy-top hexagon (derived from the circumradius R, matching honeycomb's corners()) */
export interface HexMetrics {
    /** circumradius (= the game's tileSize) */
    radius: number;
    /** width = √3 · R */
    width: number;
    /** height = 2R */
    height: number;
    /** row step = 1.5R */
    rowStep: number;
    /** horizontal neighbor spacing = width = √3R */
    colStep: number;
}

export function hexMetrics(tileSize: number): HexMetrics {
    return {
        radius: tileSize,
        width: Math.sqrt(3) * tileSize,
        height: 2 * tileSize,
        rowStep: 1.5 * tileSize,
        colStep: Math.sqrt(3) * tileSize,
    };
}

/**
 * The 6 corners of a pointy-top hexagon (offsets relative to the center).
 *
 * **Precisely aligned with the honeycomb library** (verified against the real library output, size=32):
 *   corners() relative to the hex origin = (55.43,16) (55.43,48) (27.71,64) (0,48) (0,16) (27.71,0)
 *   origin + center() = tile center, center() = (width/2, height/2)
 *   ⇒ corners relative to the center = (0,-R) (0,R) (-√3R/2,R/2) ... mirror relation (see below)
 *
 * Two things to note:
 *  1. honeycomb has **+y pointing down**; this engine's world coordinates have **+y pointing up**, so y is negated
 *  2. the return order stays consistent with `corners()` (starting from "top-right" and going clockwise),
 *     so the resulting polygon matches the library's `forEach` order, and so does the deduped edge set
 */
export function hexCornerOffsets(tileSize: number): Array<{ x: number; y: number }> {
    const R = tileSize;
    const halfW = (Math.sqrt(3) * R) / 2;
    const halfH = R;
    // relative to center (Y already flipped to world coordinates)
    return [
        { x: halfW, y: halfH / 2 }, // top-right
        { x: halfW, y: -halfH / 2 }, // bottom-right
        { x: 0, y: -halfH }, // bottom
        { x: -halfW, y: -halfH / 2 }, // bottom-left
        { x: -halfW, y: halfH / 2 }, // top-left
        { x: 0, y: halfH }, // top
    ];
}

/**
 * Grid coordinates (column col, row row) → world center coordinates. **Matches honeycomb's `toPoint()+center()` value by value**.
 *
 * Measured baseline (size=32, running the original repo's `ui/Lib/honeycomb.js` directly):
 * ```
 *   key "0,1" → ( 55.43,  80.00)
 *   key "1,2" → ( 83.14, 128.00)
 *   key "2,2" → (138.56, 128.00)
 * ```
 * ⇒ `x = √3R·(col + 0.5·(row&1)) + √3R/2`, `y = 1.5R·row + R`
 * (row step 48 = 1.5R, odd/even rows offset horizontally by 27.713 = √3R/2)
 *
 * ⚠️ **y used to be written as `m.height/2 - row*m.rowStep`** (i.e. y negated), on the grounds that
 * "honeycomb's +y points down, this engine's +y points up" — **that reasoning does not hold**:
 * the original used honeycomb's `toPoint()+center()` directly as Cocos world coordinates
 * (`CoreGame/HexagonGrid.ts:29-33`), and this engine's camera also has +y pointing up
 * (`Camera2D`), with no second flip to cancel it out. The result was **the whole hexagon map mirrored vertically**.
 */
export function hexCenter(col: number, row: number, m: HexMetrics): { x: number; y: number } {
    const x = (col + (row & 1 ? 0.5 : 0)) * m.colStep + m.width / 2;
    const y = m.height / 2 + row * m.rowStep;
    return { x, y };
}

/** Position quantization key (used for shared-edge dedup; 1e-3 precision is enough to tell distinct corners apart) */
function pointKey(x: number, y: number): string {
    return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

/**
 * Build pointy-top hexagon grid lines with **shared edges drawn only once**.
 *
 * @param maxTile tiles per side (the original's `maxTile`)
 * @param tileSize circumradius (the original's `tileSize`)
 * @param visible generate grid lines only inside this world rect (omit to generate the whole map)
 */
export function buildHexGridLines(maxTile: number, tileSize: number, visible?: VisibleRect): LineSegment[] {
    const m = hexMetrics(tileSize);

    // Compute the row/column range to generate
    let minCol = 0;
    let maxCol = maxTile - 1;
    let minRow = 0;
    let maxRow = maxTile - 1;

    if (visible) {
        // Derive rows/cols from the visible rect (with a 1-tile margin, so edge lines are not missing)
        // row: y = -row * rowStep  ⇒  row = -y / rowStep
        // Inverse of `hexCenter`'s `y = height/2 + row*rowStep`:
        // row = (worldY - height/2) / rowStep. This was once estimated from "y decreases with row",
        // so after fixing y this had to change with it, otherwise visible-area culling picks the wrong rows and the edge sets do not match.
        minRow = Math.max(0, Math.floor((visible.y - m.height / 2) / m.rowStep) - 1);
        maxRow = Math.min(maxTile - 1, Math.ceil((visible.y + visible.height - m.height / 2) / m.rowStep) + 1);
        minCol = Math.max(0, Math.floor(visible.x / m.colStep) - 1);
        maxCol = Math.min(maxTile - 1, Math.ceil((visible.x + visible.width) / m.colStep) + 1);
    }

    const seen = new Set<string>();
    const lines: LineSegment[] = [];
    const corners = hexCornerOffsets(tileSize);

    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            const c = hexCenter(col, row, m);
            for (let i = 0; i < 6; i++) {
                const a = corners[i] as { x: number; y: number };
                const b = corners[(i + 1) % 6] as { x: number; y: number };
                const ax = c.x + a.x;
                const ay = c.y + a.y;
                const bx = c.x + b.x;
                const by = c.y + b.y;

                // Undirected-edge dedup: sort the two endpoints' canonical keys and use that as the unique id
                const ka = pointKey(ax, ay);
                const kb = pointKey(bx, by);
                const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
                if (seen.has(edgeKey)) continue;
                seen.add(edgeKey);

                lines.push({ x0: ax, y0: ay, x1: bx, y1: by });
            }
        }
    }
    return lines;
}

/**
 * Hexagon grid line generation without dedup (**recommended**).
 *
 * ### Why it is needed
 * `buildHexGridLines` uses "quantize both edge endpoints into string keys + a Set for dedup".
 * Measured with a fairly large visible area (zoom 0.5 → 2560×1600 world pixels, 5,723 edges) it took **2.99 ms**,
 * becoming the biggest cost in the whole frame — building and hashing string keys is far more expensive than the geometry itself.
 *
 * ### Key insight
 * Every edge is shared by exactly **two adjacent tiles**. If each tile emits only the 3 edges "it owns", and
 * boundary tiles additionally emit the edges whose "neighbor does not exist", we get a duplicate-free edge set with **one pass and zero dedup**.
 *
 * Edge-to-neighbor mapping (pointy-top hexagon, corner order in `hexCornerOffsets`):
 *
 * | Edge | Corners | Shared neighbor |
 * |------|---------|-----------------|
 * | E0   | 0→1     | east            |
 * | E1   | 1→2     | southeast       |
 * | E2   | 2→3     | southwest       |
 * | E3   | 3→4     | west            |
 * | E4   | 4→5     | northwest       |
 * | E5   | 5→0     | northeast       |
 *
 * This implementation lets each tile own **E0 / E4 / E5** (east, northwest, northeast),
 * and the other three are emitted when the corresponding neighbor is missing.
 */
export function buildHexGridLinesFast(
    maxTile: number,
    tileSize: number,
    visible?: VisibleRect,
): LineSegment[] {
    const m = hexMetrics(tileSize);
    const corners = hexCornerOffsets(tileSize);
    const lines: LineSegment[] = [];

    let minCol = 0;
    let maxCol = maxTile - 1;
    let minRow = 0;
    let maxRow = maxTile - 1;
    if (visible) {
        // Inverse of `hexCenter`'s `y = height/2 + row*rowStep` (same as `buildHexGridLines`)
        minRow = Math.max(0, Math.floor((visible.y - m.height / 2) / m.rowStep) - 1);
        maxRow = Math.min(maxTile - 1, Math.ceil((visible.y + visible.height - m.height / 2) / m.rowStep) + 1);
        minCol = Math.max(0, Math.floor(visible.x / m.colStep) - 1);
        maxCol = Math.min(maxTile - 1, Math.ceil((visible.x + visible.width) / m.colStep) + 1);
    }

    /** Append one tile's edge i→i+1 */
    const push = (cx: number, cy: number, i: number): void => {
        const a = corners[i] as { x: number; y: number };
        const b = corners[(i + 1) % 6] as { x: number; y: number };
        lines.push({ x0: cx + a.x, y0: cy + a.y, x1: cx + b.x, y1: cy + b.y });
    };

    // ⚠️ Deciding "does the neighbor exist" must be against **the tile range being processed**, not the whole map.
    // Using the whole map makes the visible area's left/bottom boundary **drop edges**: when a neighbor is inside the map but outside the visible area,
    // it is never processed, so it never emits that shared edge, while this tile assumes the neighbor will.
    // (This bug was caught by the "visible-area culling edge sets match" case in `tests/GridGeometryFast.test.ts`.)
    const inRange = (c: number, r: number): boolean =>
        c >= minCol && c <= maxCol && r >= minRow && r <= maxRow;

    for (let row = minRow; row <= maxRow; row++) {
        const odd = (row & 1) === 1;
        for (let col = minCol; col <= maxCol; col++) {
            const c = hexCenter(col, row, m);
            // Edges this tile owns: east (E0), northeast (E5), northwest (E4)
            push(c.x, c.y, 0);
            push(c.x, c.y, 5);
            push(c.x, c.y, 4);

            // Emit the outer edges when the neighbor is missing (otherwise the grid's outermost boundary loses lines)
            //
            // ⚠️ The southwest/southeast neighbors are in **row - 1** (not row + 1):
            // this tile owns east (E0) / northwest (E4) / northeast (E5), so southwest (E2) / southeast (E1)
            // are emitted by the tile **one row below** in its "northwest/northeast" capacity;
            // this tile only emits them when that neighbor **does not exist**.
            // This used to be written as `row + 1`, which was correct back when y **decreased** with row;
            // after fixing `hexCenter`'s y direction (to match the original honeycomb) it is backwards,
            // and the symptom is **a flood of duplicate edges** (caught by the edge-set consistency case in `GridGeometryFast`).
            if (!inRange(col - 1, row)) push(c.x, c.y, 3); // west
            const swCol = odd ? col : col - 1;
            if (!inRange(swCol, row - 1)) push(c.x, c.y, 2); // southwest
            const seCol = odd ? col + 1 : col;
            if (!inRange(seCol, row - 1)) push(c.x, c.y, 1); // southeast
        }
    }
    return lines;
}

/** Estimate the line segment count (for perf assertions and debugging) */
export function gridLineCount(
    kind: "square" | "hex",
    maxTile: number,
    tileSize: number,
    visible?: VisibleRect,
): number {
    return kind === "square"
        ? buildSquareGridLines(maxTile, tileSize, visible).length
        : buildHexGridLines(maxTile, tileSize, visible).length;
}

/** Expand line segments into a vertex array (for instancing / triangle submission) */
export function linesToVertices(lines: LineSegment[], out?: Float32Array): Float32Array {
    const arr = out ?? new Float32Array(lines.length * 4);
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i] as LineSegment;
        arr[i * 4 + 0] = l.x0;
        arr[i * 4 + 1] = l.y0;
        arr[i * 4 + 2] = l.x1;
        arr[i * 4 + 3] = l.y1;
    }
    return arr;
}

/** Convenience: turn line segments into Vec2 endpoint pairs (a few callers need the object form) */
export function lineEndpoints(lines: LineSegment[]): Array<[Vec2, Vec2]> {
    return lines.map((l) => [new Vec2(l.x0, l.y0), new Vec2(l.x1, l.y1)]);
}
