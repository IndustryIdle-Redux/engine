/**
 * AngelCode BMFont (`.fnt`) parsing.
 *
 * Format: text lines of `key=value` pairs, for example:
 *   common lineHeight=42 base=32 scaleW=256 scaleH=256 pages=1
 *   char id=65 x=1 y=1 width=20 height=26 xoffset=1 yoffset=9 xadvance=16 page=0
 *
 * BMFont uses +y downward and `yoffset` measured from the line top; this engine's world
 * coordinates use +y upward with glyph offsets relative to the glyph center.
 */

import { BitmapFont } from "./BitmapFont";
import type { Glyph } from "./BitmapFont";
import { atlasRectToUV } from "./Loader";

export interface BMFontChar {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    xoffset: number;
    yoffset: number;
    xadvance: number;
    page: number;
}

export interface BMFontData {
    face: string;
    /** Font design size */
    size: number;
    /** Atlas page size */
    scaleW: number;
    scaleH: number;
    /** Line height */
    lineHeight: number;
    /** Distance from the baseline to the line top (+y downward) */
    base: number;
    pages: string[];
    chars: BMFontChar[];
}

/** Parse a line of `k=v k2="v2" ...` into an object */
function parseKeyValues(line: string): Record<string, string> {
    const out: Record<string, string> = {};
    // supports quoted values (which may contain spaces)
    const re = /(\w+)=("[^"]*"|[^\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
        const key = m[1] as string;
        let value = m[2] as string;
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        out[key] = value;
    }
    return out;
}

/** Read a numeric field, falling back to 0 when it is absent or not finite. */
function finiteOr(value: string | undefined): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Parse `.fnt` text.
 *
 * Unknown lines (`kerning` etc.) and blank lines are ignored; absent or non-finite numeric
 * fields default to 0, so version differences do not make parsing fail wholesale.
 */
export function parseBMFont(text: string): BMFontData {
    const data: BMFontData = {
        face: "",
        size: 0,
        scaleW: 0,
        scaleH: 0,
        lineHeight: 0,
        base: 0,
        pages: [],
        chars: [],
    };

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const spaceAt = line.indexOf(" ");
        const kind = spaceAt === -1 ? line : line.slice(0, spaceAt);
        const kv = parseKeyValues(spaceAt === -1 ? "" : line.slice(spaceAt + 1));

        switch (kind) {
            case "info":
                data.face = kv["face"] ?? "";
                data.size = finiteOr(kv["size"]);
                break;
            case "common":
                data.lineHeight = finiteOr(kv["lineHeight"]);
                data.base = finiteOr(kv["base"]);
                data.scaleW = finiteOr(kv["scaleW"]);
                data.scaleH = finiteOr(kv["scaleH"]);
                break;
            case "page":
                data.pages[finiteOr(kv["id"])] = kv["file"] ?? "";
                break;
            case "char":
                data.chars.push({
                    id: finiteOr(kv["id"]),
                    x: finiteOr(kv["x"]),
                    y: finiteOr(kv["y"]),
                    width: finiteOr(kv["width"]),
                    height: finiteOr(kv["height"]),
                    xoffset: finiteOr(kv["xoffset"]),
                    yoffset: finiteOr(kv["yoffset"]),
                    xadvance: finiteOr(kv["xadvance"]),
                    page: finiteOr(kv["page"]),
                });
                break;
            default:
                // kerning / charcount / custom lines: ignored
                break;
        }
    }
    return data;
}

/**
 * BMFont glyph → engine glyph.
 *
 * The glyph center relative to the pen position is `xoffset + width/2`; relative to the
 * baseline it is `base - yoffset - height/2`.
 *
 * @param uv the glyph's UV rectangle, with the font page offset already folded in
 */
export function bMFontGlyphToGlyph(
    c: BMFontChar,
    base: number,
    uv: { u0: number; v0: number; du: number; dv: number },
): Glyph {
    return {
        u0: uv.u0,
        v0: uv.v0,
        du: uv.du,
        dv: uv.dv,
        width: c.width,
        height: c.height,
        offsetX: c.xoffset + c.width / 2,
        offsetY: base - c.yoffset - c.height / 2,
        advance: c.xadvance,
    };
}

export interface FontPageRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

function requirePositive(value: number, field: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`[bmfont] ${field} must be a finite positive number (got ${String(value)})`);
    }
    return value;
}

/**
 * Build a `BitmapFont` from parsed BMFont data plus atlas information.
 *
 * Only single-page fonts are supported. Invalid metrics throw an `Error` prefixed with
 * `[bmfont]` that names the offending field.
 *
 * @param fontPageRect the font page rectangle (e.g. `Overpass.png`) inside the atlas
 * @param scale optional scale of the font design size (default 1)
 */
export function createBitmapFontFromBMFont(
    data: BMFontData,
    fontPageRect: FontPageRect,
    atlasWidth: number,
    atlasHeight: number,
    scale = 1,
): BitmapFont {
    // `pages` is sparse (indexed by page id), so count assigned entries rather than its length.
    const declaredPages = Object.keys(data.pages).length;
    const maxCharPage = data.chars.reduce((max, c) => Math.max(max, c.page), 0);
    const pageCount = Math.max(declaredPages, maxCharPage + 1);
    if (pageCount > 1 || data.chars.some((c) => c.page !== 0)) {
        throw new Error(`[bmfont] multi-page fonts are not supported (pages=${pageCount})`);
    }

    requirePositive(data.scaleW, "scaleW");
    requirePositive(data.scaleH, "scaleH");
    if (!Number.isFinite(data.lineHeight) || data.lineHeight <= 0) {
        throw new Error(`[bmfont] lineHeight must be a finite number > 0 (got ${String(data.lineHeight)})`);
    }
    if (!Number.isFinite(data.base)) {
        throw new Error(`[bmfont] base must be a finite number (got ${String(data.base)})`);
    }
    if (!Number.isFinite(data.size) || data.size < 0) {
        throw new Error(`[bmfont] size must be a finite number >= 0 (got ${String(data.size)})`);
    }

    const size = data.size === 0 ? data.lineHeight : data.size;
    const baseSize = size * scale;
    const font = new BitmapFont(baseSize, {
        lineHeight: data.lineHeight * scale,
        // BMFont's base is the distance from the baseline to the line top
        ascent: data.base * scale,
    });

    for (const c of data.chars) {
        // the glyph rectangle in the atlas = font page rectangle + in-page offset
        const rect = {
            x: fontPageRect.x + c.x,
            y: fontPageRect.y + c.y,
            width: c.width,
            height: c.height,
        };
        const uv = atlasRectToUV(rect, atlasWidth, atlasHeight);
        const glyph = bMFontGlyphToGlyph(c, data.base, uv);
        // scale affects the font size; scale the metrics by scale (UV stays the same)
        if (scale !== 1) {
            glyph.width *= scale;
            glyph.height *= scale;
            glyph.offsetX *= scale;
            glyph.offsetY *= scale;
            glyph.advance *= scale;
        }
        // BMFont's id is a Unicode code point; stored here as BMP
        font.setGlyph(String.fromCharCode(c.id), glyph);
    }
    return font;
}
