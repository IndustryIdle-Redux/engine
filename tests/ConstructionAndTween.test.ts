/**
 * Regression tests for two reported bugs:
 *
 * 1. **Coins left on screen** — `TweenManager.update()` used to advance `active` with an index while
 *    completion callbacks can splice that very array (`ResourceAnimation`'s coin chain starts its
 *    flight tween from the scatter tween's `onComplete`, and `to()` supersedes the scatter tween,
 *    which shifts the array). The index-based `splice` then removed a *different*, still-running
 *    tween — so a coin's flight tween could be dropped and its `instances` entry never removed.
 *    The fix walks a snapshot and unlinks by identity.
 *
 * 2. **Construction badge differs from the original** —
 *    - the gear must use `underConstructionColor`/`underConstructionOpacity`
 *      (original: `unpaid` => `color.building` @100, otherwise `color.hq` @255), not the building tint;
 *    - the Level digit must follow the game's `levelVisible` (the original hides it while a building
 *      is under construction), not `level > 0` (a new building already has level 1).
 */

import { describe, expect, it } from "vitest";
import { TweenManager } from "../src/Tween";
import { Color } from "../src/Color";
import { BitmapFont } from "../src/renderer/BitmapFont";
import {
    DEFAULT_WORLD_CONFIG,
    WorldRenderer,
    type BuildingVisual,
    type SpriteSource,
} from "../src/renderer/WorldRenderer";
import type { RenderTexture } from "../src/renderer/RenderDevice";
import type { Renderer2D } from "../src/renderer/Renderer2D";

/* ------------------------------------------------------------------ *
 * 1. Tween manager robustness
 * ------------------------------------------------------------------ */

describe("TweenManager: completion callbacks may mutate the active list", () => {
    const run = (scatterFirst: boolean): { flightDone: boolean; otherDone: boolean; coinX: number } => {
        const tweens = new TweenManager();
        const coin = { x: 0, y: 0 };
        const other = { v: 0 };
        let flightDone = false;
        let otherDone = false;

        const scatter = (): void =>
            tweens.to(coin, { x: 10, y: 10 }, {
                duration: 0.04,
                onComplete: () => {
                    // the original coin chain: the flight tween is created when the scatter completes,
                    // and it supersedes the scatter tween (same target, overlapping keys)
                    tweens.to(coin, { x: 100, y: 100 }, { duration: 0.04, onComplete: () => (flightDone = true) });
                },
            });
        const background = (): void => tweens.to(other, { v: 1 }, { duration: 0.4, onComplete: () => (otherDone = true) });

        if (scatterFirst) {
            scatter();
            background();
        } else {
            background();
            scatter();
        }

        for (let i = 0; i < 40; i++) tweens.update(0.02); // 0.8s, plenty for both chains
        return { flightDone, otherDone, coinX: coin.x };
    };

    it("keeps the tween started by a callback alive (no dropped flight tween)", () => {
        const first = run(true);
        const second = run(false);
        expect(first.flightDone, "scatter first").toBe(true);
        expect(second.flightDone, "background first").toBe(true);
        expect(first.coinX).toBe(100);
        expect(second.coinX).toBe(100);
    });

    it("does not drop an unrelated running tween", () => {
        expect(run(true).otherDone, "scatter first").toBe(true);
        expect(run(false).otherDone, "background first").toBe(true);
    });

    it("still releases finished tweens (no growth of the active list)", () => {
        const tweens = new TweenManager();
        const value = { v: 0 };
        for (let i = 0; i < 10; i++) tweens.to(value, { v: i }, { duration: 0.01 });
        for (let i = 0; i < 5; i++) tweens.update(0.02);
        expect(tweens.count).toBe(0);
        expect(value.v).toBe(9);
    });
});

/* ------------------------------------------------------------------ *
 * 2. Construction badge rendering
 * ------------------------------------------------------------------ */

interface DrawnSprite {
    name: string;
    /** true when the call came from the font texture (level digits / overlay text) */
    fromFont: boolean;
    color: Color;
    opacity: number;
    rotation: number;
    /** signed width — negative means a mirrored sprite (`scaleX = -1`) */
    w: number;
}

