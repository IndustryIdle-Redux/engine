/**
 * Overlay submission structure regression tests.
 *
 * Background: `drawOverlay` used to submit, **per visible tile**, one colour fill (vector layer) and then
 * its text (sprite layer). Both render devices flush their batch whenever the submission kind switches
 * (`WebGL2Device.drawSprite` / `addSprite`, `WebGPUDevice` likewise), so the frame's draw-call count grew
 * linearly with the visible tile count: a 100×100 map at a readable zoom produced one flush pair per tile.
 *
 * The tests below drive the real `WorldRenderer` through a recording fake renderer that models exactly that
 * flush-on-switch rule, so "draw calls" here means the same thing it means in the device. They also pin the
 * exact visible tile set against a brute-force filter (the row/column broad phase must be a conservative
 * superset) and the LOD thresholds, which must not change.
 */

import { describe, expect, it, vi } from "vitest";
import { Color } from "../src/Color";
import { Camera2D } from "../src/renderer/Camera2D";
import { BitmapFont } from "../src/renderer/BitmapFont";
import { generateWorld } from "../src/worldgen/generateWorld";
import type { GridKind } from "../src/worldgen/gridLayout";
import {
    DEFAULT_WORLD_CONFIG,
    WorldRenderer,
    type SpriteSource,
} from "../src/renderer/WorldRenderer";
import { DEFAULT_THEME_NAME, getTheme, THEMES } from "../src/renderer/Theme";
import type { RenderTexture } from "../src/renderer/RenderDevice";
import type { Renderer2D } from "../src/renderer/Renderer2D";

/* ------------------------------------------------------------------ *
 * Recording fake renderer (models the device's flush-on-layer-switch)
 * ------------------------------------------------------------------ */

type SubmitKind = "vector" | "sprite";

interface FakeRenderer {
    renderer: Renderer2D;
    camera: Camera2D;
    /** submission kinds in call order */
    kinds: SubmitKind[];
    /** draw calls the real devices would issue for this frame (one per switch + one final flush) */
    drawCalls: number;
    /** world positions of the overlay fills */
    fills: Array<{ x: number; y: number }>;
    /** sprite submissions with their world positions and the texture they used */
    sprites: Array<{ x: number; y: number; texture: RenderTexture }>;
    /** colors passed to each sprite submission */
    spriteColors: Array<Color | undefined>;
    /** colors passed to each grid-line submission */
    segmentColors: Array<Color | undefined>;
    /** colors passed to each overlay fill submission */
    fillColors: Array<Color | undefined>;
    /** start a new frame */
    reset(): void;
}

function makeRenderer(): FakeRenderer {
    const camera = new Camera2D();
    camera.viewportWidth = 320;
    camera.viewportHeight = 320;
    const kinds: SubmitKind[] = [];
    const fills: Array<{ x: number; y: number }> = [];
    const sprites: Array<{ x: number; y: number; texture: RenderTexture }> = [];
    const spriteColors: Array<Color | undefined> = [];
    const segmentColors: Array<Color | undefined> = [];
    const fillColors: Array<Color | undefined> = [];
    let last: SubmitKind | null = null;

    const submit = (kind: SubmitKind): void => {
        if (kind !== last) kinds.push(kind);
        last = kind;
    };

    const renderer = {
        camera,
        polygonTemplate: (radius: number, sides: number, startAngle: number) => {
            const pts: number[] = [];
            for (let i = 0; i < sides; i++) {
                const a = startAngle + (i / sides) * Math.PI * 2;
                pts.push(Math.cos(a) * radius, Math.sin(a) * radius);
            }
            // a fan: (0,0) + consecutive corners
            const tri: number[] = [];
            for (let i = 0; i < sides; i++) {
                tri.push(0, 0, pts[i * 2] as number, pts[i * 2 + 1] as number, pts[((i + 1) % sides) * 2] as number, pts[((i + 1) % sides) * 2 + 1] as number);
            }
            return tri;
        },
        fillPolygonTemplateAt: (_template: readonly number[], x: number, y: number, color?: Color) => {
            submit("vector");
            fills.push({ x, y });
            fillColors.push(color);
        },
        fillPolygonTemplate: (_template: readonly number[], centers: ReadonlyArray<{ x: number; y: number }>) => {
            submit("vector");
            for (const c of centers) fills.push({ x: c.x, y: c.y });
        },
        drawSprite: (tex: RenderTexture, call: { x: number; y: number; color?: Color }) => {
            submit("sprite");
            sprites.push({ x: call.x, y: call.y, texture: tex });
            spriteColors.push(call.color);
        },
        fillCircle: () => submit("vector"),
        fillRegularPolygon: () => submit("vector"),
        strokePolyline: () => submit("vector"),
        drawSegments: (_segments: unknown, _width: number, color?: Color) => {
            submit("vector");
            segmentColors.push(color);
        },
        getVisibleRect: (out?: { x: number; y: number; width: number; height: number }) => camera.getVisibleRect(out),
    } as unknown as Renderer2D;

    const rec: FakeRenderer = {
        renderer,
        camera,
        kinds,
        fills,
        sprites,
        spriteColors,
        segmentColors,
        fillColors,
        get drawCalls() {
            return kinds.length + (last ? 1 : 0);
        },
        reset() {
            kinds.length = 0;
            fills.length = 0;
            sprites.length = 0;
            spriteColors.length = 0;
            segmentColors.length = 0;
            fillColors.length = 0;
            last = null;
        },
    };
    return rec;
}

