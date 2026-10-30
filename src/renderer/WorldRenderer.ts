/**
 * World-layer renderer: draws grid lines, deposits, buildings and the tile overlay.
 *
 * Everything is written into batched sprites or batched vector geometry; there are no scene nodes.
 * Only entities inside the visible rectangle are processed.
 *
 * Draw order: grid lines, deposits, buildings, overlay fills, overlay text. Overlay fills and
 * overlay text are submitted as two passes because the devices flush their batch whenever the
 * submission kind changes.
 */

import { Color } from "../Color";
import { cloneTheme, DEFAULT_THEME_NAME, getTheme, overlayGradient } from "./Theme";
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
import type { BitmapFont, LaidOutGlyph } from "./BitmapFont";
import type { RenderTexture } from "./RenderDevice";
import type { SpriteDrawCall } from "../InstanceBuffer";
import { warn } from "../log";

/* ------------------------------------------------------------------ *
 * Sprite source: name -> atlas UV + size + texture
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
    /** grid line color; defaults to `theme.grid` */
    gridColor?: Color;
    /** deposit tint; defaults to `theme.building` */
    depositColor?: Color;
    /** building tint; defaults to `theme.building` */
    buildingColor?: Color;
    /** ring tint; defaults to `theme.building` */
    ringColor?: Color;
    /** overlay text color; defaults to `theme.building` */
    textColor?: Color;
    /** whether to draw the overlay (the original's `hasOverlay`) */
    showOverlay: boolean;
    /** whether to draw grid lines */
    showGrid: boolean;
    /** overlay text font size */
    fontSize: number;

    /* Building geometry, taken from `Building.prefab`'s node transforms and content sizes. */
    /** building sprite scale (the prefab's Sprite node scale) */
    buildingScale: number;
    /** ring side length (the prefab's Ring content size) */
    ringSize: number;

    /* Badge geometry, from the prefab's child node transforms and content sizes. */
    /** offset of the bottom-left badge (Warning/TurnOff/PowerOff) */
    badgeOffsetX: number;
    badgeOffsetY: number;
    /** side length of TurnOff / PowerOff / Gear */
    badgeSize: number;
    /** Warning's width and height (the prefab's is not square) */
    warningWidth: number;
    warningHeight: number;
    /** construction gear offset */
    gearOffsetX: number;
    gearOffsetY: number;
    /** recipe icon offset and scale */
    recipeOffsetX: number;
    recipeOffsetY: number;
    recipeScale: number;
    /** scale of the recipe background circle */
    recipeBgScale: number;
    /** level digit font size */
    levelFontSize: number;
    /** level digit offset relative to the tile center */
    levelOffsetX: number;
    levelOffsetY: number;
    /** whether to draw the ring (the original shows it only for buildings that are working) */
    showRing: boolean;
    /** Whether the ring is mirrored horizontally on south maps. */
    ringFlipX: boolean;
    /** whether to draw the level digits */
    showLevel: boolean;
    /** whether to draw overlay color fills; turn off to see the text only */
    showOverlayFill: boolean;

    /** Active color theme; omitted colors above resolve from it. */
    theme: IColorTheme;
    /** Per-building tint override; returning null means use the theme's `building` color. */
    getBuildingColor?: (type: string) => Color | null;
    /** overlay color fill opacity, 0~255 */
    overlayAlpha: number;

    /** Minimum on-screen tile size (pixels) for drawing overlay fills. */
    overlayMinTilePx: number;

    /**
     * Minimum on-screen tile size (pixels) for drawing overlay text. Below it the glyphs are
     * only a few pixels tall and the font pass is skipped.
     */
    overlayTextMinTilePx: number;
    /** Minimum on-screen tile size (pixels) for drawing level digits. */
    levelTextMinTilePx: number;
    /** grid line width */
    lineWidth: number;
    /** selected-box line width multiplier */
    highlightExtraWidth: number;

    /* Deposit sizes, aligned with the original's `World.updateDepositVisual`. */
    /** deposit side length when centered on the tile */
    depositSize: number;
    /** deposit side length when placed shrunk-aside */
    depositAsideSize: number;
    /** position offset when placed shrunk-aside */
    depositAsideOffsetX: number;
    depositAsideOffsetY: number;
    /**
     * Whether this tile's deposit should be hidden (the miner produces exactly this deposit,
     * or a building can be placed on the tile). If not provided, always show.
     */
    shouldHideDeposit?: (key: string, depositType: string, buildingType: string) => boolean;

    /** Cull margin for buildings and deposits (world units); defaults to the building margin. */
    cullMargin?: number;
}

