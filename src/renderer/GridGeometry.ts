/**
 * Grid line geometry generation (pure, cacheable).
 *
 * Both builders return line segments in world pixels. An optional visible rect restricts the
 * generated range so the output depends on viewport size rather than map size.
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
 * Lines run at multiples of `tileSize` from 0 to `(maxTile-1)*tileSize`, i.e. `maxTile` lines
 * per axis. The final row/column boundary is deliberately not drawn, matching the vanilla
 * renderer; tests lock this behavior down.
 */
export function buildSquareGridLines(
    maxTile: number,
    tileSize: number,
    visible?: VisibleRect,
): LineSegment[] {
    const lines: LineSegment[] = [];
    // line positions run over 0 .. (maxTile-1)*tileSize
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

/** Geometric constants of a pointy-top hexagon (derived from the circumradius R) */
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
 * The 6 corners of a pointy-top hexagon, relative to its center.
 *
 * honeycomb has +y downward while world coordinates have +y upward, so y is negated. The
 * order matches honeycomb's `corners()` (top-right, clockwise) so the shared edge set matches.
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
 * Grid coordinates (col, row) → world center coordinates, matching honeycomb's
 * `toPoint() + center()`: `x = √3R·(col + 0.5·(row&1)) + √3R/2`, `y = 1.5R·row + R`.
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
 * Build pointy-top hexagon grid lines with shared edges drawn only once.
 *
 * @param maxTile tiles per side
 * @param tileSize circumradius
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
        // Inverse of hexCenter's `y = height/2 + row*rowStep`, with a one-tile margin
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
 * Hexagon grid line generation without dedup.
 *
 * Every edge is shared by two adjacent tiles. Each tile emits the three edges it owns
 * (east E0, northeast E5, northwest E4); the remaining three are emitted only when the
 * corresponding neighbor is outside the processed range. One pass, no hashing.
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
        // Inverse of hexCenter's `y = height/2 + row*rowStep` (same as buildHexGridLines)
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

    // Neighbor existence is checked against the processed range, not the whole map: a neighbor
    // inside the map but outside the visible range never emits its shared edge.
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

            // The west/southwest/southeast neighbors are emitted by other tiles; this tile only
            // draws them when that neighbor is missing, so the map boundary keeps its lines.
            // Southwest/southeast live in row - 1 (they see this tile as northeast/northwest).
            if (!inRange(col - 1, row)) push(c.x, c.y, 3); // west
            const swCol = odd ? col : col - 1;
            if (!inRange(swCol, row - 1)) push(c.x, c.y, 2); // southwest
            const seCol = odd ? col + 1 : col;
            if (!inRange(seCol, row - 1)) push(c.x, c.y, 1); // southeast
        }
    }
    return lines;
}

/** Count the line segments the renderer would build for the same parameters. */
export function gridLineCount(
    kind: "square" | "hex",
    maxTile: number,
    tileSize: number,
    visible?: VisibleRect,
): number {
    return kind === "square"
        ? buildSquareGridLines(maxTile, tileSize, visible).length
        : buildHexGridLinesFast(maxTile, tileSize, visible).length;
}

/** Expand line segments into a [x0,y0,x1,y1,...] vertex array. Throws if `out` is too small. */
export function linesToVertices(lines: LineSegment[], out?: Float32Array): Float32Array {
    const needed = lines.length * 4;
    if (out !== undefined && out.length < needed) {
        throw new Error(`[grid] linesToVertices: output array too small (need ${needed}, got ${out.length})`);
    }
    const arr = out ?? new Float32Array(needed);
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
