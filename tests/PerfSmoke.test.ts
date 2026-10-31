/**
 * Per-frame work budgets (perf smoke).
 *
 * Why counters instead of wall-clock time: a time assertion is not usable as a CI gate. The same frame
 * measures several times apart between a developer machine and a shared runner, so a time budget either
 * flaps constantly or is loosened until it catches nothing. What *is* stable across machines is the amount
 * of work the world layer hands to the device every frame -- the number of layer flushes (draw calls), the
 * overlay cells it walks, the sprite instances it submits and the glyphs it emits. Those are exactly the
 * numbers that silently grow when someone adds "just one more sprite per tile", and they are what this
 * suite pins.
 *
 * The renderer under test is the real `WorldRenderer`, driven through a recording fake (same approach as
 * `OverlayBatch.test.ts`) that models the devices' flush-on-layer-switch rule, so a "draw call" here means
 * what it means in `WebGL2Device` / `WebGPUDevice`, not an approximation of it.
 *
 * The scene is the real one: a generated 100x100 hex map (10,000 tiles) at the game's 32px tile size.
 */

import { describe, expect, it } from "vitest";
import { BitmapFont } from "../src/renderer/BitmapFont";
import { Camera2D } from "../src/renderer/Camera2D";
import {
    DEFAULT_WORLD_CONFIG,
    WorldRenderer,
    type BuildingVisual,
    type DepositVisual,
    type SpriteSource,
} from "../src/renderer/WorldRenderer";
import { generateWorld } from "../src/worldgen/generateWorld";
import type { GeneratedWorld } from "../src/worldgen/generateWorld";
import type { RenderTexture } from "../src/renderer/RenderDevice";
import type { Renderer2D } from "../src/renderer/Renderer2D";

/* ------------------------------------------------------------------ *
 * Recording fake renderer (models the device's flush-on-layer-switch)
 * ------------------------------------------------------------------ */

type SubmitKind = "vector" | "sprite";

/** The frame's work, as the device would see it. */
interface FrameCounters {
    /** layer flushes: one per submission-kind switch plus the final flush */
    drawCalls: number;
    /** sprite instances submitted through the atlas / font textures */
    instances: number;
    /** overlay colour fills submitted */
    fills: number;
    /** overlay cells that produced a fill */
    overlayCells: number;
    /** overlay text glyph instances */
    textGlyphs: number;
    /** snapshot of `WorldRenderer.stats` (every counter it exposes) */
    stats: WorldRenderer["stats"];
}

interface FakeRenderer {
    renderer: Renderer2D;
    camera: Camera2D;
    /** submission kinds in call order */
    kinds: SubmitKind[];
    /** world positions of the overlay fills */
    fills: Array<{ x: number; y: number }>;
    /** sprite submissions with their world positions and the texture they used */
    sprites: Array<{ x: number; y: number; texture: RenderTexture }>;
    /** `drawSprite` calls actually made; must equal `sprites.length` (nothing submitted is dropped from the log) */
    readonly spriteSubmissions: number;
    /** draw calls the real devices would issue for this frame (one per switch + one final flush) */
    readonly drawCalls: number;
    /** start a frame: the real device resets its batch state in `begin()` */
    reset(): void;
    /**
     * Submit one batch of `kind` without recording an instance.
     *
     * Used for the frame's tail (the dots and logistics lines of `WorldView.render`): they do not belong to
     * any of the counters this suite budgets, but they do decide which layer the frame *ends* on, which is
     * half of the flush count.
     */
    submitLayer(kind: SubmitKind): void;
}