const TEXTURE = { width: 1024, height: 1024 } as unknown as RenderTexture;

/** The font gets its own texture so a test can tell font glyphs apart from atlas sprites */
const FONT_TEXTURE = { width: 512, height: 512 } as unknown as RenderTexture;

function makeFont(): { font: BitmapFont; texture: RenderTexture } {
    const font = new BitmapFont(10, { lineHeight: 12, spaceWidth: 5 });
    for (const ch of "0123456789%") {
        font.setGlyph(ch, {
            u0: 0.5,
            v0: 0,
            du: 0.01,
            dv: 0.01,
            width: 10,
            height: 10,
            offsetX: 0,
            offsetY: 0,
            advance: 10,
        });
    }
    return { font, texture: FONT_TEXTURE };
}

function makeWorld(
    kind: GridKind,
    size = 20,
    viewport = 320,
): {
    fake: FakeRenderer;
    world: WorldRenderer;
    generated: ReturnType<typeof generateWorld>;
    fontTexture: RenderTexture;
} {
    const fake = makeRenderer();
    fake.camera.viewportWidth = viewport;
    fake.camera.viewportHeight = viewport;
    const world = new WorldRenderer(fake.renderer, {
        ...DEFAULT_WORLD_CONFIG,
        gridKind: kind,
        maxTile: size,
        tileSize: 32,
        // a light theme keeps the gradient math out of the assertions
        showOverlayFill: true,
    });
    const { font, texture } = makeFont();
    world.setFont(font, texture);
    const source: SpriteSource = {
        texture: TEXTURE,
        get: () => ({ u0: 0, v0: 0, du: 1, dv: 1, width: 32, height: 32 }),
    };
    world.setSpriteSource(source);
    const generated = generateWorld(
        { id: "test", size, gridType: kind, tileSize: 32, resourceProbability: 0, deposits: {} },
        "overlay-test",
    );
    return { fake, world, generated, fontTexture: texture };
}

/** Font glyph submissions only (atlas sprites are the building bodies) */
const glyphs = (fake: FakeRenderer): Array<{ x: number; y: number }> =>
    fake.sprites.filter((s) => s.texture === FONT_TEXTURE);

/** Assert two colors have the same channels */
const expectColor = (actual: Color | undefined, expected: Color): void => {
    expect(actual).toBeDefined();
    expect([actual?.r, actual?.g, actual?.b, actual?.a]).toEqual([
        expected.r,
        expected.g,
        expected.b,
        expected.a,
    ]);
};

