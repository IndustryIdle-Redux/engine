/**
 * World-layer renderer — replaces the pile of `cc.Node`s in the Cocos world.
 *
 * This is the **single entry point** when wiring it into the game: it renders `GeneratedWorld` (pure data) to the screen,
 * doing frustum culling, batching by texture, and text instancing internally.
 *
 * Compared against the original (`world/World.ts` + `EntityVisual.ts` + `DrawLines.ts`):
 *  - original: one `cc.instantiate(Building.prefab)` per building (about 11 child nodes),
 *    one `cc.Node`+`cc.Sprite` per deposit, one `cc.Label` per tile,
 *    plus a few `cc.Graphics` (grid lines / connections / range circles)
 *  - this implementation: **zero nodes**. Everything ultimately becomes repeated `drawArraysInstanced` calls,
 *    and only entities inside the **visible area** are processed.
 *
 * Draw order (equivalent to the original's zIndex semantics, but always O(1)):
 *   1. grid lines (`GraphicsBatch`)
 *   2. deposits
 *   3. buildings
 *   4. overlay color fills + text (topmost)
 */

import { Color } from "../Color";
import { getTheme, overlayGradient } from "./Theme";
import type { IColorTheme } from "./Theme";
import type { GeneratedWorld } from "../worldgen/generateWorld";
import type { GridKind } from "../worldgen/gridLayout";
import {
    buildHexGridLinesFast,
    buildSquareGridLines,
    hexCornerOffsets,
    hexMetrics,
} from "./GridGeometry";
import type { LineSegment } from "./GridGeometry";
import type { Renderer2D } from "./Renderer2D";
import type { BitmapFont } from "./BitmapFont";
import type { RenderTexture } from "./RenderDevice";

/* ------------------------------------------------------------------ *
 * Sprite source: name → atlas UV + size + texture
 * ------------------------------------------------------------------ */

export interface SpriteSource {
    texture: RenderTexture;
    get(name: string): { u0: number; v0: number; du: number; dv: number; width: number; height: number } | undefined;
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

export interface WorldRenderConfig {
    gridKind: GridKind;
    maxTile: number;
    tileSize: number;
    /** grid line color */
    gridColor: Color;
    /** deposit tint */
    depositColor: Color;
    /** building tint */
    buildingColor: Color;
    /** ring tint */
    ringColor: Color;
    /** overlay text color */
    textColor: Color;
    /** whether to draw the overlay (corresponds to the original's `hasOverlay`) */
    showOverlay: boolean;
    /** whether to draw grid lines */
    showGrid: boolean;
    /** text font size */
    fontSize: number;

    /* ---------------- Sizes (**aligned item by item with Building.prefab**) ---------------- *
     *
     * These values are not estimates; they are read out of `assets/Prefabs/Building.prefab`'s `_trs`:
     *
     *   | node                    | pos      | scale | sizeMode         | final size            |
     *   |-------------------------|----------|-------|------------------|-----------------------|
     *   | Sprite (building image) | (0,0)    | 0.45  | TRIMMED(1)       | original image × 0.45 |
     *   | Ring (ring)             | (0,0)    | 1     | CUSTOM(0)        | 42×42                 |
     *   | Level (level)           | (16,16)  | 0.5   | Label fontSize32 | 16px font size        |
     *   | Warning                 | (-16,16) | 1     | CUSTOM(0)        | 13×12                 |
     *   | Gear/TurnOff/…          | (16,16)  | 1     | CUSTOM(0)        | 11.5×11.5             |
     *
     * ⚠️ Buildings used to be drawn at their **original image size** here, i.e. scaled up by **1/0.45 ≈ 2.22×**,
     *    so buildings squeezed into each other and overflowed their tiles. That was the most obvious sizing mistake in this project.
     */
    /** building sprite scale (the prefab's Sprite node scale) */
    buildingScale: number;
    /** ring side length (the prefab's Ring contentSize) */
    ringSize: number;

    /* ---- Badge geometry: values taken one by one from `Building.prefab`'s `_trs` and `_contentSize` ---- */
    /** offset of the bottom-left badge (Warning/TurnOff/PowerOff), prefab `_trs = [-16, 16, …]` */
    badgeOffsetX: number;
    badgeOffsetY: number;
    /** side length of TurnOff / PowerOff / Gear (prefab contentSize 11.5×11.5) */
    badgeSize: number;
    /** Warning's width and height (prefab contentSize 13×12, **not square**) */
    warningWidth: number;
    warningHeight: number;
    /** construction gear offset, prefab `_trs = [16, 16, …]` */
    gearOffsetX: number;
    gearOffsetY: number;
    /** recipe icon offset and scale, prefab `_trs = [8, -8, …], scale 0.25` */
    recipeOffsetX: number;
    recipeOffsetY: number;
    recipeScale: number;
    /** scale of the recipe background `Circle_100x100`, prefab `_trs scale 0.2` (100×0.2 = 20) */
    recipeBgScale: number;
    /** level digit font size (prefab's Label fontSize 32 × node scale 0.5) */
    levelFontSize: number;
    /** level digit offset relative to the tile center (prefab's Level node position) */
    levelOffsetX: number;
    levelOffsetY: number;
    /** whether to draw the ring (the original shows it only for buildings that are working) */
    showRing: boolean;
    /**
     * Whether the ring is mirrored horizontally (the original's `this.ring.scaleX = MAP[D.map].south ? -1 : 1`).
     * Some maps (`south: true`) are mirrored as a whole, flipping both the rotation direction and the arc opening position.
     */
    ringFlipX: boolean;
    /** whether to draw the level digits */
    showLevel: boolean;
    /** whether to draw overlay color fills (can be turned off for debugging, to see text only) */
    showOverlayFill: boolean;

    /* ---------------- Color themes (aligned value by value with the game's ColorThemes.ts) ---------------- */
    /** current theme; after it is set, the individual colors take their defaults from it */
    theme: IColorTheme;
    /**
     * Per-building tint override (the original's `getBuildingColor(type)`; players can customize a color per building type).
     * Returning null means use the theme's `building`.
     */
    getBuildingColor?: (type: string) => Color | null;
    /** overlay color fill opacity (the original's overlay layer) */
    overlayAlpha: number;

