/**
 * World generation as pure data, aligned with the game's `World.generateMap`.
 *
 * Generation produces no nodes and no GPU resources. The RNG call sequence must match the
 * original: generateWorld consumes `rand()` once per resource-tile decision, so the same seed
 * yields the same deposit distribution.
 */

import { randOne, srand } from "./rng";
import { forEachTile, tileKey, tileToWorld } from "./gridLayout";
import type { GridKind, TileCoord } from "./gridLayout";

/** Map definition (a pure-data subset of the game's `IMap`) */
export interface MapSpec {
    /** Map id (the game's `D.map`) */
    id: string;
    /** Tiles per side (the game's `map.size`, 50/75/100) */
    size: number;
    /** Grid kind */
    gridType: GridKind;
    /** Tile edge length (for hex, the circumradius) */
    tileSize: number;
    /** Probability of each resource tile appearing (0~1) */
    resourceProbability: number;
    /** Deposit weight table: deposit type → weight (the game's `map.deposits`) */
    deposits: Record<string, number>;
    /** Explicit resource tiles (if given, generate only on these tiles, ignoring resourceProbability) */
    resourceTiles?: Record<string, true>;
    /** Per-tile noise value (affects deposit type selection; if omitted, the RNG value is used) */
    tileNoise?: Record<string, number>;
}

/** One generated deposit */
export interface Deposit {
    /** Tile key `"x,y"` */
    key: string;
    coord: TileCoord;
    /** Deposit type (the game's `Deposit`, in string form) */
    type: string;
    /** World coordinates (pixels) */
    x: number;
    y: number;
}

/** One placed building */
export interface BuildingPlacement {
    key: string;
    coord: TileCoord;
    /** Building type (the game's `keyof Buildings`) */
    type: string;
    x: number;
    y: number;
    /** Level (used for display) */
    level: number;
}

/** Generation result (pure data) */
export interface GeneratedWorld {
    map: MapSpec;
    seed: string;
    /** All tiles (with positions), used for overlays and hit-testing */
    tiles: Array<{ key: string; coord: TileCoord; col: number; row: number; x: number; y: number }>;
    deposits: Deposit[];
    /** World size of the map */
    worldWidth: number;
    worldHeight: number;
}

/**
 * Expand the weight table into an array, repeating each key v times in `forEach` order.
 *
 * Order matters: it is the index basis for `randOne`, so changing it changes the distribution.
 */
export function depositsToArray(deposits: Record<string, number>): string[] {
    const result: string[] = [];
    for (const k of Object.keys(deposits)) {
        const n = deposits[k] ?? 0;
        for (let i = 0; i < n; i++) result.push(k);
    }
    return result;
}

export interface GenerateOptions {
    /** Existing buildings (key → type); used to skip tiles occupied by unbuildable buildings */
    buildings?: Record<string, { type: string }>;
    /** Whether a building is buildable; when absent, no tile is skipped */
    canBuild?: (type: string) => boolean;
    /** Sandbox mode (original behavior: deposits do not follow the map, the player places them manually) */
    sandbox?: boolean;
}

/**
 * Generate the world (pure function, no side effects, no GPU, no nodes).
 */
export function generateWorld(map: MapSpec, seed: string, options: GenerateOptions = {}): GeneratedWorld {
    const rand = srand(seed);
    const depositPool = depositsToArray(map.deposits);
    const noise = map.tileNoise ?? {};
    const buildings = options.buildings ?? {};

    const tiles: GeneratedWorld["tiles"] = [];
    const deposits: Deposit[] = [];

    forEachTile(map.gridType, map.size, (coord, col, row) => {
        const key = tileKey(coord);
        const pos = tileToWorld(map.gridType, coord, col, row, map.size, map.tileSize);

        // Every tile is recorded
        tiles.push({ key, coord, col, row, x: pos.x, y: pos.y });

        // 1) Is it a resource tile?
        if (map.resourceTiles) {
            if (!map.resourceTiles[key]) return;
        } else {
            if (rand() > map.resourceProbability) return;
        }

        // 2) Existing building and not buildable → skip. Without `canBuild` nothing is skipped.
        const b = buildings[key];
        if (b && options.canBuild && !options.canBuild(b.type)) return;

        // 3) Sandbox: deposits do not follow the map
        if (options.sandbox) return;

        // 4) Deposit type (undefined only for an empty pool)
        const n = noise[key];
        const type = randOne(depositPool, () => n ?? rand());
        if (type === undefined) return;

        deposits.push({ key, coord, type, x: pos.x, y: pos.y });
    });

    // World size matches grid.getSize(): hex width has one extra half tile from the staggered
    // layout, and hex height has one extra half tile above the top row's center.
    const worldWidth = map.gridType === "hex" ? Math.sqrt(3) * map.tileSize * (map.size + 0.5) : map.size * map.tileSize;
    const worldHeight =
        map.gridType === "hex" ? map.tileSize * 1.5 * map.size + map.tileSize / 2 : map.size * map.tileSize;

    return { map, seed, tiles, deposits, worldWidth, worldHeight };
}

/** Convert the building list into world coordinates (used directly by rendering) */
export function placeBuildings(
    map: MapSpec,
    buildings: Record<string, { type: string; level?: number }>,
): BuildingPlacement[] {
    const out: BuildingPlacement[] = [];
    forEachTile(map.gridType, map.size, (coord, col, row) => {
        const key = tileKey(coord);
        const b = buildings[key];
        if (!b) return;
        const pos = tileToWorld(map.gridType, coord, col, row, map.size, map.tileSize);
        out.push({ key, coord, type: b.type, x: pos.x, y: pos.y, level: b.level ?? 1 });
    });
    return out;
}