export const DEFAULT_WORLD_CONFIG: Omit<WorldRenderConfig, "gridKind" | "maxTile" | "tileSize"> = {
    showOverlay: true,
    showGrid: true,
    // The original uses `label.fontSize = 20` for the overlay and does not scale the node.
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
    theme: getTheme(DEFAULT_THEME_NAME),
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
 * Overlay inputs
 * ------------------------------------------------------------------ */

/** Value source for a single tile's overlay (in the game it is `getTileModifier(xy, buildingType)`) */
export type OverlayValueFn = (key: string) => number | null;

/** Single-tile overlay text: drawn text plus an optional color and opacity */
export interface OverlayText {
    text: string;
    /** falls back to the theme's text color if omitted */
    color?: Color;
    /** 0~255; fully opaque if omitted */
    opacity?: number;
}

/** Value source for single-tile overlay text */
export type OverlayTextFn = (key: string) => OverlayText | null;

/**
 * Common shape of a deposit entry, shared by the static `world.deposits` snapshot and the
 * runtime list. The runtime-only fields are optional so either list can be drawn in place.
 */
export interface DepositVisual {
    key: string;
    type: string;
    x: number;
    y: number;
    /** runtime only: size already computed by the world's deposit visual sync */
    size?: number;
    /** runtime only: false means hidden */
    active?: boolean;
    color?: Color;
    opacity?: number;
}

/**
 * World renderer.
 *
 * Usage per frame:
 * ```ts
 * world.drawGrid();
 * world.drawDeposits(generated);
 * world.drawBuildings({ buildings });
 * world.drawOverlay(generated.tiles, valueOf);
 * ```
 */
export class WorldRenderer {
    private readonly renderer: Renderer2D;
    private readonly config: WorldRenderConfig;
    private sprites: SpriteSource | null = null;
    private font: BitmapFont | null = null;
    private fontTexture: RenderTexture | null = null;

    /** Reused line segment buffer */
    private gridLines: LineSegment[] = [];
    /** Grid geometry cache key (the quantized visible rect) */
    private gridCacheKey = "";
    /** Cache hit/miss stats */
    public readonly gridCacheStats = { hit: 0, miss: 0 };

    /** Reused visible-rect object for the tile bounds */
    private readonly visibleRect = { x: 0, y: 0, width: 0, height: 0 };

    /** Reused visible-building list (avoids one array per frame) */
    private readonly visibleBuildings: BuildingVisual[] = [];
    /** Reused layout output for `BitmapFont.layout` (consumed immediately by `emit`) */
    private readonly glyphScratch: LaidOutGlyph[] = [];
    /** Reused overlay fill color */
    private readonly overlayColor = new Color();

    /** Cached overlay strings: "0%" .. "100%" */
    private readonly percentTexts: string[] = Array.from({ length: 101 }, (_, i) => `${i}%`);
    /** Cached level-digit strings */
    private readonly levelTexts = new Map<number, string>();
    /** Sprite names that have already produced a missing-sprite warning */
    private readonly warnedMissingSprites = new Set<string>();

    /** Shared font instance push callback (the batch copies the instance data immediately) */
    private readonly pushFontGlyph = (call: SpriteDrawCall): void => {
        if (this.fontTexture) this.renderer.drawSprite(this.fontTexture, call);
    };

    /**
     * Overlay collection buffers, reused every frame.
     *
     * Fills and texts are collected first and then submitted in two passes, so the visible tile
     * count does not affect the draw-call count.
     */
    private overlayX = new Float64Array(256);
    private overlayY = new Float64Array(256);
    private overlayValue = new Float64Array(256);
    private overlayCount = 0;

    /** Stats for the HUD / perf panel; per-frame counters are reset by the draw entry points. */
    public stats = {
        gridLines: 0,
        deposits: 0,
        /** deposits hidden because the miner produces them / the tile is buildable */
        depositsHidden: 0,
        buildings: 0,
        /** number of rings drawn this frame */
        rings: 0,
        /** number of level digit glyphs drawn this frame */
        levelGlyphs: 0,
        /** buildings whose level digits were skipped by the LOD this frame */
        levelTextSuppressed: 0,
        /** number of highlighted tiles drawn this frame */
        selected: 0,
        overlayCells: 0,
        textGlyphs: 0,
        /** number of status badges drawn this frame (Warning/TurnOff/PowerOff/Gear) */
        badges: 0,
        /** atlas sprites that were requested but missing this frame */
        missingSprites: 0,
    };

    constructor(renderer: Renderer2D, config: WorldRenderConfig) {
        this.renderer = renderer;
        // Own a copy of the theme: two renderers must not share mutable colors.
        this.config = { ...config, theme: cloneTheme(config.theme) };
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
        if (patch.theme) this.config.theme = cloneTheme(patch.theme);
    }

    /* ---------------- resolved colors ---------------- */

    private gridColor(): Color {
        return this.config.gridColor ?? this.config.theme.grid;
    }

    private depositColor(): Color {
        return this.config.depositColor ?? this.config.theme.building;
    }

    private buildingColor(): Color {
        return this.config.buildingColor ?? this.config.theme.building;
    }

    private ringColor(): Color {
        return this.config.ringColor ?? this.config.theme.building;
    }

    private textColor(): Color {
        return this.config.textColor ?? this.config.theme.building;
    }

    /* ---------------- grid ---------------- */

    /**
     * Submit the visible grid lines.
     *
     * This is the frame-start pass, so it also resets the counters that later passes
     * increment (rings, badges, selected, missingSprites).
     */
    public drawGrid(): void {
        this.stats.gridLines = 0;
        this.stats.rings = 0;
        this.stats.badges = 0;
        this.stats.selected = 0;
        this.stats.missingSprites = 0;
        if (!this.config.showGrid) return;
        const visible = this.renderer.getVisibleRect();
        const { gridKind, maxTile, tileSize } = this.config;

        // The generator without dedup emits each tile's owned edges only. The rect is quantized
        // by tileSize and padded, so a still or slowly panning camera reuses the cached edges.
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

        // Line width follows the original's LINE_WIDTH / sqrt(zoom).
        const width = this.config.lineWidth / Math.sqrt(this.renderer.camera.zoom);
        this.renderer.drawSegments(this.gridLines, width, this.gridColor());
        this.stats.gridLines = this.gridLines.length;
    }

    /**
     * Get a tile's polygon vertices (hexagon or square), used for selection highlights.
     * Hexagons use `hexCornerOffsets`; a square has side `tileSize`.
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

    /** Highlight a single tile. */
    public drawSelected(x: number, y: number): void {
        this.renderer.strokePolyline(
            this.tilePolygon(x, y),
            this.selectedLineWidth(),
            true,
            this.config.theme.gridSelected,
        );
        this.stats.selected++;
    }

    /** Highlight multiple tiles (batch selection / placement preview). */
    public drawHighlightGrids(cells: ReadonlyArray<{ x: number; y: number }>): void {
        if (cells.length === 0) return;
        const width = this.selectedLineWidth();
        const color = this.config.theme.gridSelected;
        for (const c of cells) {
            this.renderer.strokePolyline(this.tilePolygon(c.x, c.y), width, true, color);
            this.stats.selected++;
        }
    }

    /* ---------------- deposits ---------------- */

    /**
     * Submit deposits.
     *
     * Position and size follow the original's `World.updateDepositVisual`: 24x24 centered when
     * the tile is clear and the overlay is off, otherwise 12x12 offset by (-16, -16).
     *
     * @param world the generated world
     * @param buildingTypeByKey this tile's building type (key -> type)
     * @param overlayActive whether the tile-modifier overlay is shown (the original's
     * `World.hasOverlay`; it is not the same as `showOverlay`)
     * @param runtimeDeposits runtime deposit list; takes precedence over `world.deposits`
     */
    public drawDeposits(
        world: GeneratedWorld,
        buildingTypeByKey?: ReadonlyMap<string, string>,
        overlayActive = false,
        runtimeDeposits?: ReadonlyArray<DepositVisual>,
    ): void {
        this.stats.deposits = 0;
        this.stats.depositsHidden = 0;

        const cfg = this.config;
        const camera = this.renderer.camera;
        const texture = this.sprites?.texture;
        const margin = cfg.cullMargin ?? Math.max(cfg.depositSize, cfg.ringSize);
        const hasOverlay = overlayActive;
        let drawn = 0;
        let hidden = 0;

        // The static snapshot is iterated directly instead of being mapped into a normalized
        // list, which would allocate one object per deposit per frame.
        const list: ReadonlyArray<DepositVisual> = runtimeDeposits ?? world.deposits;
        const hasRuntime = runtimeDeposits !== undefined;

        for (const d of list) {
            if (d.active === false) continue;
            const buildingType = buildingTypeByKey?.get(d.key);

            if (buildingType && cfg.shouldHideDeposit?.(d.key, d.type, buildingType)) {
                hidden++;
                continue;
            }

            // Runtime entries already carry the size computed by the world layer.
            const aside = hasOverlay || buildingType !== undefined;
            const size = hasRuntime ? (d.size ?? cfg.depositSize) : aside ? cfg.depositAsideSize : cfg.depositSize;
            const x = d.x;
            const y = d.y;

            if (!camera.isPointVisible(x, y, margin)) continue;

            const sprite = this.sprites?.get(d.type);
            if (!sprite || !texture) {
                this.noteMissingSprite(d.type);
                continue;
            }
            this.renderer.drawSprite(texture, {
                x,
                y,
                // The original stretches the sprite to the target size via node width/height.
                w: size,
                h: size,
                u0: sprite.u0,
                v0: sprite.v0,
                du: sprite.du,
                dv: sprite.dv,
                color: d.color ?? this.depositColor(),
                opacity: d.opacity ?? 255,
            });
            drawn++;
        }
        this.stats.deposits = drawn;
        this.stats.depositsHidden = hidden;
    }

    /* ---------------- buildings ---------------- */

    /**
     * Submit buildings.
     *
     * Each building is drawn as: ring (working only), body, recipe icon/background, status
     * badges, then level digits. Sprites sharing the atlas texture stay in one batch; the level
     * digits use the font texture and are therefore submitted last.
     */
    public drawBuildings(world: BuildingsLike): void {
        this.stats.buildings = 0;
        this.stats.rings = 0;
        this.stats.levelGlyphs = 0;
        this.stats.levelTextSuppressed = 0;
        this.stats.badges = 0;

        const camera = this.renderer.camera;
        const cfg = this.config;
        const margin = cfg.cullMargin ?? Math.max(96, cfg.ringSize);
        const atlas = this.sprites;
        const texture = atlas?.texture;
        const ringSprite = atlas?.get("Ring");

        // Collect the visible buildings first, then draw in passes by texture.
        const visible = this.visibleBuildings;
        visible.length = 0;
        for (const b of world.buildings) {
            if (camera.isPointVisible(b.x, b.y, margin)) visible.push(b);
        }

        let rings = 0;
        let levels = 0;

        // Pass 1: building bodies (atlas texture).
        for (const b of visible) {
            const sprite = atlas?.get(b.type);
            if (!sprite || !texture) {
                this.noteMissingSprite(b.type);
                continue;
            }
            this.renderer.drawSprite(texture, {
                x: b.x,
                y: b.y,
                w: sprite.width * cfg.buildingScale,
                h: sprite.height * cfg.buildingScale,
                u0: sprite.u0,
                v0: sprite.v0,
                du: sprite.du,
                dv: sprite.dv,
                color: b.color ?? this.buildingColor(),
                // Under construction the body is semi-transparent (the original uses opacity 100).
                opacity: b.underConstruction ? 100 : (b.spriteOpacity ?? 255),
            });
        }

        // Pass 1.5: recipe background and recipe icon (atlas texture).
        for (const b of visible) {
            const color = b.color ?? this.buildingColor();
            if (b.recipeBgVisible) {
                const bg = atlas?.get("Circle_100x100");
                if (bg) {
                    const side = Math.max(bg.width, bg.height) * cfg.recipeBgScale;
                    this.drawAtlasSprite("Circle_100x100", b.x, b.y, side, side, cfg.theme.background);
                }
            }
            if (b.recipeKey) {
                const r = atlas?.get(b.recipeKey);
                if (r) {
                    this.drawAtlasSprite(
                        b.recipeKey,
                        b.x + cfg.recipeOffsetX,
                        b.y + cfg.recipeOffsetY,
                        r.width * cfg.recipeScale,
                        r.height * cfg.recipeScale,
                        color,
                        // Faded together with the body while not working / under construction.
                        b.recipeOpacity ?? 255,
                    );
                }
            }
        }

        // Pass 2: rings (atlas texture, drawn on top of the bodies).
        if (cfg.showRing && ringSprite && texture) {
            for (const b of visible) {
                if (!b.ringActive) continue;
                this.renderer.drawSprite(texture, {
                    x: b.x,
                    y: b.y,
                    // Mirroring uses a negative width (the original's `scaleX = -1`); the entity's
                    // own value wins, `ringFlipX` is the config fallback.
                    w: ((b.ringScaleX ?? (cfg.ringFlipX ? -1 : 1)) < 0 ? -cfg.ringSize : cfg.ringSize),
                    h: cfg.ringSize,
                    u0: ringSprite.u0,
                    v0: ringSprite.v0,
                    du: ringSprite.du,
                    dv: ringSprite.dv,
                    rotation: b.ringAngle ?? 0,
                    color: b.color ?? this.ringColor(),
                    opacity: b.ringOpacity ?? 255,
                });
                rings++;
            }
        }

        // Pass 2.5: status badges (atlas texture). Warning/TurnOff/PowerOff are mutually
        // exclusive; the construction gear is drawn separately because it can appear with them.
        let badges = 0;
        for (const b of visible) {
            const color = b.color ?? this.buildingColor();
            const bx = b.x + cfg.badgeOffsetX;
            const by = b.y + cfg.badgeOffsetY;
            if (b.warning) {
                if (this.drawAtlasSprite("Warning", bx, by, cfg.warningWidth, cfg.warningHeight, color)) badges++;
            } else if (b.turnOff) {
                // the prefab's TurnOff node is bound to the "Off" image
                if (this.drawAtlasSprite("Off", bx, by, cfg.badgeSize, cfg.badgeSize, color)) badges++;
            } else if (b.noPower) {
                if (this.drawAtlasSprite("PowerOff", bx, by, cfg.badgeSize, cfg.badgeSize, color)) badges++;
            }
        }
        for (const b of visible) {
            if (!b.underConstruction) continue;
            // The gear is tinted with the theme's building color or hq color (unpaid), not the
            // building's own tint.
            if (
                this.drawAtlasSprite(
                    "Gear",
                    b.x + cfg.gearOffsetX,
                    b.y + cfg.gearOffsetY,
                    cfg.badgeSize,
                    cfg.badgeSize,
                    b.underConstructionColor ?? b.color ?? this.buildingColor(),
                    b.underConstructionOpacity ?? 255,
                    b.underConstructionAngle ?? 0,
                )
            ) {
                badges++;
            }
        }
        this.stats.badges = badges;

        // Pass 3: level digits (font texture, drawn last).
        //
        // Below `levelTextMinTilePx` the digits are only a few pixels tall and are skipped;
        // they are also what adds the font texture to the sprite layer.
        const levelPx = cfg.tileSize * camera.zoom;
        const drawLevel = cfg.showLevel && levelPx >= cfg.levelTextMinTilePx;
        let levelSuppressed = 0;
        const font = this.font;
        if (drawLevel && font && this.fontTexture) {
            for (const b of visible) {
                // Driven by the entity's `levelVisible`, not by `level > 0`: a new building has
                // level 1 while under construction and the original hides the level then.
                if (!b.levelVisible) continue;
                // The level offset is the node center; layout wants a baseline.
                const layout = font.layout(
                    this.levelText(b.level),
                    b.x + cfg.levelOffsetX,
                    font.baselineForCenterY(b.y + cfg.levelOffsetY, cfg.levelFontSize),
                    cfg.levelFontSize,
                    "center",
                    this.glyphScratch,
                );
                font.emit(layout, this.pushFontGlyph, b.color ?? this.buildingColor());
                levels += layout.length;
            }
        } else if (cfg.showLevel) {
            for (const b of visible) if (b.levelVisible) levelSuppressed++;
        }

        this.stats.buildings = visible.length;
        this.stats.rings = rings;
        this.stats.levelGlyphs = levels;
        this.stats.levelTextSuppressed = levelSuppressed;
    }

    /* ---------------- overlay ---------------- */

    /**
     * Submit the overlay (color fills and text) in two passes.
     *
     * Fills and texts are collected into reused buffers first, so the overlay costs a constant
     * number of draw calls regardless of the visible tile count. One visit closure is allocated
     * per call; `BitmapFont.emit` allocates one small draw-call object per glyph, which the
     * device copies immediately.
     *
     * @param tiles tile list (from `GeneratedWorld.tiles`)
     * @param valueOf value function; returning null skips the tile
     * @param occupied tiles with buildings, which are not drawn
     */
    public drawOverlay(
        tiles: GeneratedWorld["tiles"],
        valueOf: OverlayValueFn,
        occupied?: ReadonlySet<string>,
    ): void {
        this.stats.overlayCells = 0;
        this.stats.textGlyphs = 0;
        if (!this.config.showOverlay || !this.font || !this.fontTexture) return;

        const camera = this.renderer.camera;
        const half = this.config.tileSize / 2;
        const sides = this.config.gridKind === "hex" ? 6 : 4;
        const startAngle = Math.PI / (this.config.gridKind === "hex" ? 6 : 4);

        // LOD: a tile's on-screen pixels = world size * zoom.
        const tilePx = this.config.tileSize * camera.zoom;
        if (tilePx < this.config.overlayMinTilePx) return;
        const drawText = tilePx >= this.config.overlayTextMinTilePx;

        // Every tile uses the same fill shape.
        const fillTemplate = this.config.showOverlayFill
            ? this.renderer.polygonTemplate(this.config.tileSize * 0.52, sides, startAngle)
            : null;

        // Pass 0: collect, without submitting anything.
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

        // Pass 1: every fill (one vector layer).
        if (fillTemplate) {
            const theme = this.config.theme;
            const alpha = this.config.overlayAlpha;
            for (let i = 0; i < this.overlayCount; i++) {
                overlayGradient(theme, this.overlayValue[i] as number, alpha, this.overlayColor);
                this.renderer.fillPolygonTemplateAt(
                    fillTemplate,
                    this.overlayX[i] as number,
                    this.overlayY[i] as number,
                    this.overlayColor,
                );
            }
        }

        // Pass 2: every text (one sprite batch).
        let glyphs = 0;
        if (drawText) {
            const color = this.textColor();
            for (let i = 0; i < this.overlayCount; i++) {
                glyphs += this.emitOverlayText(
                    this.overlayX[i] as number,
                    this.overlayY[i] as number,
                    this.percentText(this.overlayValue[i] as number),
                    color,
                );
            }
        }

        this.stats.overlayCells = this.overlayCount;
        this.stats.textGlyphs = glyphs;
    }

    /**
     * Submit the text-only overlay (no color fills).
     *
     * @param tiles tile list (from `GeneratedWorld.tiles`)
     * @param textOf value function; returning null skips the tile
     * @param occupied tiles with buildings, which are not drawn
     */
    public drawOverlayText(
        tiles: GeneratedWorld["tiles"],
        textOf: OverlayTextFn,
        occupied?: ReadonlySet<string>,
    ): void {
        this.stats.overlayCells = 0;
        this.stats.textGlyphs = 0;
        if (!this.config.showOverlay || !this.font || !this.fontTexture) return;

        const camera = this.renderer.camera;
        const half = this.config.tileSize / 2;
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
                spec.color ?? this.textColor(),
                spec.opacity,
            );
            cells++;
        });
        this.stats.overlayCells = cells;
        this.stats.textGlyphs = glyphs;
    }

    /**
     * Visit the tiles that can be inside the camera's visible rectangle.
     *
     * The row/column range is derived from the same layout the tiles were generated with and is
     * a conservative superset; the exact `isPointVisible` predicate is still applied per tile.
     * When `tiles` is not the canonical dense list, fall back to the linear scan.
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
            // a hex tile's x is (col + (row & 1 ? 0.5 : 0)) * colStep + width / 2
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

    /** Double the overlay collection buffers when the visible tile count outgrows them */
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

    /* ---------------- helpers ---------------- */

    /**
     * Draw one atlas sprite (shared by the recipe icon and the badges).
     * Returns false when the sprite or texture is missing.
     */
    private drawAtlasSprite(
        name: string,
        x: number,
        y: number,
        w: number,
        h: number,
        color: Color,
        opacity = 255,
        rotation = 0,
    ): boolean {
        const sp = this.sprites?.get(name);
        const texture = this.sprites?.texture;
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
    }

    /**
     * Note a missing atlas sprite. A missing body sprite is not replaced by vector geometry:
     * that would switch layers and make the draw-call count depend on entity count.
     */
    private noteMissingSprite(name: string): void {
        this.stats.missingSprites++;
        if (this.warnedMissingSprites.has(name)) return;
        this.warnedMissingSprites.add(name);
        warn(`[world] missing sprite "${name}" in the atlas; nothing drawn for it`);
    }

    /** Draw one piece of overlay text centered on the tile center; returns the glyph count. */
    private emitOverlayText(x: number, y: number, text: string, color: Color, opacity?: number): number {
        const font = this.font;
        if (!font || !this.fontTexture) return 0;
        const layout = font.layout(
            text,
            x,
            font.baselineForCenterY(y, this.config.fontSize),
            this.config.fontSize,
            "center",
            this.glyphScratch,
        );
        font.emit(layout, this.pushFontGlyph, color, opacity);
        return layout.length;
    }

    /** Cached "N%" string for overlay values in [0, 1]. */
    private percentText(value: number): string {
        const n = Math.round(value * 100);
        return this.percentTexts[n] ?? `${n}%`;
    }

    /** Cached level-digit string. */
    private levelText(level: number): string {
        let text = this.levelTexts.get(level);
        if (text === undefined) {
            text = `${level}`;
            this.levelTexts.set(level, text);
        }
        return text;
    }
}