    /**
     * Overlay color fill LOD lower bound: when a tile's **on-screen pixel size** is below this, even the fill is not drawn.
     *
     * Zoomed out to the whole map a tile is only a few pixels; the fills crowd together, convey nothing, and just waste vertices.
     */
    overlayMinTilePx: number;

    /**
     * Overlay **text** LOD lower bound: when a tile's on-screen pixels are below this, draw only fills and no text.
     *
     * Why it is needed: a 100×100 map zoomed out to the whole map has 10,000 tiles, 4 glyphs each
     * (`"62%"`) → measured about 490k triangles, **95% of the frame's triangles and 57% of its time**,
     * while at that point the glyphs are only about 4px and completely unreadable. With this rule the same scene drops to about 27k triangles.
     */
    overlayTextMinTilePx: number;
    /**
     * Level-digit LOD lower bound: when a building's tile is below this many **on-screen pixels**,
     * the level number is not drawn.
     *
     * The overlay text has had such a bound (`overlayTextMinTilePx`) for a while, but the building level
     * digits were emitted at **every** zoom. Zoomed out they are 3~8 px tall, unreadable, and still cost
     * one font batch plus one instance per glyph. Default 20 tile px = a 10 px glyph at the game's
     * 32 px tile / 16 px level font, i.e. the digits are drawn at the default camera zoom (1) and may
     * be dropped only once they get smaller than vanilla ever shows them.
     */
    levelTextMinTilePx: number;
    /** grid line width (the original's `LINE_WIDTH = 2`) */
    lineWidth: number;
    /** selected-box line width multiplier (the original's `HIGHLIGHT_EXTRA_WIDTH = 1.25`) */
    highlightExtraWidth: number;

    /* ---------------- Deposit sizes (aligned with `World.updateDepositVisual`) ---------------- *
     *
     * ⚠️ The original does **not** draw at the image's native 48×48; it sets the size explicitly in `updateDepositVisual`:
     *
     * | Situation                                                            | Size   | Position           |
     * |---------------------------------------------------------------------|--------|--------------------|
     * | no building on the tile & overlay off                                | 24×24  | tile center        |
     * | no building on the tile & overlay on                                 | 12×12  | center + (-16,-16) |
     * | building on the tile (not this deposit's miner, tile not buildable)  | 12×12  | center + (-16,-16) |
     * | the tile is **the miner producing this deposit** or **buildable**    | hidden | —                  |
     *
     * Drawing at the image's native size would be **2× too big** (48 vs 24), the deposit would nearly fill the tile, clearly different from the original.
     */
    /** deposit side length when centered on the tile (original's `deposit.width = 24`) */
    depositSize: number;
    /** deposit side length when placed shrunk-aside (original's `deposit.width = 12`) */
    depositAsideSize: number;
    /** position offset when placed shrunk-aside (original's `position.add(cc.v3(-16, -16))`) */
    depositAsideOffsetX: number;
    depositAsideOffsetY: number;
    /**
     * Whether this tile's deposit should be hidden (original: the miner produces exactly this deposit, or a building can be placed on the tile).
     * If not provided, always show.
     */
    shouldHideDeposit?: (key: string, depositType: string, buildingType: string) => boolean;
}

export const DEFAULT_WORLD_CONFIG: Omit<WorldRenderConfig, "gridKind" | "maxTile" | "tileSize"> = {
    gridColor: new Color(59, 66, 82, 255),
    depositColor: new Color(136, 192, 208, 255),
    // Note: the game's building PNGs are **pure white silhouettes**, colored by tint (the original gives each building type its own color).
    // A neutral light gray is used as the default here; on integration the game can pass its real palette via `getBuildingColor(type)`.
    buildingColor: new Color(226, 232, 240, 255),
    ringColor: new Color(120, 180, 200, 255),
    textColor: new Color(229, 233, 240, 255),
    showOverlay: true,
    showGrid: true,
    /**
     * Overlay text font size.
     *
     * ⚠️ In the original's `World.generateMap` the overlay label is set to
     * `label.fontSize = 20; label.lineHeight = 30;` with no node scaling.
     * It **must be 20** here — a smaller font size makes negative modifiers (red, whose opacity is already only 55/255)
     * almost invisible.
     */
    fontSize: 20,
    buildingScale: 0.45,
    ringSize: 42,
    badgeOffsetX: -16,
    badgeOffsetY: 16,
    badgeSize: 11.5,
    warningWidth: 13,
    warningHeight: 12,
    gearOffsetX: 16,
    gearOffsetY: 16,
    recipeOffsetX: 8,
    recipeOffsetY: -8,
    recipeScale: 0.25,
    recipeBgScale: 0.2,
    levelFontSize: 16,
    levelOffsetX: 16,
    levelOffsetY: 16,
    showRing: true,
    ringFlipX: false,
    showLevel: true,
    showOverlayFill: true,
    theme: getTheme("SolarizedDark"),
    overlayAlpha: 60,
    overlayMinTilePx: 5,
    overlayTextMinTilePx: 22,
    levelTextMinTilePx: 20,
    lineWidth: 2,
    highlightExtraWidth: 1.25,
    depositSize: 24,
    depositAsideSize: 12,
    depositAsideOffsetX: -16,
    depositAsideOffsetY: -16,
};

/* ------------------------------------------------------------------ *
 * Overlay text: computed only for the visible area, reusing the same array (zero allocation)
 * ------------------------------------------------------------------ */

/** Value source for a single tile's overlay (in the game it is `getTileModifier(xy, buildingType)`) */
export type OverlayValueFn = (key: string) => number | null;

/** Single-tile overlay text (replaces handing a `cc.Label` to the callback in the original: text + optional color/opacity) */
export interface OverlayText {
    text: string;
    /** falls back to the theme's text color if omitted */
    color?: Color;
    /** 0~255; fully opaque if omitted (corresponds to the original's `label.node.opacity`) */
    opacity?: number;
}

/** Value source for single-tile overlay text (in the game it is `Debug.drawCoordinate` / `BuildPage.showTileModifiers`) */
export type OverlayTextFn = (key: string) => OverlayText | null;

/**
 * Common shape of a deposit entry — the static `world.deposits` snapshot and the runtime list
 * (`World.depositNodes`) both fit it. The runtime-only fields are optional so `drawDeposits` can iterate
 * either list **without mapping one into the other** (that map was a per-frame allocation, see `drawDeposits`).
 */
export interface DepositVisual {
    key: string;
    type: string;
    x: number;
    y: number;
    /** runtime only: size already computed by `World.updateDepositVisual` */
    size?: number;
    /** runtime only: the original's `deposit.active` (false = hidden) */
    active?: boolean;
    color?: Color;
    opacity?: number;
}

/**
 * World renderer.
 *
 * Usage (every frame):
 * ```ts
 * world.beginFrame();       // submit grid lines
 * world.drawDeposits();     // deposits
 * world.drawBuildings();    // buildings
 * world.drawOverlay(fn);    // overlay (optional, pass a value function)
 * renderer.end();
 * ```
 */
export class WorldRenderer {
    private readonly renderer: Renderer2D;
    private readonly config: WorldRenderConfig;
    private sprites: SpriteSource | null = null;
    private font: BitmapFont | null = null;
    private fontTexture: RenderTexture | null = null;