describe("drawOverlay: two-pass submission keeps the draw-call count flat", () => {
    it("does not grow draw calls when the visible tile count grows 10x", () => {
        const small = makeWorld("hex", 40, 320);
        const big = makeWorld("hex", 40, 3200);
        // centre of the map so both viewports are fully inside it
        for (const w of [small, big]) {
            w.fake.camera.position.set(1100, 950);
            w.fake.camera.zoom = 1;
        }

        small.world.drawOverlay(small.generated.tiles, () => 0.5);
        big.world.drawOverlay(big.generated.tiles, () => 0.5);

        const smallCells = small.world.stats.overlayCells;
        const bigCells = big.world.stats.overlayCells;
        expect(smallCells).toBeGreaterThan(30);
        expect(bigCells).toBeGreaterThan(smallCells * 8);

        // one vector pass + one sprite pass = a single layer switch, no matter how many tiles are visible
        expect(small.fake.kinds).toEqual(["vector", "sprite"]);
        expect(big.fake.kinds).toEqual(["vector", "sprite"]);
        expect(big.fake.drawCalls).toBe(small.fake.drawCalls);
        expect(big.fake.drawCalls).toBeLessThanOrEqual(3);
    });

    it("still emits one fill per qualifying tile and text for each of them", () => {
        const { fake, world, generated } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;
        world.drawOverlay(generated.tiles, () => 0.5);
        expect(fake.fills.length).toBe(world.stats.overlayCells);
        // 3 glyphs per tile ("50%")
        expect(world.stats.textGlyphs).toBe(world.stats.overlayCells * 3);
        expect(glyphs(fake).length).toBe(world.stats.textGlyphs);
    });

    it("keeps the fill and text LOD thresholds", () => {
        const { fake, world, generated } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);

        // tiles below overlayMinTilePx: nothing at all, and the stats are reset (not stale)
        fake.camera.zoom = 0.1; // tilePx = 3.2 < 5
        world.drawOverlay(generated.tiles, () => 0.5);
        expect(fake.kinds).toEqual([]);
        expect(fake.fills.length).toBe(0);
        expect(world.stats.overlayCells).toBe(0);

        // between the two thresholds: fills only, no text
        fake.camera.zoom = 0.5; // tilePx = 16 (< 22 text threshold)
        world.drawOverlay(generated.tiles, () => 0.5);
        expect(fake.fills.length).toBeGreaterThan(0);
        expect(glyphs(fake).length).toBe(0);
        expect(world.stats.textGlyphs).toBe(0);

        // above the text threshold: both
        fake.camera.zoom = 1;
        world.drawOverlay(generated.tiles, () => 0.5);
        expect(fake.fills.length).toBeGreaterThan(0);
        expect(glyphs(fake).length).toBeGreaterThan(0);
    });

    it("skips occupied tiles (no overlay on tiles with buildings)", () => {
        const { fake, world, generated } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;
        const occupied = new Set(generated.tiles.slice(0, 25).map((t) => t.key));
        // pass values >= 0 so a tile is only skipped by the occupied filter, never by the value callback
        world.drawOverlay(generated.tiles, () => 0.5, occupied);
        const drawnKeys = new Set(
            fake.fills.map((f) => {
                const tile = generated.tiles.find((t) => t.x === f.x && t.y === f.y);
                return tile?.key ?? "";
            }),
        );
        for (const key of occupied) expect(drawnKeys.has(key)).toBe(false);
        expect(world.stats.overlayCells).toBe(drawnKeys.size);
    });
});

