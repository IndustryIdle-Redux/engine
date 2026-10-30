/**
 * AngelCode BMFont (`.fnt`) parsing -- the font format the game actually uses.
 *
 * ### Why it is needed
 * The `Level` label of `Building.prefab` is **not** a system font:
 * ```
 * _isSystemFontUsed = false
 * _N$file = { __uuid__: "52edec31-ce25-43fc-a275-61580b0565bc" }   // → assets/Fonts/Overpass.fnt
 * _fontSize = 32   _lineHeight = 20
 * ```
 * which means the level number uses the **Overpass SemiBold bitmap font**.
 * Rendering it with a monospace fallback font would give clearly different glyph widths and shapes,
 * so the `.fnt` is parsed directly here, guaranteeing that glyphs, kerning and baseline all match the original.
 *
 * ### Format
 * `.fnt` is a text format, one `key=value` per line:
 * ```
 * info   face="Overpass SemiBold" size=42 padding=0,0,0,0 spacing=1,1
 * common lineHeight=42 base=32 scaleW=256 scaleH=256 pages=1
 * page   id=0 file="Overpass_0.png"
 * char   id=65 x=1 y=1 width=20 height=26 xoffset=1 yoffset=9 xadvance=16 page=0
 * ```
 *
 * ### Coordinate convention (critical)
 * BMFont has **+y downward**, and `yoffset` is the distance "from the line top to the glyph top";
 * the baseline position is `common.base`. This engine's world coordinates are **+y upward**,
 * and `BitmapFont`'s `offsetX/offsetY` mean the offset of the **glyph center relative to the pen position / baseline**,
 * so one conversion is needed (see `bMFontGlyphToGlyph`).
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

/**
 * Parse `.fnt` text.
 *
 * Fault tolerance: unknown lines (`kerning` etc.) and blank lines are ignored; missing fields get reasonable defaults,
 * so parsing does not fail wholesale because of font version differences.
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
                data.size = Number(kv["size"] ?? 0);
                break;
            case "common":
                data.lineHeight = Number(kv["lineHeight"] ?? 0);
                data.base = Number(kv["base"] ?? 0);
                data.scaleW = Number(kv["scaleW"] ?? 0);
                data.scaleH = Number(kv["scaleH"] ?? 0);
                break;
            case "page":
                data.pages[Number(kv["id"] ?? 0)] = kv["file"] ?? "";
                break;
            case "char":
                data.chars.push({
                    id: Number(kv["id"] ?? 0),
                    x: Number(kv["x"] ?? 0),
                    y: Number(kv["y"] ?? 0),
                    width: Number(kv["width"] ?? 0),
                    height: Number(kv["height"] ?? 0),
                    xoffset: Number(kv["xoffset"] ?? 0),
                    yoffset: Number(kv["yoffset"] ?? 0),
                    xadvance: Number(kv["xadvance"] ?? 0),
                    page: Number(kv["page"] ?? 0),
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
 * Conversion (BMFont +y downward → this engine's +y upward, with offsets relative to the **glyph center**):
 *  - center relative to the pen position: `xoffset + width/2`
 *  - center relative to the baseline: `base - yoffset - height/2`
 *
 * @param glyphAtlasRect the glyph's rectangle inside the atlas (the font page offset is already folded in)
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

/**
 * Build a `BitmapFont` from a parsed BMFont plus atlas information.
 *
 * @param data parse result
 * @param fontPageRect the rectangle of the font page (e.g. `Overpass.png`) **inside the atlas**
 * @param atlasWidth atlas width
 * @param atlasHeight atlas height
 * @param scale optional: scale the font design size to the target render size (default 1, i.e. render at the design size)
 */
export function createBitmapFontFromBMFont(
    data: BMFontData,
    fontPageRect: FontPageRect,
    atlasWidth: number,
    atlasHeight: number,
    scale = 1,
): BitmapFont {
    const baseSize = (data.size || data.lineHeight) * scale;
    const font = new BitmapFont(baseSize, {
        lineHeight: data.lineHeight * scale,
        // BMFont's base = distance from baseline to line top, used by baselineForCenterY for the conversion
        ascent: data.base * scale,
    });

    for (const c of data.chars) {
        // the glyph's rectangle in the **atlas** = font page rectangle + in-page offset
        const rect = {
            x: fontPageRect.x + c.x,
            y: fontPageRect.y + c.y,
            width: c.width,
            height: c.height,
        };
        // use the shared UV function (it already flips V per the UNPACK_FLIP_Y_WEBGL convention)
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