/** Minimal shape of a building list (so the engine does not depend on game types) */
export interface BuildingVisual {
    key: string;
    /** building type (the sprite name in the atlas) */
    type: string;
    /** world coordinates (tile center) */
    x: number;
    y: number;
    level: number;
    /** out-of-power badge (the prefab's TurnOff node, image "Off") */
    turnOff?: boolean;
    /** not-enough-power badge (the prefab's PowerOff node) */
    noPower?: boolean;
    /** warning badge (the prefab's Warning node) */
    warning?: boolean;
    /** under construction: body semi-transparent plus the Gear badge */
    underConstruction?: boolean;
    /** construction gear's spin angle (radians) */
    underConstructionAngle?: number;
    /** construction gear tint (the theme's building or hq color, not the building's tint) */
    underConstructionColor?: Color;
    /** construction gear opacity: 100 for unpaid, 255 otherwise */
    underConstructionOpacity?: number;
    /** whether the level node is active (false while under construction) */
    levelVisible?: boolean;
    /** recipe icon opacity */
    recipeOpacity?: number;
    /** ring node `scaleX`; negative mirrors the arc */
    ringScaleX?: number;
    /** multi-recipe building's recipe icon (atlas sprite name) */
    recipeKey?: string | null;
    /** whether the recipe background is shown */
    recipeBgVisible?: boolean;
    /** body opacity 0~255 (100 while under construction) */
    spriteOpacity?: number;
    /** whether it is working */
    working?: boolean;
    /**
     * Whether the ring is active. This is the original's `EntityVisual.ring.active`, which stays
     * off for special buildings that never pass its `canBuild` gate; do not drive it from
     * `working` alone.
     */
    ringActive?: boolean;
    /** ring angle (radians), advanced per dt by the caller */
    ringAngle?: number;
    /** ring opacity 0~255 */
    ringOpacity?: number;
    /** tint override */
    color?: Color;
}

interface BuildingsLike {
    buildings: BuildingVisual[];
}