    /** Reused line segment buffer, avoiding per-frame allocation */
    private gridLines: LineSegment[] = [];
    /** Grid geometry cache key (the quantized visible rect); with a still camera, reuse last frame's edges directly */
    private gridCacheKey = "";
    /** Cache hit/miss stats (for debugging) */
    public readonly gridCacheStats = { hit: 0, miss: 0 };

    /** Reused visible-rect object for the broad-phase tile bounds (`getVisibleRect` would allocate) */
    private readonly visibleRect = { x: 0, y: 0, width: 0, height: 0 };

    /**
     * Overlay collection buffers (pass 0 of `drawOverlay`), reused every frame.
     *
     * The overlay is submitted in **two passes** (all fills, then all texts) because the device flushes
     * its batches on every sprite/vector layer switch: interleaving a fill and its text per tile made the
     * draw-call count grow linearly with the visible tile count. Tiles never overlap, so the rendered
     * result of the two-pass order is identical. Collecting into flat typed arrays keeps that zero-alloc.
     */
    private overlayX = new Float64Array(256);
    private overlayY = new Float64Array(256);
    private overlayValue = new Float64Array(256);
    private overlayCount = 0;

    /** Stats (for the HUD / perf panel) */
    public stats = {
        gridLines: 0,
        deposits: 0,
        /** deposits hidden because "the miner produces this deposit / the tile is buildable" */
        depositsHidden: 0,
        buildings: 0,
        /** number of rings drawn this frame */
        rings: 0,
        /** number of level digit glyphs drawn this frame */
        levelGlyphs: 0,
        /** buildings whose level digits were skipped by the `levelTextMinTilePx` LOD this frame */
        levelTextSuppressed: 0,
        /** number of highlighted tiles drawn this frame */
        selected: 0,
        overlayCells: 0,
        textGlyphs: 0,
        /** number of status badges drawn this frame (Warning/TurnOff/PowerOff/Gear) */
        badges: 0,
    };

    constructor(renderer: Renderer2D, config: WorldRenderConfig) {
        this.renderer = renderer;
        this.config = config;
    }

    public setSpriteSource(source: SpriteSource | null): void {
        this.sprites = source;
    }

    public setFont(font: BitmapFont | null, texture: RenderTexture | null): void {
        this.font = font;
        this.fontTexture = texture;
    }

    public updateConfig(patch: Partial<WorldRenderConfig>): void {
        Object.assign(this.config, patch);
    }

    /**
     * Submit grid lines (**generate the visible area only**).
     *
     * The original calls `stroke()` once for each of 10,000 hexagons here,
     * taking 13~15 ms per call; this implementation generates only the visible area's few hundred edges (0.1~0.2 ms).
     */
    public drawGrid(): void {
        // Reset stats every frame
        this.stats.rings = 0;
        this.stats.badges = 0;
        this.stats.selected = 0;
        if (!this.config.showGrid) return;
        const visible = this.renderer.getVisibleRect();
        const { gridKind, maxTile, tileSize } = this.config;

        // Use the **no-dedup** version: each tile emits only the 3 edges it owns, boundary tiles emit the outer edges.
        // The dedup version uses a Set keyed by strings, measured at **2.99 ms/frame** (the frame's largest cost) with a large visible area;
        // the no-dedup version drops to about 0.68 ms, and its edge set is verified edge by edge against the dedup version in unit tests.
        //
        // On top of that, a **geometry cache**: the grid depends only on the visible rect, and the rect is quantized by `tileSize` and expanded
        // by one tile. So with a still camera there is zero generation, and a pan of less than one tile can still reuse it (the extra edges
        // in the cache merely extend slightly past the viewport, which does not matter).
        const step = tileSize;
        const pad = step * 2;
        const qx0 = Math.floor((visible.x - pad) / step) * step;
        const qy0 = Math.floor((visible.y - pad) / step) * step;
        const qx1 = Math.ceil((visible.x + visible.width + pad) / step) * step;
        const qy1 = Math.ceil((visible.y + visible.height + pad) / step) * step;
        const key = `${gridKind}|${maxTile}|${tileSize}|${qx0},${qy0},${qx1},${qy1}`;

        if (key !== this.gridCacheKey) {
            const rect = { x: qx0, y: qy0, width: qx1 - qx0, height: qy1 - qy0 };
            this.gridLines =
                gridKind === "hex"
                    ? buildHexGridLinesFast(maxTile, tileSize, rect)
                    : buildSquareGridLines(maxTile, tileSize, rect);
            this.gridCacheKey = key;
            this.gridCacheStats.miss++;
        } else {
            this.gridCacheStats.hit++;
        }

        // Line width compensation: **the original uses `LINE_WIDTH / sqrt(zoom)`** (not /zoom),
        // see `PlayerInput.drawGrid`. Copying it is the only way to keep thickness consistent across zooms.
        const width = this.config.lineWidth / Math.sqrt(this.renderer.camera.zoom);
        this.renderer.drawSegments(this.gridLines, width, this.config.gridColor);
        this.stats.gridLines = this.gridLines.length;
    }