describe("drawOverlay: visible tile iteration matches the brute-force filter", () => {
    const cases: Array<{ kind: GridKind; position: [number, number]; zoom: number; label: string }> = [
        { kind: "hex", position: [1600, 1600], zoom: 1, label: "hex centre" },
        { kind: "hex", position: [0, 0], zoom: 1, label: "hex origin (top-left map edge)" },
        { kind: "hex", position: [100000, 100000], zoom: 1, label: "hex off-map" },
        { kind: "hex", position: [2800, 2500], zoom: 2, label: "hex bottom-right edge, zoomed in" },
        { kind: "square", position: [1600, 1600], zoom: 1, label: "square centre" },
        { kind: "square", position: [0, 0], zoom: 1, label: "square origin (map edge)" },
        { kind: "square", position: [3000, 3000], zoom: 1, label: "square bottom-right edge" },
        { kind: "square", position: [-500, -500], zoom: 0.7, label: "square partially off the top-left" },
    ];

    for (const c of cases) {
        it(`${c.label}: the drawn set equals the brute-force filter`, () => {
            const { fake, world, generated } = makeWorld(c.kind, 100, 640);
            fake.camera.position.set(c.position[0], c.position[1]);
            fake.camera.zoom = c.zoom;
            const seen = new Set<string>();
            world.drawOverlay(generated.tiles, (key) => {
                seen.add(key);
                return 0.5;
            });
            // brute force: every tile whose centre passes the same exact predicate the renderer uses
            const half = 16;
            const expected = new Set(
                generated.tiles.filter((t) => fake.camera.isPointVisible(t.x, t.y, half)).map((t) => t.key),
            );
            if (expected.size > 0) expect(seen.size).toBeGreaterThan(0);
            expect([...seen].sort()).toEqual([...expected].sort());
            expect(world.stats.overlayCells).toBe(seen.size);
        });
    }

    it("falls back to the linear scan when `tiles` is not the canonical dense list", () => {
        const { fake, world, generated } = makeWorld("hex", 100, 640);
        fake.camera.position.set(480, 470);
        fake.camera.zoom = 1;
        // every other column: the array index no longer encodes (col,row), so the broad phase must not be used
        const subset = generated.tiles.filter((t) => t.col % 2 === 0);
        const seen = new Set<string>();
        world.drawOverlay(subset, (key) => {
            seen.add(key);
            return 0.5;
        });
        const expected = new Set(
            subset.filter((t) => fake.camera.isPointVisible(t.x, t.y, 16)).map((t) => t.key),
        );
        expect(seen.size).toBeGreaterThan(0);
        expect([...seen].sort()).toEqual([...expected].sort());
    });

    it("visits only the visible row/column range instead of all 10,000 tiles", () => {
        // The broad phase is a measured cost cut: a 100x100 map has 10,000 tiles and the old loop ran
        // `isPointVisible` (a camera query) on every one of them; the range walk only touches the tiles
        // inside the viewport plus a one-tile fringe.
        const { fake, world, generated } = makeWorld("hex", 100, 320);
        fake.camera.position.set(1600, 1600);
        fake.camera.zoom = 1;
        let culled = 0;
        const original = fake.camera.isPointVisible.bind(fake.camera);
        fake.camera.isPointVisible = (x: number, y: number, margin = 0): boolean => {
            culled++;
            return original(x, y, margin);
        };
        world.drawOverlay(generated.tiles, () => 0.5);
        expect(generated.tiles.length).toBe(10000);
        expect(world.stats.overlayCells).toBeGreaterThan(0);
        // ~8x8 tiles visible + the fringe; far below the full 10,000
        expect(culled).toBeLessThan(500);

        // the fallback path really does walk everything (this is what the broad phase replaces)
        culled = 0;
        const reversed = generated.tiles.slice().reverse();
        world.drawOverlay(reversed, () => 0.5);
        expect(culled).toBe(10000);
    });

    it("drawOverlayText visits exactly the same tile set", () => {
        const text = makeWorld("hex", 100, 640);
        const fill = makeWorld("hex", 100, 640);
        for (const w of [text, fill]) {
            w.fake.camera.position.set(1200, 1100);
            w.fake.camera.zoom = 1;
        }
        const seenText = new Set<string>();
        text.world.drawOverlayText(text.generated.tiles, (key) => {
            seenText.add(key);
            return { text: "1" };
        });
        const seenFill = new Set<string>();
        fill.world.drawOverlay(fill.generated.tiles, (key) => {
            seenFill.add(key);
            return 0.5;
        });
        expect([...seenText].sort()).toEqual([...seenFill].sort());
    });
});

