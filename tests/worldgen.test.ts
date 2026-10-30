/**
 * World generation tests.
 *
 * The deposit distribution must match the original for the same seed and map, otherwise the
 * resources players see change. Reference data comes from:
 *  - RNG: the same xmur3+sfc32 implementation as `Helper.ts`
 *  - iteration order: actually running the honeycomb library
 *  - generation rules: aligned with `World.generateMap` item by item
 */

import { describe, expect, it } from "vitest";
import { randOne, srand, xmur3 } from "../src/worldgen/rng";
import { forEachTile, hexOffsetToKey, tileKey, tileToWorld, worldToTile } from "../src/worldgen/gridLayout";
import { depositsToArray, generateWorld, placeBuildings } from "../src/worldgen/generateWorld";
import type { MapSpec } from "../src/worldgen/generateWorld";
import { hexCenter, hexCornerOffsets, hexMetrics } from "../src/renderer/GridGeometry";

/** Bounding size of all hex tile corners, in world pixels. */
function hexWorldExtents(size: number, tileSize: number): { width: number; height: number } {
    const m = hexMetrics(tileSize);
    const corners = hexCornerOffsets(tileSize);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    forEachTile("hex", size, (_coord, col, row) => {
        const c = hexCenter(col, row, m);
        for (const corner of corners) {
            minX = Math.min(minX, c.x + corner.x);
            maxX = Math.max(maxX, c.x + corner.x);
            minY = Math.min(minY, c.y + corner.y);
            maxY = Math.max(maxY, c.y + corner.y);
        }
    });
    return { width: maxX - minX, height: maxY - minY };
}

/* ------------------------------------------------------------------ *
 * RNG: bit-for-bit identical to the game's Helper.ts
 * ------------------------------------------------------------------ */

/** Reimplement the game's original implementation independently inside the test, for comparison */
function gameSrand(s: string): () => number {
    let h = 1779033703 ^ s.length;
    const xmur3Next = (): number => {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        h = (h ^= h >>> 16) >>> 0;
        return h;
    };
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = xmur3Next();
    let b = xmur3Next();
    let c = xmur3Next();
    let d = xmur3Next();
    return () => {
        a |= 0;
        b |= 0;
        c |= 0;
        d |= 0;
        const t = (((a + b) | 0) + d) | 0;
        d = (d + 1) | 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) | 0;
        c = (c << 21) | (c >>> 11);
        c = (c + t) | 0;
        return (t >>> 0) / 4294967296;
    };
}

