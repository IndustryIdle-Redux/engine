/**
 * Map layout: grid coordinates ↔ world coordinates for both map kinds.
 *
 * `generateWorld` (via `forEachTile`) and `GridGeometry` must use the same mapping, otherwise
 * deposits are drawn outside their tiles.
 */

import { hexCenter, hexMetrics } from "../renderer/GridGeometry";

export type GridKind = "hex" | "square";

/** Logical coordinates of one tile (the key uses exactly x,y) */
export interface TileCoord {
    x: number;
    y: number;
}

export function hexOffsetToKey(col: number, row: number): TileCoord {
    // Pointy-top honeycomb stores (column,row) in Hex.x/Hex.y, and the game's tile key is
    // exactly `${hex.x},${hex.y}`; do not convert to axial coordinates.
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
    // Traversal order must match the original tile for tile: generateWorld consumes rand()
    // per tile, so a different order changes the deposit distribution for the same seed.
    // Square grids are column-major (x outer, y inner); hex grids are row-major, matching
    // honeycomb's rectangle().
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
 * Hex positions come from `hexCenter` (aligned with honeycomb); square positions are tile
 * centers, matching `SquareGrid`'s `(x + 0.5) * tileSize, (y + 0.5) * tileSize`.
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
        // The hexagon key is the (col,row) offset coordinate itself (see `hexOffsetToKey`)
        void row;
        return hexCenter(coord.x, coord.y, hexMetrics(tileSize));
    }
    // Square: tile center, not tile corner
    void maxTile;
    return { x: (col + 0.5) * tileSize, y: (row + 0.5) * tileSize };
}

/** World coordinates → nearest tile (for hit-testing; for simplicity it scans candidate rows) */
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
