/**
 * Bitmap font: glyph metrics, text layout, and instance emission.
 *
 * A glyph source is either an AngelCode BMFont atlas or explicit UV rectangles sliced from
 * an existing atlas. All metrics are in world pixels.
 */

import type { SpriteDrawCall } from "../InstanceBuffer";

/** A single glyph's metrics and UV */
export interface Glyph {
    /** atlas UV (0~1) */
    u0: number;
    v0: number;
    du: number;
    dv: number;
    /** rendered size (pixels) */
    width: number;
    height: number;
    /** offset relative to the pen position (pixels, +y up) */
    offsetX: number;
    offsetY: number;
    /** pen advance (pixels) */
    advance: number;
}

/** Line metrics */
export interface FontMetrics {
    /** baseline to top */
    ascent: number;
    /** baseline to bottom (usually negative) */
    descent: number;
    /** line height */
    lineHeight: number;
}

/** One laid-out glyph instance (with world coordinates and color) */
export interface LaidOutGlyph {
    glyph: Glyph;
    x: number;
    y: number;
    /** scale (relative to the glyph's original size) */
    scale: number;
}

export interface BitmapFontOptions {
    lineHeight?: number;
    /** default letter spacing (pixels, before scaling by fontSize) */
    letterSpacing?: number;
    /** space width (used when the character is not in the glyph table) */
    spaceWidth?: number;
}

/** Bitmap font. Immutable after loading, so many texts can share one instance. */
export class BitmapFont {
    private readonly glyphs = new Map<number, Glyph>();
    public readonly lineHeight: number;
    public readonly letterSpacing: number;
    public readonly spaceWidth: number;
    /** the glyphs' original design font size (used to compute the text scale factor) */
    public readonly baseSize: number;
    /**
     * Distance from the baseline to the top of the line (i.e. BMFont's `common.base`).
     *
     * Used by `baselineForCenterY()` to convert a text's visual center into a baseline.
     * Defaults to `lineHeight / 2`, which makes that conversion a zero adjustment.
     */
    public readonly ascent: number;

    constructor(baseSize: number, options: BitmapFontOptions & { ascent?: number } = {}) {
        this.baseSize = baseSize;
        this.lineHeight = options.lineHeight ?? baseSize * 1.2;
        this.letterSpacing = options.letterSpacing ?? 0;
        this.spaceWidth = options.spaceWidth ?? baseSize * 0.5;
        this.ascent = options.ascent ?? this.lineHeight / 2;
    }

    /**
     * Given the Y of a text's visual center, return the baseline Y that `layout()` expects.
     *
     * The two differ by `(ascent - lineHeight/2) * fontSize / baseSize`.
     */
    public baselineForCenterY(centerY: number, fontSize: number): number {
        const scale = fontSize / this.baseSize;
        return centerY - (this.ascent - this.lineHeight / 2) * scale;
    }

    /** Register a glyph (by UTF-16 code unit) */
    public setGlyph(char: string, glyph: Glyph): this {
        this.glyphs.set(char.charCodeAt(0), glyph);
        return this;
    }

    /** Register many glyphs at once */
    public setGlyphs(entries: Array<[string, Glyph]>): this {
        for (const [ch, g] of entries) this.setGlyph(ch, g);
        return this;
    }

    public getGlyph(char: string): Glyph | undefined {
        return this.glyphs.get(char.charCodeAt(0));
    }

    public hasGlyph(char: string): boolean {
        return this.glyphs.has(char.charCodeAt(0));
    }

    public get glyphCount(): number {
        return this.glyphs.size;
    }

    /**
     * Measure a single line of text (pixels); `scale` maps the design size to the target fontSize.
     */
    public measure(text: string, scale = 1): number {
        let w = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i] as string;
            const g = this.getGlyph(ch);
            if (g) {
                w += (g.advance + this.letterSpacing) * scale;
            } else if (ch === " ") {
                w += this.spaceWidth * scale;
            } else {
                // Missing glyph: advance by the space width, so the rest of the text does not shift
                w += this.spaceWidth * scale;
            }
        }
        return w;
    }

    /**
     * Lay out one line of text into glyph instances, writing into the caller-provided array
     * (cleared first) so the hot path allocates nothing.
     *
     * @param x starting world X (left/center/right edge depending on align)
     * @param y baseline world Y
     * @param fontSize target font size
     * @param out output array (cleared and then filled)
     */
    public layout(
        text: string,
        x: number,
        y: number,
        fontSize: number,
        align: "left" | "center" | "right" = "left",
        out: LaidOutGlyph[] = [],
    ): LaidOutGlyph[] {
        out.length = 0;
        const scale = fontSize / this.baseSize;
        const width = this.measure(text, scale);

        let penX = x;
        if (align === "center") penX -= width / 2;
        else if (align === "right") penX -= width;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i] as string;
            const g = this.getGlyph(ch);
            if (!g) {
                // Missing glyph (space included): advance by the space width, so the rest of the text does not shift
                penX += this.spaceWidth * scale;
                continue;
            }
            out.push({ glyph: g, x: penX + g.offsetX * scale, y: y + g.offsetY * scale, scale });
            penX += (g.advance + this.letterSpacing) * scale;
        }
        return out;
    }

    /**
     * Write a layout result straight into the sprite instance buffer, so text goes through
     * the same batch as sprites.
     *
     * @param layout obtained from `layout()`
     * @param push callback that writes a single instance
     */
    public emit(
        layout: readonly LaidOutGlyph[],
        push: (call: SpriteDrawCall) => void,
        color?: SpriteDrawCall["color"],
        opacity?: number,
    ): void {
        for (const item of layout) {
            const g = item.glyph;
            push({
                x: item.x,
                y: item.y,
                w: g.width * item.scale,
                h: g.height * item.scale,
                // bitmap glyph offsets are already baked into layout, so place with a center anchor
                ax: 0.5,
                ay: 0.5,
                u0: g.u0,
                v0: g.v0,
                du: g.du,
                dv: g.dv,
                ...(color !== undefined ? { color } : {}),
                ...(opacity !== undefined ? { opacity } : {}),
            });
        }
    }
}