    /**
     * Get a tile's polygon vertices (hexagon or square), used for the selection highlight.
     *
     * Hexagons use `hexCornerOffsets` (strictly aligned with honeycomb);
     * a square is just a square of side `tileSize`.
     */
    public tilePolygon(x: number, y: number): Array<{ x: number; y: number }> {
        if (this.config.gridKind === "hex") {
            return hexCornerOffsets(this.config.tileSize).map((c) => ({ x: x + c.x, y: y + c.y }));
        }
        const h = this.config.tileSize / 2;
        return [
            { x: x - h, y: y - h },
            { x: x + h, y: y - h },
            { x: x + h, y: y + h },
            { x: x - h, y: y + h },
        ];
    }

    /** Selected-box line width (the original's `HIGHLIGHT_EXTRA_WIDTH * LINE_WIDTH / sqrt(zoom)`) */
    private selectedLineWidth(): number {
        return (
            (this.config.highlightExtraWidth * this.config.lineWidth) /
            Math.sqrt(this.renderer.camera.zoom)
        );
    }

    /**
     * Highlight a single tile (the original's `Grid.drawSelected` + `PlayerInput.drawSelected`).
     *
     * Original: `strokeColor = getCurrentColor().gridSelected`, line width
     * `HIGHLIGHT_EXTRA_WIDTH * LINE_WIDTH / sqrt(cameraZoom)`.
     */
    public drawSelected(x: number, y: number): void {
        this.renderer.strokePolyline(
            this.tilePolygon(x, y),
            this.selectedLineWidth(),
            true,
            this.config.theme.gridSelected,
        );
        this.stats.selected++;
    }

    /** Highlight multiple tiles (the original's `drawHighlightGrids`, for batch selection / placement preview) */
    public drawHighlightGrids(cells: ReadonlyArray<{ x: number; y: number }>): void {
        if (cells.length === 0) return;
        const width = this.selectedLineWidth();
        const color = this.config.theme.gridSelected;
        for (const c of cells) {
            this.renderer.strokePolyline(this.tilePolygon(c.x, c.y), width, true, color);
            this.stats.selected++;
        }
    }

    /**
     * Submit deposits.
     *
     * Position and size are **strictly aligned with `World.updateDepositVisual`** (see the config item comments):
     *  - no building on the tile and overlay off → 24×24 centered
     *  - otherwise (overlay on / building on the tile) → 12×12, offset (-16,-16)
     *  - the miner produces this deposit, or a building can be placed on the tile → hidden (decided by `shouldHideDeposit`)
     *
     * @param world the generated world
     * @param buildingTypeByKey this tile's building type (key → type); used to decide size and hiding
     */
    /**
     * @param overlayActive **whether the "tile modifier overlay" is currently shown** — corresponds to the original's `World.hasOverlay`.
     *
     * ⚠️ Do not substitute `cfg.showOverlay` for it: that is the renderer's master switch (true by default),
     * whereas the original's `hasOverlay` is controlled only by `World.forEachOverlay()` / `clearOverlay()`,
     * meaning "the player is currently looking at the tile modifier overlay".
     * Mixing them up makes **every deposit always treated as "must make way" and shrunk to 12×12**, never drawing the big 24×24 deposit.
     */
    public drawDeposits(
        world: GeneratedWorld,
        buildingTypeByKey?: ReadonlyMap<string, string>,
        overlayActive = false,
        /**
         * **Runtime deposits** (from `World.depositNodes`). When provided, **they take precedence**.
         *
         * ⚠️ Why this parameter is required: `world.deposits` is a **static snapshot** from `generateWorld()`,
         * while deposits are **added/removed/changed** at runtime:
         *   - after a dam works, water is added dynamically to the adjacent tile via `makeDeposit(xy, "Water")` (with fade in/out)
         *   - manual placement by the player in sandbox mode
         *   - `removeDeposit` / `resetDepositNodes`
         *   - `updateDepositVisual` changes size/position/visibility when a building occupies the tile
         * Drawing only `world.deposits` makes **all of these changes invisible**
         * (symptom: the dam's water block never shows, yet the logic still reads them).
         */
        runtimeDeposits?: ReadonlyArray<DepositVisual>,
    ): void {
        const cfg = this.config;
        const camera = this.renderer.camera;
        const texture = this.sprites?.texture;
        const margin = Math.max(cfg.depositSize, cfg.ringSize);
        const hasOverlay = overlayActive;
        let drawn = 0;
        let hidden = 0;

        // Runtime data takes precedence (includes dynamic add/remove and the size/position already computed by updateDepositVisual).
        //
        // ⚠️ `world.deposits` is iterated **directly** instead of being `.map()`ped into a normalized list
        // (which is what it used to do). That map allocated one object per deposit on every frame — a
        // 100×100 map carries ~2,500 deposits, i.e. ~2,500 short-lived objects per frame (measured on the
        // bench maps: 2,450 deposits) purely to add a `size: 0` field the static branch never reads.
        const list: ReadonlyArray<DepositVisual> = runtimeDeposits ?? world.deposits;
        const hasRuntime = runtimeDeposits !== undefined;

        for (const d of list) {
            // Runtime data carries its own active flag (the original's `deposit.active = false` means hidden)
            if (d.active === false) continue;
            const buildingType = buildingTypeByKey?.get(d.key);

            // Hide decision (original: the miner produces this deposit / the tile is buildable)
            if (buildingType && cfg.shouldHideDeposit?.(d.key, d.type, buildingType)) {
                hidden++;
                continue;
            }

            // Runtime data already has the size and position computed by `World.updateDepositVisual` (aligned with the original item by item),
            // so fall back to the config defaults only when there is no runtime data
            const aside = hasOverlay || buildingType !== undefined;
            const size = hasRuntime ? (d.size ?? cfg.depositSize) : aside ? cfg.depositAsideSize : cfg.depositSize;
            const x = d.x;
            const y = d.y;

            if (!camera.isPointVisible(x, y, margin)) continue;

            const sprite = this.sprites?.get(d.type);
            if (sprite && texture) {
                this.renderer.drawSprite(texture, {
                    x,
                    y,
                    // The original stretches the sprite to the target size by setting `node.width/height`
                    w: size,
                    h: size,
                    u0: sprite.u0,
                    v0: sprite.v0,
                    du: sprite.du,
                    dv: sprite.dv,
                    color: d.color ?? cfg.depositColor,
                    opacity: d.opacity ?? 255,
                });
            } else {
                this.renderer.fillCircle(x, y, size * 0.4, d.color ?? cfg.depositColor, 12);
            }
            drawn++;
        }
        this.stats.deposits = drawn;
        this.stats.depositsHidden = hidden;
    }