describe("RNG is bit-for-bit identical to the original", () => {
    it("xmur3 output sequence is identical", () => {
        const mine = xmur3("industry-idle");
        const ref = (() => {
            let h = 1779033703 ^ "industry-idle".length;
            for (let i = 0; i < "industry-idle".length; i++) {
                h = Math.imul(h ^ "industry-idle".charCodeAt(i), 3432918353);
                h = (h << 13) | (h >>> 19);
            }
            return () => {
                h = Math.imul(h ^ (h >>> 16), 2246822507);
                h = Math.imul(h ^ (h >>> 13), 3266489909);
                h = (h ^= h >>> 16) >>> 0;
                return h;
            };
        })();
        for (let i = 0; i < 20; i++) expect(mine()).toBe(ref());
    });

    it("srand sequence is identical (1000 numbers, bit for bit)", () => {
        const mine = srand("abc-123");
        const ref = gameSrand("abc-123");
        for (let i = 0; i < 1000; i++) {
            expect(mine()).toBe(ref());
        }
    });

    it("randOne picks the same index (floor(len*rnd))", () => {
        const arr = ["a", "b", "c", "d"];
        let s = 0;
        const rnd = (): number => (s += 0.13) % 1;
        const mine = randOne(arr, rnd);
        expect(mine).toBeDefined();
        expect(arr.indexOf(mine as string)).toBe(Math.floor(arr.length * ((0 + 0.13) % 1)));
    });

    it("randOne returns undefined for an empty array", () => {
        expect(randOne([], () => 0)).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ *
 * Iteration order: aligned with the real honeycomb output
 * ------------------------------------------------------------------ */

describe("Grid iteration order (reference from actually running honeycomb)", () => {
    it("the key sequence of a 4×3 hex grid is exactly the same as honeycomb's", () => {
        // honeycomb's rectangle({width:4,height:3}).forEach yields the plain offset keys
        // "0,0 1,0 2,0 3,0 0,1 1,1 2,1 3,1 0,2 1,2 2,2 3,2".
        const expected = ["0,0", "1,0", "2,0", "3,0", "0,1", "1,1", "2,1", "3,1", "0,2", "1,2", "2,2", "3,2"];
        // forEachTile uses maxTile for both width and height; only the first 3 rows are taken here to match 4×3
        const filtered: string[] = [];
        forEachTile("hex", 4, (coord, _col, row) => {
            if (row < 3) filtered.push(tileKey(coord));
        });
        expect(filtered).toEqual(expected);
    });

    it("key = offset coordinate (col,row) (honeycomb's hex.x/hex.y)", () => {
        // For a pointy-top hexagon, honeycomb's Hex.x/y is (column, row), not axial q,r.
        expect(hexOffsetToKey(0, 0)).toEqual({ x: 0, y: 0 });
        expect(hexOffsetToKey(3, 0)).toEqual({ x: 3, y: 0 });
        expect(hexOffsetToKey(0, 1)).toEqual({ x: 0, y: 1 });
        expect(hexOffsetToKey(0, 2)).toEqual({ x: 0, y: 2 });
        expect(hexOffsetToKey(3, 2)).toEqual({ x: 3, y: 2 });
    });

    it("square grid order is column-major (aligning with the original `SquareGrid`)", () => {
        // The original iterates x outer / y inner, so keys are "0,0","0,1","1,0","1,1".
        // Order matters: generateWorld consumes rand() tile by tile, so a different order
        // changes the deposit distribution for the same seed.
        const seq: string[] = [];
        forEachTile("square", 2, (coord) => seq.push(tileKey(coord)));
        expect(seq).toEqual(["0,0", "0,1", "1,0", "1,1"]);
    });
});

/* ------------------------------------------------------------------ *
 * Position mapping
 * ------------------------------------------------------------------ */

describe("Tile → world coordinates", () => {
    it("the first hex tile's center matches honeycomb's toPoint+center", () => {
        const p = tileToWorld("hex", { x: 0, y: 0 }, 0, 0, 10, 32);
        expect(p.x).toBeCloseTo(27.713, 3);
        expect(p.y).toBeCloseTo(32, 3);
    });

    it("the first tile of hex row 1 is positioned correctly (aligned with honeycomb output)", () => {
        // size=32, key "0,1" → (55.43, 80): odd rows shift right by √3R/2, y = R + 1.5R.
        const p = tileToWorld("hex", { x: 0, y: 1 }, 0, 1, 10, 32);
        expect(p.x).toBeCloseTo(27.713 + 27.713, 3);
        expect(p.y).toBeCloseTo(32 + 48, 3);
    });

    it("square: tile center = ((col+0.5)*tile, (row+0.5)*tile) (aligning with the original SquareGrid)", () => {
        // Original: centers[`${x},${y}`] = cc.v3((x + 0.5) * tileSize, (y + 0.5) * tileSize)
        expect(tileToWorld("square", { x: 2, y: 0 }, 2, 0, 10, 50)).toEqual({ x: 125, y: 25 });
        expect(tileToWorld("square", { x: 2, y: 9 }, 2, 9, 10, 50)).toEqual({ x: 125, y: 475 });
    });

    it("square coordinates are not Y-flipped and land at tile centers", () => {
        const maxTile = 100;
        const tile = 50;
        const row0 = tileToWorld("square", { x: 0, y: 0 }, 0, 0, maxTile, tile);
        const row1 = tileToWorld("square", { x: 0, y: 1 }, 0, 1, maxTile, tile);

        // 1) It must be the tile center (not the corner): both x and y carry a 0.5 offset
        expect(row0.x).toBe(25);
        expect(row0.y).toBe(25);

        // 2) A larger row number → a larger y (no flip)
        expect(row1.y).toBeGreaterThan(row0.y);
        expect(row1.y - row0.y).toBe(tile);

        // 3) The last row is still inside the grid
        const last = tileToWorld("square", { x: 99, y: 99 }, 99, 99, maxTile, tile);
        expect(last.x).toBe(4975);
        expect(last.y).toBe(4975);
        expect(last.y).toBeLessThan(maxTile * tile);
    });

    it("worldToTile is the inverse of tileToWorld (hexagon)", () => {
        for (const [col, row] of [
            [0, 0],
            [5, 3],
            [9, 9],
        ] as const) {
            const coord = hexOffsetToKey(col, row);
            const p = tileToWorld("hex", coord, col, row, 10, 32);
            const back = worldToTile("hex", p.x, p.y, 10, 32);
            expect(back?.col, `col=${col} row=${row}`).toBe(col);
            expect(back?.row, `col=${col} row=${row}`).toBe(row);
        }
    });

    it("worldToTile is the inverse of tileToWorld (square)", () => {
        for (const [col, row] of [
            [0, 0],
            [5, 4],
            [9, 9],
        ] as const) {
            const p = tileToWorld("square", { x: col, y: row }, col, row, 10, 50);
            const back = worldToTile("square", p.x, p.y, 10, 50);
            expect(back?.col).toBe(col);
            expect(back?.row).toBe(row);
        }
    });

    it("worldToTile returns null for points far from the grid", () => {
        expect(worldToTile("hex", 1e6, 1e6, 10, 32)).toBeNull();
        expect(worldToTile("square", -100, -100, 10, 50)).toBeNull();
    });
});

/* ------------------------------------------------------------------ *
 * Deposit generation
 * ------------------------------------------------------------------ */

const TEST_MAP: MapSpec = {
    id: "Test",
    size: 20,
    gridType: "hex",
    tileSize: 32,
    resourceProbability: 0.25,
    deposits: { Water: 2, Coal: 3, Fe: 1 },
};

describe("Deposit pool expansion (aligns with depositsToArray)", () => {
    it("repeats by weight, in the same order as the keys", () => {
        expect(depositsToArray({ Water: 2, Coal: 3, Fe: 1 })).toEqual([
            "Water",
            "Water",
            "Coal",
            "Coal",
            "Coal",
            "Fe",
        ]);
    });

    it("a deposit with weight 0 does not enter the pool", () => {
        expect(depositsToArray({ Water: 0, Coal: 1 })).toEqual(["Coal"]);
    });
});

describe("World generation", () => {
    it("determinism: two generations with the same seed are exactly identical", () => {
        const a = generateWorld(TEST_MAP, "seed-1");
        const b = generateWorld(TEST_MAP, "seed-1");
        expect(a.deposits.length).toBe(b.deposits.length);
        expect(a.deposits.map((d) => `${d.key}:${d.type}`)).toEqual(b.deposits.map((d) => `${d.key}:${d.type}`));
    });

    it("different seeds produce different distributions", () => {
        const a = generateWorld(TEST_MAP, "seed-1");
        const b = generateWorld(TEST_MAP, "seed-2");
        expect(a.deposits.map((d) => d.key)).not.toEqual(b.deposits.map((d) => d.key));
    });

    it("every tile is recorded (including tiles without deposits)", () => {
        const w = generateWorld(TEST_MAP, "seed-1");
        expect(w.tiles).toHaveLength(20 * 20);
    });

    it("the deposit count is roughly tile count × probability (statistically)", () => {
        const w = generateWorld({ ...TEST_MAP, size: 100 }, "stat-seed");
        const ratio = w.deposits.length / (100 * 100);
        // At a probability of 0.25 it should fall in a reasonable range
        expect(ratio).toBeGreaterThan(0.2);
        expect(ratio).toBeLessThan(0.3);
    });

    it("deposit types come only from the pool", () => {
        const w = generateWorld(TEST_MAP, "seed-1");
        for (const d of w.deposits) {
            expect(["Water", "Coal", "Fe"]).toContain(d.type);
        }
    });

    it("when resourceTiles is given, probability is ignored and deposits are generated only on the specified tiles", () => {
        const w = generateWorld(
            { ...TEST_MAP, resourceTiles: { "0,0": true, "3,0": true } },
            "seed-x",
        );
        expect(w.deposits).toHaveLength(2);
        expect(w.deposits.map((d) => d.key).sort()).toEqual(["0,0", "3,0"]);
    });

    it("tileNoise determines the deposit type (overriding the RNG)", () => {
        // Tiles must be specified via resourceTiles: otherwise the resourceProbability sampling consumes RNG
        // and may skip the tile outright, so tileNoise never gets a chance to take effect.
        const w = generateWorld(
            { ...TEST_MAP, resourceTiles: { "0,0": true, "1,0": true }, tileNoise: { "0,0": 0.99, "1,0": 0 } },
            "noise-seed",
        );
        const byKey = new Map(w.deposits.map((d) => [d.key, d.type]));
        expect(byKey.get("1,0")).toBe("Water"); // noise=0 → first item in the pool
        expect(byKey.get("0,0")).toBe("Fe"); // noise=0.99 → last item in the pool
    });

    it("no deposits are generated in sandbox mode", () => {
        const w = generateWorld(TEST_MAP, "seed-1", { sandbox: true });
        expect(w.deposits).toHaveLength(0);
        expect(w.tiles).toHaveLength(20 * 20);
    });

    it("a tile occupied by a building that cannot be built on is skipped", () => {
        const withBuilding = generateWorld(
            { ...TEST_MAP, resourceTiles: { "0,0": true, "1,0": true } },
            "seed-x",
            { buildings: { "0,0": { type: "HQ" } }, canBuild: () => false },
        );
        expect(withBuilding.deposits.map((d) => d.key)).toEqual(["1,0"]);
    });

    it("without canBuild no building tile is skipped", () => {
        const w = generateWorld(
            { ...TEST_MAP, resourceTiles: { "0,0": true, "1,0": true } },
            "seed-x",
            { buildings: { "0,0": { type: "HQ" } } },
        );
        expect(w.deposits.map((d) => d.key).sort()).toEqual(["0,0", "1,0"]);
    });

    it("deposit world coordinates match the tile center", () => {
        const w = generateWorld(TEST_MAP, "seed-1");
        const d = w.deposits[0];
        if (!d) throw new Error("no deposits");
        const tile = w.tiles.find((t) => t.key === d.key);
        expect(d.x).toBeCloseTo(tile?.x ?? 0, 6);
        expect(d.y).toBeCloseTo(tile?.y ?? 0, 6);
    });
});

describe("World extents", () => {
    it("hex worldWidth/worldHeight equal the hex tile bounds", () => {
        const size = 20;
        const tileSize = 32;
        const w = generateWorld({ ...TEST_MAP, size, tileSize }, "extent-seed");
        const bounds = hexWorldExtents(size, tileSize);
        expect(w.worldWidth).toBeCloseTo(bounds.width, 6);
        expect(w.worldHeight).toBeCloseTo(bounds.height, 6);
    });

    it("hex height includes the half tile above the top row's center", () => {
        const size = 20;
        const tileSize = 32;
        const w = generateWorld({ ...TEST_MAP, size, tileSize }, "extent-seed");
        expect(w.worldHeight).toBeCloseTo(1.5 * tileSize * size + tileSize / 2, 9);
    });

    it("square world size is size × tileSize", () => {
        const w = generateWorld({ ...TEST_MAP, gridType: "square", size: 10, tileSize: 50 }, "square-seed");
        expect(w.worldWidth).toBe(500);
        expect(w.worldHeight).toBe(500);
    });
});

describe("Building placement", () => {
    it("resolves world coordinates by key and returns only existing buildings", () => {
        const placements = placeBuildings({ ...TEST_MAP, gridType: "square", tileSize: 50 }, {
            "3,2": { type: "Mine", level: 5 },
            "0,0": { type: "HQ" },
        });
        expect(placements).toHaveLength(2);
        const mine = placements.find((p) => p.key === "3,2");
        expect(mine?.type).toBe("Mine");
        expect(mine?.level).toBe(5);
        // Square map tile center: ((col+0.5)*tile, (row+0.5)*tile)
        expect(mine?.x).toBe(3.5 * 50);
        expect(mine?.y).toBe(2.5 * 50);
    });
});

/* ------------------------------------------------------------------ *
 * Generation cost
 * ------------------------------------------------------------------ */

describe("Generation cost", () => {
    it("100×100 map generation performs no GPU/node work", () => {
        const big: MapSpec = { ...TEST_MAP, size: 100 };
        const t0 = performance.now();
        const w = generateWorld(big, "perf-seed");
        const ms = performance.now() - t0;
        expect(w.tiles).toHaveLength(10000);
        expect(ms).toBeLessThan(200);
        console.log(`100×100 generation: ${ms.toFixed(2)} ms, ${w.deposits.length} deposits`);
    });
});