/**
 * Slice an atlas on a uniform grid to build a monospace font (digits, `.`, `%`, `-`, ...).
 *
 * `tileU` / `tileDu` / `tileDv` are in atlas UV space and already include any padding around
 * the grid; `padding` trims further inside each tile to avoid bleeding between glyphs.
 */
export function buildMonospaceFont(
    chars: string,
    tileU: number,
    tileDu: number,
    tileDv: number,
    opts: {
        baseSize: number;
        /** glyph inset within the tile (pixels, to avoid bleeding between adjacent glyphs) */
        padding?: number;
        /** whether the rendered size is a multiple of baseSize */
        renderScale?: number;
        /** how many glyphs per atlas row (defaults to a value derived from tileDu) */
        columns?: number;
        lineHeight?: number;
    },
): BitmapFont {
    const { baseSize, padding = 0, renderScale = 1 } = opts;
    const font = new BitmapFont(baseSize, opts.lineHeight !== undefined ? { lineHeight: opts.lineHeight } : {});
    const size = baseSize * renderScale;
    const columns = opts.columns ?? Math.max(1, Math.round(1 / tileDu));
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] as string;
        const col = i % columns;
        const row = Math.floor(i / columns);
        font.setGlyph(ch, {
            u0: tileU + col * tileDu + (tileDu * padding) / size,
            v0: row * tileDv + (tileDv * padding) / size,
            du: tileDu - (tileDu * padding * 2) / size,
            dv: tileDv - (tileDv * padding * 2) / size,
            width: size,
            height: size,
            offsetX: 0,
            offsetY: 0,
            advance: size, // monospace: horizontal advance = rendered width
        });
    }
    return font;
}

/* ------------------------------------------------------------------ *
 * Generate a compact bitmap font from a Canvas
 * ------------------------------------------------------------------ */

export interface CanvasFontOptions {
    /** font size (pixels) — also serves as `BitmapFont.baseSize` */
    fontSize: number;
    fontFamily?: string;
    fontWeight?: string;
    /** padding around each glyph (pixels, to avoid bleeding between adjacent glyphs) */
    padding?: number;
    /** line height ratio (default 1.2) */
    lineHeightRatio?: number;
    /** space width (defaults to an estimate of 0.5 × font size) */
    spaceWidth?: number;
}

export interface CanvasFontResult {
    font: BitmapFont;
    /** the font atlas canvas (the caller is responsible for uploading it as a texture) */
    canvas: HTMLCanvasElement;
}

/**
 * Draw a bitmap font live on a Canvas, packed by actual glyph width so `advance` matches
 * the real font.
 */
export function createCanvasFont(chars: string, options: CanvasFontOptions): CanvasFontResult {
    const {
        fontSize,
        fontFamily = 'ui-monospace, Menlo, Consolas, "Courier New", monospace',
        fontWeight = "normal",
        padding = 2,
        lineHeightRatio = 1.2,
    } = options;

    const measureCanvas = document.createElement("canvas");
    const mctx = measureCanvas.getContext("2d");
    if (!mctx) throw new Error("[font] cannot create 2D context");
    mctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    mctx.textBaseline = "alphabetic";

    // measure each character's width
    const advances: number[] = [];
    let totalWidth = 0;
    for (let i = 0; i < chars.length; i++) {
        const w = Math.max(1, Math.ceil(mctx.measureText(chars[i] as string).width)) + padding * 2;
        advances.push(w);
        totalWidth += w;
    }

    const cellHeight = Math.ceil(fontSize * lineHeightRatio) + padding * 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, totalWidth);
    canvas.height = cellHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("[font] cannot create 2D context");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const font = new BitmapFont(fontSize, {
        lineHeight: cellHeight,
        spaceWidth: options.spaceWidth ?? fontSize * 0.5,
    });

    let x = 0;
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] as string;
        const w = advances[i] as number;
        // draw at the center of its cell (UV and cell boundaries correspond exactly, avoiding sampling the neighboring glyph)
        ctx.fillText(ch, x + w / 2, cellHeight / 2);
        font.setGlyph(ch, {
            u0: x / canvas.width,
            v0: 0,
            du: w / canvas.width,
            dv: 1,
            width: w,
            height: cellHeight,
            offsetX: 0,
            offsetY: 0,
            advance: w,
        });
        x += w;
    }
    return { font, canvas };
}