describe("drawBuildings: level-digit LOD", () => {
    it("suppresses the level digits (and their font batch) below levelTextMinTilePx", () => {
        const { fake, world } = makeWorld("hex", 40, 320);
        const buildings = [
            { key: "1,1", type: "CoalMine", x: 100, y: 100, level: 7, levelVisible: true },
            { key: "2,1", type: "CoalMine", x: 140, y: 100, level: 8, levelVisible: true },
        ];
        fake.camera.position.set(100, 100);
        fake.camera.zoom = 0.5; // tilePx = 16 < 20
        world.drawBuildings({ buildings });
        expect(glyphs(fake).length).toBe(0);
        expect(world.stats.levelGlyphs).toBe(0);
        expect(world.stats.levelTextSuppressed).toBe(2);

        fake.camera.zoom = 1; // tilePx = 32 >= 20: the default camera zoom must draw them like vanilla
        world.drawBuildings({ buildings });
        expect(world.stats.levelGlyphs).toBe(2);
        expect(world.stats.levelTextSuppressed).toBe(0);
        expect(glyphs(fake).length).toBe(2);
    });

    it("scales the saving with the visible building count", () => {
        // Every suppressed building saves one font instance per digit plus, when the last one is gone,
        // the font batch's draw call (the font texture is what splits the sprite layer).
        const { fake, world } = makeWorld("hex", 100, 4096);
        const buildings = [];
        for (let i = 0; i < 200; i++) {
            buildings.push({ key: `${i},0`, type: "CoalMine", x: 300 + i * 34, y: 1600, level: 10 + (i % 90), levelVisible: true });
        }
        fake.camera.position.set(3600, 1600);
        fake.camera.zoom = 0.5; // tilePx = 16 < 20
        world.drawBuildings({ buildings });
        expect(world.stats.buildings).toBe(200);
        expect(world.stats.levelGlyphs).toBe(0);
        expect(world.stats.levelTextSuppressed).toBe(world.stats.buildings);
        expect(glyphs(fake).length).toBe(0);

        fake.camera.zoom = 1; // tilePx = 32 >= 20
        world.drawBuildings({ buildings });
        // two digits each, for every visible building
        expect(world.stats.buildings).toBeGreaterThan(100);
        expect(world.stats.levelGlyphs).toBe(world.stats.buildings * 2);
        expect(world.stats.levelTextSuppressed).toBe(0);
    });
});

describe("drawDeposits: static and runtime lists are equivalent", () => {
    it("draws the static snapshot with config sizes and the runtime list with its own sizes", () => {
        const staticWorld = makeWorld("hex", 40, 3200);
        staticWorld.fake.camera.position.set(500, 500);
        staticWorld.fake.camera.zoom = 1;
        staticWorld.generated.deposits.push({ key: "0,0", coord: { x: 0, y: 0 }, type: "Coal", x: 500, y: 500 });
        staticWorld.world.drawDeposits(staticWorld.generated);
        expect(staticWorld.world.stats.deposits).toBe(1);
        expect(staticWorld.fake.sprites.length).toBe(1);

        const runtimeWorld = makeWorld("hex", 40, 3200);
        runtimeWorld.fake.camera.position.set(500, 500);
        runtimeWorld.fake.camera.zoom = 1;
        runtimeWorld.world.drawDeposits(runtimeWorld.generated, undefined, false, [
            { key: "0,0", type: "Coal", x: 500, y: 500, size: 12, active: true },
        ]);
        expect(runtimeWorld.world.stats.deposits).toBe(1);
        expect(runtimeWorld.fake.sprites.length).toBe(1);

        // an inactive runtime deposit is hidden (the static snapshot has no such flag)
        runtimeWorld.world.drawDeposits(runtimeWorld.generated, undefined, false, [
            { key: "0,0", type: "Coal", x: 500, y: 500, size: 12, active: false },
        ]);
        expect(runtimeWorld.world.stats.deposits).toBe(0);
    });

    it("hides a deposit whose tile is the miner / is buildable", () => {
        const { fake, world, generated } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(500, 500);
        fake.camera.zoom = 1;
        generated.deposits.push({ key: "3,3", coord: { x: 3, y: 3 }, type: "Coal", x: 500, y: 500 });
        world.updateConfig({ shouldHideDeposit: () => true });
        world.drawDeposits(generated, new Map([["3,3", "CoalMine"]]));
        expect(world.stats.deposits).toBe(0);
        expect(world.stats.depositsHidden).toBe(1);
        expect(fake.sprites.length).toBe(0);
    });
});