function makeRenderer(): FakeRenderer {
    const camera = new Camera2D();
    const kinds: SubmitKind[] = [];
    const fills: Array<{ x: number; y: number }> = [];
    const sprites: Array<{ x: number; y: number; texture: RenderTexture }> = [];
    let last: SubmitKind | null = null;
    let submissions = 0;

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
                tri.push(
                    0,
                    0,
                    pts[i * 2] as number,
                    pts[i * 2 + 1] as number,
                    pts[((i + 1) % sides) * 2] as number,
                    pts[((i + 1) % sides) * 2 + 1] as number,
                );
            }
            return tri;
        },
        fillPolygonTemplateAt: (_template: readonly number[], x: number, y: number) => {
            submit("vector");
            fills.push({ x, y });
        },
        fillPolygonTemplate: (_template: readonly number[], centers: ReadonlyArray<{ x: number; y: number }>) => {
            submit("vector");
            for (const c of centers) fills.push({ x: c.x, y: c.y });
        },
        drawSprite: (tex: RenderTexture, call: { x: number; y: number }) => {
            submit("sprite");
            submissions++;
            sprites.push({ x: call.x, y: call.y, texture: tex });
        },
        fillCircle: () => submit("vector"),
        fillRegularPolygon: () => submit("vector"),
        strokePolyline: () => submit("vector"),
        drawSegments: () => submit("vector"),
        createMesh: (vertices: Float32Array) => ({ kind: "webgl2" as const, vertexCount: vertices.length / 6 }),
        drawMesh: () => submit("vector"),
        disposeMesh: () => {},
        getVisibleRect: (out?: { x: number; y: number; width: number; height: number }) => camera.getVisibleRect(out),
    } as unknown as Renderer2D;

    return {
        renderer,
        camera,
        kinds,
        fills,
        sprites,
        get spriteSubmissions() {
            return submissions;
        },
        get drawCalls() {
            return kinds.length + (last ? 1 : 0);
        },
        reset() {
            kinds.length = 0;
            fills.length = 0;
            sprites.length = 0;
            last = null;
            submissions = 0;
        },
        submitLayer(kind: SubmitKind) {
            submit(kind);
        },
    };
}

const TEXTURE = { width: 1024, height: 1024 } as unknown as RenderTexture;

/** The font gets its own texture so the recorder can tell font glyphs apart from atlas sprites */
const FONT_TEXTURE = { width: 512, height: 512 } as unknown as RenderTexture;

function makeFont(): BitmapFont {
    const font = new BitmapFont(10, { lineHeight: 12, spaceWidth: 5 });
    // every character the overlay ("50%") and the level digits can produce
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
    return font;
}

/** Font glyph submissions only (atlas sprites are the building bodies / deposits / dots) */
const glyphs = (fake: FakeRenderer): number => fake.sprites.filter((s) => s.texture === FONT_TEXTURE).length;

/* ------------------------------------------------------------------ *
 * Scene: a real 100x100 hex map, the whole thing visible at zoom 0.5
 * ------------------------------------------------------------------ */

const MAP_SIZE = 100;
const TILE_SIZE = 32;

/**
 * Viewport chosen so that at zoom 0.5 the visible rect is 5600x5000 world units: the generated hex map is
 * about 5570x4800, so zoom 0.5 really is "the whole map" (all 10,000 tiles) and zoom 3 really is "a few
 * hundred tiles", which is the 30x spread these tests need.
 */
const VIEWPORT_WIDTH = 2800;
const VIEWPORT_HEIGHT = 2500;

/** Overlay values of 0.5 render as "50%", i.e. three glyphs per cell */
const OVERLAY_GLYPHS_PER_CELL = 3;

interface WorldContext {
    fake: FakeRenderer;
    world: WorldRenderer;
    generated: GeneratedWorld;
}

function makeWorld(): WorldContext {
    const fake = makeRenderer();
    fake.camera.viewportWidth = VIEWPORT_WIDTH;
    fake.camera.viewportHeight = VIEWPORT_HEIGHT;

    const world = new WorldRenderer(fake.renderer, {
        ...DEFAULT_WORLD_CONFIG,
        gridKind: "hex",
        maxTile: MAP_SIZE,
        tileSize: TILE_SIZE,
    });

    world.setFont(makeFont(), FONT_TEXTURE);
    const source: SpriteSource = {
        texture: TEXTURE,
        get: () => ({ u0: 0, v0: 0, du: 1, dv: 1, width: TILE_SIZE, height: TILE_SIZE }),
    };
    world.setSpriteSource(source);

    const generated = generateWorld(
        {
            id: "perf-smoke",
            size: MAP_SIZE,
            gridType: "hex",
            tileSize: TILE_SIZE,
            resourceProbability: 0,
            deposits: {},
        },
        "perf-smoke",
    );

    // the map centre is the camera position every test starts from
    fake.camera.position.set(generated.worldWidth / 2, generated.worldHeight / 2);
    return { fake, world, generated };
}