    /**
     * Submit buildings.
     *
     * Each building's composition is **aligned item by item with `Building.prefab`**:
     *  1. **ring** (`Ring`): a 42×42 open arc, shown only while "working", rotating at `180°/s`
     *  2. **building image** (`Sprite`): original image size × **0.45**
     *  3. **level digits** (`Level`): tile center + (16,16), 16px font size
     *
     * ⚠️ An earlier version drew buildings at 100% of the original image, i.e. 2.22× too large,
     *    which made buildings squeeze into each other and overflow their tiles — the most obvious sizing mistake.
     */
    public drawBuildings(world: BuildingsLike): void {
        const camera = this.renderer.camera;
        const cfg = this.config;
        const margin = Math.max(96, cfg.ringSize);
        const ringSprite = this.sprites?.get("Ring");
        const texture = this.sprites?.texture;

        // First pick out the visible buildings, then draw them **in passes by texture**.
        //
        // ⚠️ Do not "for each building draw ring→image→text in sequence": ring/image use the atlas texture and text uses the font texture,
        // so alternating them flushes the batch on every texture switch (measured: 21 buildings → **43 draw calls**).
        // With passes: one atlas pass + one font pass, and draw calls no longer depend on building count.
        const visible: BuildingVisual[] = [];
        for (const b of world.buildings) {
            if (camera.isPointVisible(b.x, b.y, margin)) visible.push(b);
        }

        let rings = 0;
        let levels = 0;

        // Pass 1: building images (atlas texture)
        //
        // Draw order aligned with `Building.prefab`'s **child node order**:
        //   Sprite → Circle_100x100 → RecipeSprite → **Ring** → Warning → …
        // Later child nodes draw on top, so **the ring must cover the building**.
        // Building and ring share the atlas texture, so their order within the same batch is preserved and adds no draw call.
        /**
         * Draw one atlas sprite (shared by the building body and the various badges).
         *
         * All badges come from the same atlas and the same batch, so they **add no draw calls**.
         */
        const atlas = this.sprites;
        const drawAtlasSprite = (
            name: string,
            x: number,
            y: number,
            w: number,
            h: number,
            color: Color,
            opacity = 255,
            rotation = 0,
        ): boolean => {
            const sp = atlas?.get(name);
            if (!sp || !texture) return false;
            this.renderer.drawSprite(texture, {
                x,
                y,
                w,
                h,
                u0: sp.u0,
                v0: sp.v0,
                du: sp.du,
                dv: sp.dv,
                color,
                opacity,
                rotation,
            });
            return true;
        };

        for (const b of visible) {
            const sprite = atlas?.get(b.type);
            if (sprite && texture) {
                this.renderer.drawSprite(texture, {
                    x: b.x,
                    y: b.y,
                    w: sprite.width * cfg.buildingScale,
                    h: sprite.height * cfg.buildingScale,
                    u0: sprite.u0,
                    v0: sprite.v0,
                    du: sprite.du,
                    dv: sprite.dv,
                    color: b.color ?? cfg.buildingColor,
                    // Building body is semi-transparent while under construction (the original's `sprite.node.opacity = 100`)
                    opacity: b.underConstruction ? 100 : (b.spriteOpacity ?? 255),
                });
            } else {
                this.renderer.fillRegularPolygon(
                    b.x,
                    b.y,
                    cfg.tileSize * 0.6,
                    cfg.gridKind === "hex" ? 6 : 4,
                    cfg.buildingColor,
                    Math.PI / (cfg.gridKind === "hex" ? 6 : 4),
                );
            }
        }

        // Pass 1.5: recipe background and recipe icon (atlas texture)
        // prefab child node order: Sprite → Circle_100x100 → RecipeSprite → Ring → …
        for (const b of visible) {
            const color = b.color ?? cfg.buildingColor;
            if (b.recipeBgVisible) {
                const bg = atlas?.get("Circle_100x100");
                if (bg) {
                    const side = Math.max(bg.width, bg.height) * cfg.recipeBgScale;
                    drawAtlasSprite("Circle_100x100", b.x, b.y, side, side, cfg.theme.background);
                }
            }
            if (b.recipeKey) {
                const r = atlas?.get(b.recipeKey);
                if (r) {
                    drawAtlasSprite(
                        b.recipeKey,
                        b.x + cfg.recipeOffsetX,
                        b.y + cfg.recipeOffsetY,
                        r.width * cfg.recipeScale,
                        r.height * cfg.recipeScale,
                        color,
                        // The original tweens `recipeSprite.node.opacity` together with the body
                        // (`updateVisual` fades both to 100 while not working / under construction).
                        b.recipeOpacity ?? 255,
                    );
                }
            }
        }

        // Pass 2: rings (atlas texture, drawn on top of the buildings)
        if (cfg.showRing && ringSprite && texture) {
            for (const b of visible) {
                if (!b.ringActive) continue;
                this.renderer.drawSprite(texture, {
                    x: b.x,
                    y: b.y,
                    // Mirroring is done with a negative width (equivalent to the original's `scaleX = -1`).
                    // The original sets it **per node** (`ring.scaleX = MAP[D.map].south ? -1 : 1`), so the
                    // entity's own value wins; `ringFlipX` is the config fallback for callers that don't pass one
                    // (without this, south maps like Rio de Janeiro drew the ring arc un-mirrored).
                    w: ((b.ringScaleX ?? (cfg.ringFlipX ? -1 : 1)) < 0 ? -cfg.ringSize : cfg.ringSize),
                    h: cfg.ringSize,
                    u0: ringSprite.u0,
                    v0: ringSprite.v0,
                    du: ringSprite.du,
                    dv: ringSprite.dv,
                    rotation: b.ringAngle ?? 0,
                    color: b.color ?? cfg.ringColor,
                    opacity: b.ringOpacity ?? 255,
                });
                rings++;
            }
        }

        // Pass 2.5: status badges (atlas texture)
        // prefab order: Ring → Warning → TurnOff → PowerOff → Level → Gear
        // TurnOff / PowerOff / Warning are **mutually exclusive** (see the decision chain in `EntityVisual.updateVisual`),
        // but Gear can appear together with them, so Gear gets its own pass.
        let badges = 0;
        for (const b of visible) {
            const color = b.color ?? cfg.buildingColor;
            const bx = b.x + cfg.badgeOffsetX;
            const by = b.y + cfg.badgeOffsetY;
            if (b.warning) {
                if (drawAtlasSprite("Warning", bx, by, cfg.warningWidth, cfg.warningHeight, color)) badges++;
            } else if (b.turnOff) {
                // the prefab's TurnOff node is bound to the `Off` image
                if (drawAtlasSprite("Off", bx, by, cfg.badgeSize, cfg.badgeSize, color)) badges++;
            } else if (b.noPower) {
                if (drawAtlasSprite("PowerOff", bx, by, cfg.badgeSize, cfg.badgeSize, color)) badges++;
            }
        }
        for (const b of visible) {
            if (!b.underConstruction) continue;
            // The gear is the prefab's `underConstruction` node: `EntityVisual.onUIRedraw` tints it
            // `color.building` (unpaid) or `color.hq` and sets its opacity to 100 / 255 — **not** the
            // building's own tint, which is what made the construction badge look wrong.
            if (
                drawAtlasSprite(
                    "Gear",
                    b.x + cfg.gearOffsetX,
                    b.y + cfg.gearOffsetY,
                    cfg.badgeSize,
                    cfg.badgeSize,
                    b.underConstructionColor ?? b.color ?? cfg.buildingColor,
                    b.underConstructionOpacity ?? 255,
                    b.underConstructionAngle ?? 0,
                )
            ) {
                badges++;
            }
        }
        this.stats.badges = badges;

        // Pass 3: level digits (font texture, drawn together last)
        //
        // LOD (see `levelTextMinTilePx`): below the threshold the digits are a few pixels tall, so they
        // are skipped entirely. They are the only thing forcing a **second texture** into the sprite
        // layer, so suppressing them also removes the font batch's draw call.
        const levelPx = cfg.tileSize * camera.zoom;
        const drawLevel = cfg.showLevel && levelPx >= cfg.levelTextMinTilePx;
        let levelSuppressed = 0;
        if (drawLevel && this.font && this.fontTexture) {
            for (const b of visible) {
                // ⚠️ Drive this from the game's `level.node.active` (`levelVisible`), NOT from `level > 0`:
                // a brand-new building already has level 1 while it is still under construction, and the
                // original hides the Level node during construction (`onUIRedraw` returns early and only
                // activates it once the construction flag is gone).
                if (!b.levelVisible) continue;
                // the prefab's Level coordinates are the **node center**, while layout() wants a baseline, hence the conversion
                const layout = this.font.layout(
                    `${b.level}`,
                    b.x + cfg.levelOffsetX,
                    this.font.baselineForCenterY(b.y + cfg.levelOffsetY, cfg.levelFontSize),
                    cfg.levelFontSize,
                    "center",
                );
                this.font.emit(
                    layout,
                    (call) => {
                        this.renderer.drawSprite(this.fontTexture as RenderTexture, call);
                        levels++;
                    },
                    b.color ?? cfg.buildingColor,
                );
            }
        } else if (cfg.showLevel) {
            for (const b of visible) if (b.levelVisible) levelSuppressed++;
        }

        this.stats.buildings = visible.length;
        this.stats.rings = rings;
        this.stats.levelGlyphs = levels;
        this.stats.levelTextSuppressed = levelSuppressed;
    }