/** Minimal fake Renderer2D that records the atlas sprites submitted by `drawBuildings` */
function makeWorldRenderer(): { world: WorldRenderer; drawn: DrawnSprite[] } {
    const names = ["Ring", "Gear", "Off", "PowerOff", "Warning", "Circle_100x100", "CoalMine", "_Coal", "Overpass"];
    /** unique u0 per sprite name, so a recorded call can be mapped back to its sprite */
    const u0 = new Map(names.map((n, i) => [n, (i + 1) / 1000]));
    const byU0 = new Map([...u0].map(([n, u]) => [u, n]));
    const atlasTexture = { width: 1024, height: 2048 } as unknown as RenderTexture;
    const fontTexture = { width: 512, height: 512 } as unknown as RenderTexture;

    const drawn: DrawnSprite[] = [];
    const renderer = {
        camera: { isPointVisible: () => true, zoom: 1 },
        drawSprite: (
            texture: RenderTexture,
            call: { u0: number; color: Color; opacity?: number; rotation?: number; w: number },
        ) => {
            drawn.push({
                name: texture === fontTexture ? "font" : byU0.get(call.u0) ?? `?${call.u0}`,
                fromFont: texture === fontTexture,
                color: call.color,
                opacity: call.opacity ?? 255,
                rotation: call.rotation ?? 0,
                w: call.w,
            });
        },
        fillRegularPolygon: () => {},
    } as unknown as Renderer2D;

    const world = new WorldRenderer(renderer, { ...DEFAULT_WORLD_CONFIG, gridKind: "hex", maxTile: 100, tileSize: 32 });
    const font = new BitmapFont(10, { lineHeight: 12, spaceWidth: 5 });
    for (const ch of "0123456789") {
        font.setGlyph(ch, { u0: 0.5, v0: 0, du: 0.01, dv: 0.01, width: 10, height: 10, offsetX: 0, offsetY: 0, advance: 10 });
    }
    const source: SpriteSource = {
        texture: atlasTexture,
        get: (name: string) => ({
            u0: byU0.has(u0.get(name) as number) ? (u0.get(name) as number) : 0.999,
            v0: 0,
            du: 0.01,
            dv: 0.01,
            width: 32,
            height: 32,
        }),
    };
    world.setSpriteSource(source);
    world.setFont(font, fontTexture);
    return { world, drawn };
}

const underConstructionBuilding = (overrides: Partial<BuildingVisual>): BuildingVisual => ({
    key: "1,1",
    type: "CoalMine",
    x: 100,
    y: 100,
    level: 1,
    underConstruction: true,
    underConstructionColor: new Color(0, 100, 200, 255),
    underConstructionOpacity: 100,
    levelVisible: false,
    spriteOpacity: 100,
    color: new Color(147, 161, 161, 255),
    ...overrides,
});

describe("drawBuildings: construction badge follows the original", () => {
    it("tints the gear with underConstructionColor and applies underConstructionOpacity", () => {
        const { world, drawn } = makeWorldRenderer();
        world.drawBuildings({ buildings: [underConstructionBuilding({})] });
        const gear = drawn.filter((d) => d.name === "Gear");
        expect(gear.length).toBe(1);
        expect((gear[0] as DrawnSprite).color.getR()).toBe(0);
        expect((gear[0] as DrawnSprite).color.getG()).toBe(100);
        expect((gear[0] as DrawnSprite).color.getB()).toBe(200);
        expect((gear[0] as DrawnSprite).opacity).toBe(100);
    });

    it("hides the level digit while under construction and shows it afterwards", () => {
        const under = makeWorldRenderer();
        under.world.drawBuildings({ buildings: [underConstructionBuilding({})] });
        expect(under.drawn.filter((d) => d.fromFont).length, "no level glyph while under construction").toBe(0);

        const done = makeWorldRenderer();
        done.world.drawBuildings({
            buildings: [underConstructionBuilding({ underConstruction: false, levelVisible: true, level: 7 })],
        });
        expect(done.drawn.filter((d) => d.fromFont).length, "level digit once construction is done").toBeGreaterThan(0);
    });

    it("rotates the gear by the game's angle (radians)", () => {
        const { world, drawn } = makeWorldRenderer();
        world.drawBuildings({ buildings: [underConstructionBuilding({ underConstructionAngle: -Math.PI / 2 })] });
        const gear = drawn.find((d) => d.name === "Gear");
        expect(gear?.rotation).toBeCloseTo(-Math.PI / 2, 9);
    });
});

describe("drawBuildings: node state follows the original (recipe icon / ring mirroring)", () => {
    it("fades the recipe icon with recipeOpacity (original tweens recipeSprite.node.opacity)", () => {
        const { world, drawn } = makeWorldRenderer();
        world.drawBuildings({
            buildings: [
                underConstructionBuilding({
                    underConstruction: false,
                    levelVisible: true,
                    recipeKey: "_Coal",
                    recipeBgVisible: true,
                    recipeOpacity: 100,
                }),
            ],
        });
        const icon = drawn.find((d) => d.name === "_Coal");
        expect(icon, "recipe icon drawn").toBeTruthy();
        expect(icon?.opacity).toBe(100);
        // the recipe *background* keeps its own opacity (the original never tweens it)
        expect(drawn.find((d) => d.name === "Circle_100x100")?.opacity).toBe(255);
    });

    it("mirrors the ring when the entity's ringScaleX is -1 (south maps)", () => {
        const south = makeWorldRenderer();
        south.world.drawBuildings({
            buildings: [underConstructionBuilding({ underConstruction: false, levelVisible: true, ringActive: true, ringScaleX: -1 })],
        });
        const southRing = south.drawn.find((d) => d.name === "Ring");
        expect(southRing?.w).toBe(-42);

        const north = makeWorldRenderer();
        north.world.drawBuildings({
            buildings: [underConstructionBuilding({ underConstruction: false, levelVisible: true, ringActive: true, ringScaleX: 1 })],
        });
        expect(north.drawn.find((d) => d.name === "Ring")?.w).toBe(42);
    });
});