/** Six buildings on real tiles next to the map centre, all visible at every zoom these tests use. */
function centerBuildings(generated: GeneratedWorld): BuildingVisual[] {
    const cx = generated.worldWidth / 2;
    const cy = generated.worldHeight / 2;
    return generated.tiles
        .filter((t) => Math.abs(t.x - cx) < 120 && Math.abs(t.y - cy) < 120)
        .slice(0, 6)
        .map((tile, i) => ({
            key: tile.key,
            type: "CoalMine",
            x: tile.x,
            y: tile.y,
            // single-digit levels keep "one glyph per visible building" exact
            level: 1 + (i % 9),
            levelVisible: true,
        }));
}

/** Four runtime deposits around the map centre, so the frame exercises the deposit layer too. */
function centerDeposits(generated: GeneratedWorld): DepositVisual[] {
    const cx = generated.worldWidth / 2;
    const cy = generated.worldHeight / 2;
    return [0, 1, 2, 3].map((i) => ({
        key: `deposit-${i}`,
        type: "Coal",
        x: cx + (i - 1.5) * 60,
        y: cy - 60,
        size: 24,
        active: true,
    }));
}

/**
 * Assemble one frame and read back the work counters.
 *
 * The order mirrors `WorldView.render`: grid -> deposits -> buildings -> highlight/selection -> overlay,
 * followed by the dots and logistics lines. The tail matters for the draw-call invariant: without it the
 * frame's *last* layer depends on whether the overlay text LOD fired, and two frames that differ only in
 * "is the text drawn?" would flush a different number of batches for a reason unrelated to the overlay.
 */
function assembleFrame(ctx: WorldContext, overlay: boolean): FrameCounters {
    const { fake, world, generated } = ctx;
    fake.reset();

    const buildings = centerBuildings(generated);
    const deposits = centerDeposits(generated);
    const types = new Map(buildings.map((b) => [b.key, b.type] as const));
    const occupied = new Set(buildings.map((b) => b.key));

    world.drawGrid();
    // pass the overlay state, not `cfg.showOverlay`: they mean different things (see `drawDeposits`)
    world.drawDeposits(generated, types, overlay, deposits);
    world.drawBuildings({ buildings });

    const cx = generated.worldWidth / 2;
    const cy = generated.worldHeight / 2;
    const selected = { x: cx, y: cy };
    world.drawSelected(selected.x, selected.y);
    world.drawHighlightGrids([selected, { x: cx + TILE_SIZE, y: cy }]);

    if (overlay) world.drawOverlay(generated.tiles, () => 0.5, occupied);

    // the frame tail: WorldView draws dots (sprites) and then logistics lines (segments)
    fake.submitLayer("sprite");
    fake.submitLayer("vector");

    return {
        drawCalls: fake.drawCalls,
        instances: fake.sprites.length,
        fills: fake.fills.length,
        overlayCells: world.stats.overlayCells,
        textGlyphs: world.stats.textGlyphs,
        stats: { ...world.stats },
    };
}

/* ------------------------------------------------------------------ *
 * Budgets
 *
 * Each ceiling is a constant so the table below reads as a specification: the value it may not exceed is
 * fixed here, not buried in an assertion. They sit ~10% above the measured value, which is enough slack
 * for a harmless change (a slightly different visible-tile count at a LOD boundary) while still failing
 * loudly on the regressions this suite exists for -- a per-tile flush, a per-tile sprite, or overlay text
 * emitted below its LOD threshold.
 * ------------------------------------------------------------------ */