describe("theme contract", () => {
    it("DEFAULT_WORLD_CONFIG uses the engine default theme and leaves colors to it", () => {
        expect(DEFAULT_WORLD_CONFIG.theme.name).toBe(THEMES[DEFAULT_THEME_NAME]?.name);
        expect(DEFAULT_WORLD_CONFIG.theme.grid.r).toBe(THEMES[DEFAULT_THEME_NAME]?.grid.r);
        // the per-color config fields are optional overrides now
        expect(DEFAULT_WORLD_CONFIG.gridColor).toBeUndefined();
        expect(DEFAULT_WORLD_CONFIG.depositColor).toBeUndefined();
        expect(DEFAULT_WORLD_CONFIG.buildingColor).toBeUndefined();
        expect(DEFAULT_WORLD_CONFIG.ringColor).toBeUndefined();
        expect(DEFAULT_WORLD_CONFIG.textColor).toBeUndefined();
    });

    it("resolves omitted colors from the active theme", () => {
        const { fake, world, generated } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;
        const theme = getTheme("SolarizedDark");
        world.updateConfig({ theme });

        fake.reset();
        world.drawGrid();
        expectColor(fake.segmentColors[0], theme.grid);

        world.updateConfig({ showGrid: false });
        fake.reset();
        world.drawBuildings({
            buildings: [{ key: "1,1", type: "CoalMine", x: 1100, y: 950, level: 1, levelVisible: false }],
        });
        expectColor(fake.spriteColors[0], theme.building);

        fake.reset();
        world.drawDeposits(generated, undefined, false, [
            { key: "d1", type: "Coal", x: 1100, y: 950, size: 24, active: true },
        ]);
        expectColor(fake.spriteColors[0], theme.building);

        fake.reset();
        world.drawOverlay(generated.tiles, () => 0.5);
        expect(fake.spriteColors.length).toBeGreaterThan(0);
        for (const color of fake.spriteColors) expectColor(color, theme.building);
    });

    it("lets explicit config colors win over the theme", () => {
        const { fake, world } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;
        const explicitGrid = new Color(1, 2, 3, 255);
        const explicitBuilding = new Color(4, 5, 6, 255);
        world.updateConfig({
            theme: getTheme("SolarizedDark"),
            gridColor: explicitGrid,
            buildingColor: explicitBuilding,
        });

        fake.reset();
        world.drawGrid();
        expectColor(fake.segmentColors[0], explicitGrid);

        world.updateConfig({ showGrid: false });
        fake.reset();
        world.drawBuildings({
            buildings: [{ key: "1,1", type: "CoalMine", x: 1100, y: 950, level: 1, levelVisible: false }],
        });
        expectColor(fake.spriteColors[0], explicitBuilding);
    });

    it("changes the resolved colors when updateConfig sets a new theme", () => {
        const { fake, world } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;

        const blue = getTheme("Blue");
        world.updateConfig({ theme: blue });
        fake.reset();
        world.drawGrid();
        expectColor(fake.segmentColors[0], blue.grid);

        const github = getTheme("GithubLight");
        world.updateConfig({ theme: github });
        fake.reset();
        world.drawGrid();
        expectColor(fake.segmentColors[0], github.grid);
        expect(fake.segmentColors[0]?.r).not.toBe(blue.grid.r);
    });

    it("clones themes so renderers never share mutable colors", () => {
        const a = getTheme("Blue");
        const b = getTheme("Blue");
        expect(a).not.toBe(b);
        expect(a.grid).not.toBe(b.grid);

        const original = THEMES[DEFAULT_THEME_NAME]?.grid.r as number;
        a.grid.r = 1;
        expect(b.grid.r).toBe(original);
        expect(THEMES[DEFAULT_THEME_NAME]?.grid.r).toBe(original);

        // updateConfig also clones: mutating the theme afterwards does not affect the renderer
        const { fake, world } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;
        const handedOver = getTheme("SolarizedDark");
        world.updateConfig({ theme: handedOver });
        handedOver.grid.r = 1;
        handedOver.grid.g = 1;
        handedOver.grid.b = 1;
        fake.reset();
        world.drawGrid();
        expect(fake.segmentColors[0]?.r).not.toBe(1);
    });
});