    /**
     * Submit the overlay (color fills + text) in **two passes**: all fills, then all texts.
     *
     * Compared with the original: `forEachOverlay` queues a closure for **all 10,000 tiles**
     * (and it originally had a duplicate-queueing bug too, reaching 20,000 entries), consuming only 100 per frame.
     * This implementation walks only the **visible area** and computes everything directly, with no queue and no closure allocation.
     *
     * Why two passes: the devices flush their batch whenever the submission kind switches, so the old
     * "fill, then this tile's text, then the next tile" order produced one flush pair per visible tile
     * (measured in the demo at 1280×800: 866 draw calls for 432 overlay tiles). Grouping the passes makes
     * the overlay cost two draw calls regardless of the visible tile count. Tiles do not overlap, so the
     * rendered result only differs in that a neighbour's fill can no longer tint an already-drawn glyph
     * — the text is now uniformly on top of the fills, which is what "overlay background fill" means.
     *
     * @param tiles tile list (from `GeneratedWorld.tiles`)
     * @param valueOf value function; returning null means this tile is not shown
     */
    public drawOverlay(
        tiles: GeneratedWorld["tiles"],
        valueOf: OverlayValueFn,
        /** tiles with buildings — **do not draw the overlay** (aligned with the original `forEachOverlay`'s `if (!this.buildingVisuals[xy])`) */
        occupied?: ReadonlySet<string>,
    ): void {
        if (!this.config.showOverlay || !this.font || !this.fontTexture) return;

        const camera = this.renderer.camera;
        const half = this.config.tileSize / 2;
        const sides = this.config.gridKind === "hex" ? 6 : 4;
        const startAngle = Math.PI / (this.config.gridKind === "hex" ? 6 : 4);

        // LOD: a tile's on-screen pixels = world size × zoom
        const tilePx = this.config.tileSize * camera.zoom;
        if (tilePx < this.config.overlayMinTilePx) return;
        const drawText = tilePx >= this.config.overlayTextMinTilePx;

        // The fill shape is identical for every tile, so make it a **template** and reuse it (avoiding an ear-clip and array allocation per tile)
        const fillTemplate = this.config.showOverlayFill
            ? this.renderer.polygonTemplate(this.config.tileSize * 0.52, sides, startAngle)
            : null;

        // Pass 0 — collect. Nothing is submitted here, so the two submission passes below each stay in one
        // device layer. This is what makes the draw-call count independent of the visible tile count:
        // a per-tile "fill then text" loop switches vector→sprite→vector→… on every tile, and the device
        // flushes both batches on every switch (measured: 2 flush pairs per visible tile).
        this.overlayCount = 0;
        this.forEachVisibleTile(tiles, half, (tile) => {
            if (occupied?.has(tile.key)) return;
            const value = valueOf(tile.key);
            if (value === null) return;
            if (this.overlayCount === this.overlayX.length) this.growOverlayBuffers();
            const i = this.overlayCount++;
            this.overlayX[i] = tile.x;
            this.overlayY[i] = tile.y;
            this.overlayValue[i] = value;
        });

        // Pass 1 — every fill (single vector layer, one draw call on both backends)
        if (fillTemplate) {
            for (let i = 0; i < this.overlayCount; i++) {
                // Aligned with the original: low value → modifierOverlayMin, high value → modifierOverlayMax
                this.renderer.fillPolygonTemplateAt(
                    fillTemplate,
                    this.overlayX[i] as number,
                    this.overlayY[i] as number,
                    overlayGradient(this.config.theme, this.overlayValue[i] as number, this.config.overlayAlpha),
                );
            }
        }

        // Pass 2 — every text (single font texture → one sprite batch). Tiles never overlap, so "all fills
        // then all texts" renders identically to the old per-tile order.
        let glyphs = 0;
        if (drawText) {
            for (let i = 0; i < this.overlayCount; i++) {
                glyphs += this.emitOverlayText(
                    this.overlayX[i] as number,
                    this.overlayY[i] as number,
                    `${Math.round((this.overlayValue[i] as number) * 100)}%`,
                    this.config.textColor,
                );
            }
        }

        this.stats.overlayCells = this.overlayCount;
        this.stats.textGlyphs = glyphs;
    }