/** Absolute ceiling for one full frame: a per-tile flush regression produces hundreds, the real frame uses a handful */
const MAX_DRAW_CALLS = 12;
/** Per-configuration draw calls: measured 6 (grid / deposits+buildings / highlight+fills / overlay text / tail) */
const DRAW_CALL_BUDGET = 8;
/** Overlay fills at zoom 0.5: the whole 10,000-tile map is visible (measured 9994) */
const WHOLE_MAP_CELL_BUDGET = 10500;
/** Overlay fills at zoom 1: a quarter of the map fits in the viewport (measured 2697) */
const ZOOM1_CELL_BUDGET = 2850;
/** Overlay fills at zoom 3: a few hundred tiles (measured 300) */
const ZOOM3_CELL_BUDGET = 330;
/** Overlay glyphs at zoom 1: 3 glyphs ("50%") per visible cell (measured 8091) */
const ZOOM1_GLYPH_BUDGET = 8550;
/** Overlay glyphs at zoom 3 (measured 900) */
const ZOOM3_GLYPH_BUDGET = 1000;
/** Sprite instances for the overlay-off rows: 4 deposits + 6 building bodies (measured 10) */
const NO_OVERLAY_INSTANCE_BUDGET = 13;
/** Sprite instances at zoom 1: deposits + bodies + level digits + overlay glyphs (measured 8107) */
const ZOOM1_INSTANCE_BUDGET = 8550;
/** Sprite instances at zoom 3 (measured 916) */
const ZOOM3_INSTANCE_BUDGET = 1010;

interface WorkBudget {
    drawCalls: number;
    instances: number;
    overlayCells: number;
    textGlyphs: number;
}

interface BudgetRow {
    label: string;
    zoom: number;
    overlay: boolean;
    budget: WorkBudget;
}