describe("draw stats are reset by every entry point", () => {
    it("clears gridLines when the grid is switched off", () => {
        const { fake, world } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;
        world.drawGrid();
        expect(world.stats.gridLines).toBeGreaterThan(0);

        world.updateConfig({ showGrid: false });
        world.drawGrid();
        expect(world.stats.gridLines).toBe(0);
    });

    it("clears overlayCells/textGlyphs when the LOD skips the overlay", () => {
        const { fake, world, generated } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;
        world.drawOverlay(generated.tiles, () => 0.5);
        expect(world.stats.overlayCells).toBeGreaterThan(0);
        expect(world.stats.textGlyphs).toBeGreaterThan(0);

        fake.camera.zoom = 0.1; // below overlayMinTilePx
        world.drawOverlay(generated.tiles, () => 0.5);
        expect(world.stats.overlayCells).toBe(0);
        expect(world.stats.textGlyphs).toBe(0);

        world.drawOverlayText(generated.tiles, () => ({ text: "1" }));
        expect(world.stats.overlayCells).toBe(0);
        expect(world.stats.textGlyphs).toBe(0);
    });

    it("clears the building counters when no building is visible", () => {
        const { fake, world } = makeWorld("hex", 40, 3200);
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;
        world.drawBuildings({
            buildings: [{ key: "1,1", type: "CoalMine", x: 1100, y: 950, level: 2, levelVisible: true }],
        });
        expect(world.stats.buildings).toBe(1);
        expect(world.stats.levelGlyphs).toBeGreaterThan(0);

        // move the camera far off the map: every building is culled
        fake.camera.position.set(1_000_000, 1_000_000);
        world.drawBuildings({
            buildings: [{ key: "1,1", type: "CoalMine", x: 1100, y: 950, level: 2, levelVisible: true }],
        });
        expect(world.stats.buildings).toBe(0);
        expect(world.stats.levelGlyphs).toBe(0);
    });
});

describe("missing atlas sprites", () => {
    it("draws nothing, keeps draw calls flat and counts the misses", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const { fake, world } = makeWorld("hex", 40, 3200);
            world.updateConfig({ showGrid: false });
            world.setSpriteSource({ texture: TEXTURE, get: () => undefined });
            fake.camera.position.set(1100, 950);
            fake.camera.zoom = 1;

            const buildings = [
                { key: "a", type: "CoalMine", x: 1100, y: 950, level: 1, levelVisible: false },
                { key: "b", type: "CoalMine", x: 1140, y: 950, level: 1, levelVisible: false },
                { key: "c", type: "Bakery", x: 1180, y: 950, level: 1, levelVisible: false },
            ];

            world.drawGrid(); // frame start: resets the per-frame counters
            world.drawBuildings({ buildings });
            expect(world.stats.missingSprites).toBe(3);
            // no vector fallback: the old polygon fallback would have submitted one vector
            // shape per missing building and pushed the draw-call count up with the entity count
            expect(fake.kinds).toEqual([]);
            expect(fake.drawCalls).toBe(0);
            // one warning per missing name, not per entity
            expect(warnSpy).toHaveBeenCalledTimes(2);

            // the next frame reports the same count (the stat is reset, not accumulated)
            world.drawGrid();
            world.drawBuildings({ buildings });
            expect(world.stats.missingSprites).toBe(3);
            expect(warnSpy).toHaveBeenCalledTimes(2);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it("applies the same rule to deposits", () => {
        const { fake, world, generated } = makeWorld("hex", 40, 3200);
        world.updateConfig({ showGrid: false });
        world.setSpriteSource({ texture: TEXTURE, get: () => undefined });
        fake.camera.position.set(1100, 950);
        fake.camera.zoom = 1;

        world.drawGrid();
        world.drawDeposits(generated, undefined, false, [
            { key: "d1", type: "Coal", x: 1100, y: 950, size: 24, active: true },
        ]);
        expect(world.stats.missingSprites).toBe(1);
        expect(world.stats.deposits).toBe(0);
        expect(fake.kinds).toEqual([]);
    });
});