    /**
     * Submit the **text overlay** (without color fills).
     *
     * Relation to the original's `World.forEachOverlay`: the original hands the whole `cc.Label` to the callback,
     * and the caller sets `label.string` / `label.node.color`; here it becomes
     * "the callback returns `{ text, color? }` and the renderer draws it" — likewise preserving **per-tile colors**
     * (`Debug.drawCoordinate` uses white, `BuildPage.showTileModifiers` uses a chroma gradient).
     *
     * @param tiles tile list (from `GeneratedWorld.tiles`)
     * @param textOf value function; returning null means this tile is not shown
     */
    public drawOverlayText(
        tiles: GeneratedWorld["tiles"],
        textOf: OverlayTextFn,
        /** tiles with buildings — **do not draw the overlay** (aligned with the original `forEachOverlay`) */
        occupied?: ReadonlySet<string>,
    ): void {
        if (!this.config.showOverlay || !this.font || !this.fontTexture) return;

        const camera = this.renderer.camera;
        const half = this.config.tileSize / 2;
        // Text-only overlay: if tiles are too small, skip the whole layer (smeared text is meaningless)
        if (this.config.tileSize * camera.zoom < this.config.overlayTextMinTilePx) return;
        let cells = 0;
        let glyphs = 0;

        this.forEachVisibleTile(tiles, half, (tile) => {
            if (occupied?.has(tile.key)) return;
            const spec = textOf(tile.key);
            if (spec === null) return;
            glyphs += this.emitOverlayText(
                tile.x,
                tile.y,
                spec.text,
                spec.color ?? this.config.textColor,
                spec.opacity,
            );
            cells++;
        });
        this.stats.overlayCells = cells;
        this.stats.textGlyphs = glyphs;
    }