describe("Perf smoke: per-frame work budgets", () => {
    it("keeps draw calls flat while the visible tile count grows 30x", () => {
        const ctx = makeWorld();

        // whole map visible, thousands of overlay cells
        ctx.fake.camera.zoom = 0.5;
        const wide = assembleFrame(ctx, true);

        // zoomed in: over an order of magnitude fewer cells
        ctx.fake.camera.zoom = 3;
        const tight = assembleFrame(ctx, true);

        // the test has to actually exercise the case it claims: the wide frame sees >= 5x the cells
        expect(tight.overlayCells).toBeGreaterThan(100);
        expect(wide.overlayCells).toBeGreaterThanOrEqual(5 * tight.overlayCells);

        // ... yet both frames flush the same number of batches: draw calls depend on the *layers* the frame
        // touches (grid / sprites / fills / text / tail), never on how many cells are inside those layers.
        expect(wide.drawCalls).toBeLessThanOrEqual(MAX_DRAW_CALLS);
        expect(tight.drawCalls).toBeLessThanOrEqual(MAX_DRAW_CALLS);
        expect(wide.drawCalls).toBe(tight.drawCalls);
    });

    it("stays inside the per-configuration work budget table", () => {
        const rows: BudgetRow[] = [
            {
                label: "hex 100x100, zoom 0.5, overlay off",
                zoom: 0.5,
                overlay: false,
                budget: {
                    drawCalls: DRAW_CALL_BUDGET,
                    instances: NO_OVERLAY_INSTANCE_BUDGET,
                    overlayCells: 0,
                    textGlyphs: 0,
                },
            },
            {
                // the text pass is configured, but at 16 tile px the `overlayTextMinTilePx` LOD suppresses
                // every glyph; the background fills are the whole cost at this zoom (pinned by the LOD test)
                label: "hex 100x100, zoom 0.5, overlay on (backgrounds + text)",
                zoom: 0.5,
                overlay: true,
                budget: {
                    drawCalls: DRAW_CALL_BUDGET,
                    instances: NO_OVERLAY_INSTANCE_BUDGET,
                    overlayCells: WHOLE_MAP_CELL_BUDGET,
                    textGlyphs: 0,
                },
            },
            {
                label: "hex 100x100, zoom 1, overlay on (fills + text)",
                zoom: 1,
                overlay: true,
                budget: {
                    drawCalls: DRAW_CALL_BUDGET,
                    instances: ZOOM1_INSTANCE_BUDGET,
                    overlayCells: ZOOM1_CELL_BUDGET,
                    textGlyphs: ZOOM1_GLYPH_BUDGET,
                },
            },
            {
                label: "hex 100x100, zoom 3, overlay on (fills + text)",
                zoom: 3,
                overlay: true,
                budget: {
                    drawCalls: DRAW_CALL_BUDGET,
                    instances: ZOOM3_INSTANCE_BUDGET,
                    overlayCells: ZOOM3_CELL_BUDGET,
                    textGlyphs: ZOOM3_GLYPH_BUDGET,
                },
            },
        ];

        const measured = rows.map((row) => {
            const ctx = makeWorld();
            ctx.fake.camera.zoom = row.zoom;
            return { row, counters: assembleFrame(ctx, row.overlay) };
        });

        // printed so a reader can see the numbers a budget failure is measured against
        console.log("Per-frame work, hex 100x100 @ tileSize 32, viewport 2800x2500");
        console.log(
            "config".padEnd(56) +
                "draw calls".padStart(12) +
                "instances".padStart(12) +
                "cells".padStart(9) +
                "glyphs".padStart(9) +
                "fills".padStart(9),
        );
        for (const { row, counters } of measured) {
            console.log(
                row.label.padEnd(56) +
                    String(counters.drawCalls).padStart(12) +
                    String(counters.instances).padStart(12) +
                    String(counters.overlayCells).padStart(9) +
                    String(counters.textGlyphs).padStart(9) +
                    String(counters.fills).padStart(9),
            );
        }

        for (const { row, counters } of measured) {
            expect(counters.drawCalls, `${row.label}: draw calls`).toBeLessThanOrEqual(row.budget.drawCalls);
            expect(counters.instances, `${row.label}: sprite instances`).toBeLessThanOrEqual(row.budget.instances);
            expect(counters.overlayCells, `${row.label}: overlay cells`).toBeLessThanOrEqual(row.budget.overlayCells);
            expect(counters.textGlyphs, `${row.label}: text glyphs`).toBeLessThanOrEqual(row.budget.textGlyphs);
            // the fill pass submits exactly one fill per collected cell
            expect(counters.fills, `${row.label}: fills`).toBe(counters.overlayCells);
        }
    });

    it("holds the overlay text LOD: no glyphs below the threshold, backgrounds still drawn", () => {
        const ctx = makeWorld();

        // tilePx = 32 * 0.5 = 16: >= overlayMinTilePx (5) but < overlayTextMinTilePx (22)
        ctx.fake.camera.zoom = 0.5;
        const below = assembleFrame(ctx, true);
        expect(below.overlayCells).toBeGreaterThan(1000);
        expect(below.fills).toBe(below.overlayCells);
        expect(below.textGlyphs).toBe(0);
        expect(ctx.world.stats.textGlyphs).toBe(0);
        expect(glyphs(ctx.fake)).toBe(0);

        // tilePx = 32: above the threshold, so every cell also emits its three glyphs
        ctx.fake.camera.zoom = 1;
        const above = assembleFrame(ctx, true);
        expect(above.overlayCells).toBeGreaterThan(1000);
        // the zoomed-out frame really does see more cells than the zoomed-in one (the two measurements are
        // not accidentally the same camera state)
        expect(below.overlayCells).toBeGreaterThan(above.overlayCells);
        expect(above.textGlyphs).toBe(above.overlayCells * OVERLAY_GLYPHS_PER_CELL);
        // the counter is the emitted glyph count, not a second, independent estimate. Font instances are
        // shared with the level digits, so subtract the ones `drawBuildings` emitted.
        expect(glyphs(ctx.fake)).toBe(above.textGlyphs + above.stats.levelGlyphs);
    });

    it("holds the level-digit LOD: none below the threshold, one per visible building above it", () => {
        const ctx = makeWorld();
        const buildings = centerBuildings(ctx.generated);

        // tilePx = 16 < levelTextMinTilePx (20): every visible building's digit is suppressed
        ctx.fake.camera.zoom = 0.5;
        const below = assembleFrame(ctx, false);
        expect(below.stats.buildings).toBe(buildings.length);
        expect(below.stats.levelGlyphs).toBe(0);
        expect(below.stats.levelTextSuppressed).toBe(below.stats.buildings);
        expect(glyphs(ctx.fake)).toBe(0);

        // tilePx = 32 >= 20: exactly one glyph per visible building (their levels are single digits)
        ctx.fake.camera.zoom = 1;
        const above = assembleFrame(ctx, false);
        expect(above.stats.buildings).toBe(buildings.length);
        expect(above.stats.levelGlyphs).toBe(above.stats.buildings);
        expect(above.stats.levelTextSuppressed).toBe(0);
        expect(glyphs(ctx.fake)).toBe(above.stats.levelGlyphs);

        // suppressed + emitted always accounts for every visible building: no digit is lost silently
        for (const frame of [below, above]) {
            expect(frame.stats.levelGlyphs + frame.stats.levelTextSuppressed).toBe(frame.stats.buildings);
        }
    });

    it("produces identical counters for repeated frames (no per-frame accumulation)", () => {
        const ctx = makeWorld();
        ctx.fake.camera.zoom = 1;

        const frames = [0, 1, 2, 3, 4].map(() => assembleFrame(ctx, true));
        const first = frames[0] as FrameCounters;
        // the grid geometry is cached, so frame 1 is a cache hit and frame 0 a miss; both must report the
        // same *work*: a cache that grows work per frame, or stats that accumulate instead of reset, would
        // show up as a difference here.
        expect(first.drawCalls).toBeGreaterThan(0);
        for (const frame of frames) {
            expect(frame).toEqual(first);
        }
    });

    it("submits every visible building and never reports more instances than were submitted", () => {
        const ctx = makeWorld();
        ctx.fake.camera.zoom = 3; // zoomed in: nothing can be culled by accident at this margin
        const buildings = centerBuildings(ctx.generated);
        const counters = assembleFrame(ctx, false);

        // no dropped buildings: each visible building contributes at least its body instance
        expect(counters.stats.buildings).toBe(buildings.length);
        expect(counters.instances).toBeGreaterThanOrEqual(buildings.length);
        // and the instances can never exceed what was actually submitted: the recorder's instance count and
        // its submission count are two views of the same events, so a `drawSprite` that bypasses either one
        // (the easy way to "lose" or double-count a building) breaks this identity.
        expect(counters.instances).toBe(ctx.fake.spriteSubmissions);
        expect(counters.instances).toBe(ctx.fake.sprites.length);
    });

    it("keeps draw calls flat when the atlas is missing building sprites", () => {
        const ctx = makeWorld();
        ctx.world.updateConfig({ showGrid: false });
        ctx.fake.camera.zoom = 1;
        // no atlas sprite at all: every building body is a miss
        ctx.world.setSpriteSource({ texture: TEXTURE, get: () => undefined });
        const buildings = centerBuildings(ctx.generated);

        ctx.world.drawGrid();
        ctx.fake.reset();
        ctx.world.drawBuildings({ buildings });

        expect(ctx.world.stats.missingSprites).toBe(buildings.length);
        // the old fallback drew a vector polygon per missing building, switching layers once per
        // entity; the only layer left now is the level-digit font batch
        expect(ctx.fake.kinds).not.toContain("vector");
        expect(ctx.fake.kinds).toEqual(["sprite"]);
        expect(ctx.fake.drawCalls).toBeLessThanOrEqual(2);
    });
});
