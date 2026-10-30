/**
 * Map layout -- grid coordinates ↔ world coordinates, covering both map kinds.
 *
 * This is the shared basis of `World.generateMap` (`Grid.forEach`) and `GridGeometry`:
 * the former decides **each tile's key and position**, the latter decides the **grid lines**. Both must use the same mapping,
 * otherwise deposits get drawn outside their tiles.
 *
 * Alignment evidence:
 *  - Hexagon: `HexagonGrid` uses honeycomb's `rectangle({width,height})`,
 *    tile key = `"${hex.x},${hex.y}"` (axial coordinates, not row/column), position = `toPoint() + center()`
 *  - Square: `SquareGrid` uses `x ∈ [0, maxTile)`, position = `(x*tileSize, y*tileSize)`
 */

import { hexCenter, hexMetrics } from "../renderer/GridGeometry";

export type GridKind = "hex" | "square";

/** Logical coordinates of one tile (the key uses exactly x,y) */
export interface TileCoord {
    x: number;
    y: number;
}

export function hexOffsetToKey(col: number, row: number): TileCoord {
    // ⚠️ **This is the offset coordinate itself, do not convert it to axial**.
    //
    // For pointy-top hexagons, honeycomb's `Hex.x` / `Hex.y` are exactly the **(column, row)** offset coordinates
    // (measured: the key set of `rectangle({width:4,height:4})` is the regular `{0..3}×{0..3}`),
    // and the original `CoreGame/HexagonGrid.ts:31`'s `gridToString(hex)` = `` `${hex.x},${hex.y}` ``
    // is exactly what it returns.
    //
    // This used to be written as `{ x: col - Math.floor(row / 2), y: row }` (**axial q**),
    // so for row ≥ 2 the engine key and the game key pointed at **different tiles**:
    // building rendering (`view.tilePosition(key)`), hit-testing, connection lines and transport distance were all shifted by
    // `floor(row/2)` columns.
    return { x: col, y: row };
}

/** Square: use row/column directly */
export function squareOffsetToAxial(col: number, row: number): TileCoord {
    return { x: col, y: row };
}

/** Visit every tile of the whole map (order matches the game: row by row, column by column) */
export function forEachTile(
    kind: GridKind,
    maxTile: number,
    visit: (coord: TileCoord, col: number, row: number) => void,
): void {
    // ⚠️ The traversal order **must match the original tile for tile** -- but **hexagons and squares use different orders**!
    //
    // In `generateWorld`, `rand()` is **consumed tile by tile**
    // (`if (rand() > map.resourceProbability) return;`),
    // so change the order and, for the same `D.seed`, a different set of tiles passes the filter →
    // **deposit distribution differs from the original → saves are incompatible**. There are two independent sources here; do not assume they unify:
    //
    // · **Square**: the original `CoreGame/SquareGrid.ts:13-17` is
    //     for (x...) for (y...)      → x outer / y inner (**column-major**)
    //   (`Grid.forEach` uses `for...in`, and keys contain a comma ⇒ V8 preserves insertion order)
    // · **Hexagon**: the order is decided by honeycomb's `rectangle()`; in practice it runs
    //     second(r) outer / first(q) inner → **row-major** (axial q increasing)
    //   see the test case in `tests/worldgen.test.ts` whose "baseline comes from actually running honeycomb".
    if (kind === "hex") {
        for (let row = 0; row < maxTile; row++) {
            for (let col = 0; col < maxTile; col++) {
                visit(hexOffsetToKey(col, row), col, row);
            }
        }
    } else {
        for (let x = 0; x < maxTile; x++) {
            for (let y = 0; y < maxTile; y++) {
                visit(squareOffsetToAxial(x, y), x, y);
            }
        }
    }
}

/** Tile key (matches the game's `gridToString`: `"x,y"`) */
export function tileKey(coord: TileCoord): string {
    return `${coord.x},${coord.y}`;
}

/** key → coordinates (matches the game's `stringToGrid`) */
export function parseTileKey(key: string): TileCoord {
    const parts = key.split(",");
    return { x: parseInt(parts[0] as string, 10), y: parseInt(parts[1] as string, 10) };
}

/**
 * Grid coordinates → world coordinates (pixels).
 *
 * Each map kind's mapping aligns with the original:
 *  - hex: `hexCenter` (aligns with honeycomb)
 *  - square: in `World`, a square tile is positioned at `col*tileSize`, `(maxTile - row)*tileSize`
 *    (the original square map puts the world origin at the bottom-left, with the Y axis pointing up)
 */
export function tileToWorld(
    kind: GridKind,
    coord: TileCoord,
    col: number,
    row: number,
    maxTile: number,
    tileSize: number,
): { x: number; y: number } {
    if (kind === "hex") {
        // The hexagon key is the (col,row) offset coordinate itself (see `hexOffsetToKey`), so it can be used directly
        void row;
        return hexCenter(coord.x, coord.y, hexMetrics(tileSize));
    }
    // Square: the **tile center**, not the tile corner
    //
    // The original `SquareGrid`'s centers are:
    //   `centers[`${x},${y}`] = cc.v3((x + 0.5) * tileSize, (y + 0.5) * tileSize)`
    // i.e. the coordinate maps directly to the world position (no Y flip) and lands on the **tile center**.
    //
    // ⚠️ This used to be written as `(col * tileSize, (maxTile - row) * tileSize)`:
    //   it treated the tile center as the tile corner (half a tile off) and flipped everything vertically (~maxTile tiles off),
    //   with a measured deviation of up to 4975px (≈100 tiles). Fixed, and locked down by unit tests.
    void maxTile;
    return { x: (col + 0.5) * tileSize, y: (row + 0.5) * tileSize };
}

/** World coordinates → nearest tile (for hit-testing; for simplicity it scans candidate rows, O(1) rows) */
export function worldToTile(
    kind: GridKind,
    worldX: number,
    worldY: number,
    maxTile: number,
    tileSize: number,
): { coord: TileCoord; col: number; row: number } | null {
    if (kind === "square") {
        // Inverse of `tileToWorld`: center = (x+0.5)*tile, hence x = floor(worldX / tile)
        const col = Math.floor(worldX / tileSize);
        const row = Math.floor(worldY / tileSize);
        if (col < 0 || col >= maxTile || row < 0 || row >= maxTile) return null;
        return { coord: squareOffsetToAxial(col, row), col, row };
    }

    // Hexagon: estimate the row first, then search the candidate rows for the nearest tile center
    const m = hexMetrics(tileSize);
    // Inverse of `hexCenter`: y = height/2 + row*rowStep ⇒ row = (y - height/2) / rowStep
    const estRow = Math.round((worldY - m.height / 2) / m.rowStep);
    let best: { coord: TileCoord; col: number; row: number; d: number } | null = null;
    for (let row = Math.max(0, estRow - 2); row <= Math.min(maxTile - 1, estRow + 2); row++) {
        const colBase = Math.round((worldX - m.width / 2 - (row & 1 ? m.colStep / 2 : 0)) / m.colStep);
        for (let col = Math.max(0, colBase - 2); col <= Math.min(maxTile - 1, colBase + 2); col++) {
            const c = hexCenter(col, row, m);
            const d = (c.x - worldX) ** 2 + (c.y - worldY) ** 2;
            if (!best || d < best.d) {
                best = { coord: hexOffsetToKey(col, row), col, row, d };
            }
        }
    }
    if (!best) return null;
    // Beyond one tile radius counts as empty space
    if (best.d > (tileSize * 1.2) ** 2) return null;
    return { coord: best.coord, col: best.col, row: best.row };
}