    /**
     * Visit the tiles of `tiles` that can be inside the camera's visible rectangle.
     *
     * Why the broad phase: `drawOverlay` used to walk **all** 10,000 tiles of a 100×100 map and cull each
     * one with `isPointVisible`. Deriving the row/column range from the same `worldgen/gridLayout` layout
     * that generated the tiles (hex: `hexCenter`, square: center at `(col+0.5)*tileSize`) turns that into a
     * few hundred iterations.
     *
     * ⚠️ The range must be a **conservative superset** and the exact `isPointVisible` predicate is still
     * applied per tile — unlike the grid-line generator there is no cross-tile dependency here (no shared
     * edge that a neighbour outside the range would fail to emit), so an over-wide range is harmless while
     * an under-wide one would silently drop tiles. The hex x of a tile depends on the row parity
     * (`(row & 1) ? 0.5 : 0`), which is why the column bounds carry a full extra tile of slack.
     *
     * If `tiles` is not the canonical dense row/column list (e.g. a caller passes a filtered subset), the
     * index math is meaningless, so fall back to the linear scan.
     */
    private forEachVisibleTile(
        tiles: GeneratedWorld["tiles"],
        margin: number,
        visit: (tile: GeneratedWorld["tiles"][number]) => void,
    ): void {
        const cfg = this.config;
        const maxTile = cfg.maxTile;
        const canonical =
            maxTile > 0 && tiles.length === maxTile * maxTile && tiles[0]?.col === 0 && tiles[0]?.row === 0;
        if (!canonical) {
            const camera = this.renderer.camera;
            for (const tile of tiles) {
                if (camera.isPointVisible(tile.x, tile.y, margin)) visit(tile);
            }
            return;
        }

        const camera = this.renderer.camera;
        const rect = camera.getVisibleRect(this.visibleRect);
        const ts = cfg.tileSize;
        let minCol: number;
        let maxCol: number;
        let minRow: number;
        let maxRow: number;
        if (cfg.gridKind === "hex") {
            const m = hexMetrics(ts);
            minRow = Math.floor((rect.y - margin - m.height / 2) / m.rowStep) - 1;
            maxRow = Math.ceil((rect.y + rect.height + margin - m.height / 2) / m.rowStep) + 1;
            // a hex tile's x is `(col + (row&1 ? 0.5 : 0)) * colStep + width/2`, so the parity offset has to fit in the slack
            minCol = Math.floor((rect.x - margin - m.width / 2) / m.colStep) - 1;
            maxCol = Math.ceil((rect.x + rect.width + margin - m.width / 2) / m.colStep) + 1;
        } else {
            // square: center = (col + 0.5) * tileSize
            minRow = Math.floor((rect.y - margin) / ts) - 1;
            maxRow = Math.ceil((rect.y + rect.height + margin) / ts) + 1;
            minCol = Math.floor((rect.x - margin) / ts) - 1;
            maxCol = Math.ceil((rect.x + rect.width + margin) / ts) + 1;
        }
        minRow = Math.max(0, minRow);
        maxRow = Math.min(maxTile - 1, maxRow);
        minCol = Math.max(0, minCol);
        maxCol = Math.min(maxTile - 1, maxCol);

        const hex = cfg.gridKind === "hex";
        for (let row = minRow; row <= maxRow; row++) {
            for (let col = minCol; col <= maxCol; col++) {
                const tile = tiles[hex ? row * maxTile + col : col * maxTile + row];
                if (!tile) continue;
                if (!camera.isPointVisible(tile.x, tile.y, margin)) continue;
                visit(tile);
            }
        }
    }

    /** Double the overlay collection buffers (only when the visible tile count outgrows them) */
    private growOverlayBuffers(): void {
        const cap = this.overlayX.length * 2;
        const x = new Float64Array(cap);
        const y = new Float64Array(cap);
        const v = new Float64Array(cap);
        x.set(this.overlayX);
        y.set(this.overlayY);
        v.set(this.overlayValue);
        this.overlayX = x;
        this.overlayY = y;
        this.overlayValue = v;
    }

    /** Draw one piece of overlay text centered on the tile center; returns the number of glyphs written */
    private emitOverlayText(x: number, y: number, text: string, color: Color, opacity?: number): number {
        if (!this.font || !this.fontTexture) return 0;
        const layout = this.font.layout(
            text,
            x,
            this.font.baselineForCenterY(y, this.config.fontSize),
            this.config.fontSize,
            "center",
        );
        let glyphs = 0;
        this.font.emit(
            layout,
            (call) => {
                this.renderer.drawSprite(this.fontTexture as RenderTexture, call);
                glyphs++;
            },
            color,
            opacity,
        );
        return glyphs;
    }
}

/** Minimal shape of a building list (so the engine does not depend on game types) */
export interface BuildingVisual {
    key: string;
    /** building type (corresponds to the sprite name in the atlas) */
    type: string;
    /** world coordinates (tile center) */
    x: number;
    y: number;
    level: number;
    /** out-of-power badge (`EntityVisual.turnOff`; the prefab's TurnOff node, image `Off`) */
    turnOff?: boolean;
    /** not-enough-power badge (`EntityVisual.notEnoughPower`; the prefab's PowerOff node) */
    noPower?: boolean;
    /** warning badge (`EntityVisual.warning`; the prefab's Warning node) */
    warning?: boolean;
    /** under construction (`EntityVisual.underConstruction`; body semi-transparent + Gear badge) */
    underConstruction?: boolean;
    /** construction gear's spin angle (radians). Original `cc.tween(...).by(4, { angle: -4*180 })` */
    underConstructionAngle?: number;
    /**
     * Construction gear tint — the original writes `underConstruction.color = construction === "unpaid"
     * ? color.building : color.hq` (a *theme* colour, deliberately not the building's own tint).
     */
    underConstructionColor?: Color;
    /** Construction gear opacity — `100` for `unpaid`, `255` otherwise (original `underConstruction.opacity`) */
    underConstructionOpacity?: number;
    /** whether the Level node is active (`EntityVisual.visual.levelVisible`; false while under construction) */
    levelVisible?: boolean;
    /** recipe icon opacity (`recipeSprite.node.opacity`, faded together with the body) */
    recipeOpacity?: number;
    /** ring node `scaleX` (the original's `MAP[D.map].south ? -1 : 1`); negative mirrors the arc */
    ringScaleX?: number;
    /** multi-recipe building's recipe icon (atlas sprite name; corresponds to the prefab's RecipeSprite) */
    recipeKey?: string | null;
    /** whether the recipe background is shown (`recipeSpriteBg.active`) */
    recipeBgVisible?: boolean;
    /** body opacity 0~255 (100 while under construction) */
    spriteOpacity?: number;
    /** whether it is working (corresponds to the original's `isWorking`) */
    working?: boolean;
    /**
     * Whether the ring is **active** (aligns with the original's `EntityVisual.ring.active`).
     *
     * Do NOT substitute `working` for this. In the original the ring is only ever
     * switched on inside the `updateVisual()` gate
     * `if (canBuild(type) || isTradeCenter() || hasOutput(type))`
     * (`!ring.active && isWorking` => `ring.active = true`). Driving the draw from
     * `working` alone paints a ring the original never shows on special buildings
     * that cannot pass that gate (`PowerBank`, `ResourceBooster`, `IndustryZone`,
     * `Warehouse`, ...).
     */
    ringActive?: boolean;
    /** ring angle (radians). The original does `angle += 180°/s`, advanced by the caller per dt */
    ringAngle?: number;
    /** ring opacity (0~255), corresponds to the original's fade in/out when the working state changes */
    ringOpacity?: number;
    /** tint override (the original gives each building type its own color) */
    color?: Color;
}

interface BuildingsLike {
    buildings: BuildingVisual[];
}
