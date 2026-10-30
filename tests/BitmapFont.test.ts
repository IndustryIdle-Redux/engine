import { describe, expect, it } from "vitest";
import { BitmapFont, buildMonospaceFont } from "../src/renderer/BitmapFont";
import type { Glyph, LaidOutGlyph } from "../src/renderer/BitmapFont";

/** Build a test font: each glyph is 10×10 with an advance of 10 */
function makeFont(chars: string): BitmapFont {
    const font = new BitmapFont(10, { lineHeight: 12, spaceWidth: 5 });
    for (let i = 0; i < chars.length; i++) {
        const glyph: Glyph = {
            u0: i * 0.1,
            v0: 0,
            du: 0.1,
            dv: 0.1,
            width: 10,
            height: 10,
            offsetX: 0,
            offsetY: 0,
            advance: 10,
        };
        font.setGlyph(chars[i] as string, glyph);
    }
    return font;
}

describe("BitmapFont metrics", () => {
    it("monospace: width = character count × advance", () => {
        const font = makeFont("0123456789");
        expect(font.measure("123", 1)).toBeCloseTo(30, 9);
        expect(font.measure("12345", 1)).toBeCloseTo(50, 9);
    });

    it("scale scales the width proportionally", () => {
        const font = makeFont("0123456789");
        expect(font.measure("12345", 2)).toBeCloseTo(100, 9);
    });

    it("a space uses spaceWidth", () => {
        const font = makeFont("01");
        expect(font.measure("1 1", 1)).toBeCloseTo(25, 9); // 10 + 5 + 10
    });

    it("a missing glyph advances by the space width (no dropped glyphs, no wrong total width)", () => {
        const font = makeFont("01");
        expect(font.measure("1?1", 1)).toBeCloseTo(25, 9);
    });

    it("an empty string has width 0", () => {
        const font = makeFont("01");
        expect(font.measure("", 1)).toBe(0);
    });
});

describe("BitmapFont layout", () => {
    const font = makeFont("0123456789");

    it("left aligned: the first glyph sits at the start point", () => {
        const out = font.layout("123", 100, 50, 10, "left");
        expect(out).toHaveLength(3);
        expect(out[0]?.x).toBeCloseTo(100, 9);
        expect(out[1]?.x).toBeCloseTo(110, 9);
        expect(out[2]?.x).toBeCloseTo(120, 9);
    });

    it("center aligned: the start point shifts left by half the width", () => {
        const out = font.layout("123", 100, 0, 10, "center");
        expect(out[0]?.x).toBeCloseTo(85, 9); // 100 - 30/2
    });

    it("right aligned: the start point shifts left by the full width", () => {
        const out = font.layout("123", 100, 0, 10, "right");
        expect(out[0]?.x).toBeCloseTo(70, 9); // 100 - 30
    });

    it("fontSize scales the glyph size", () => {
        const out = font.layout("1", 0, 0, 20, "left");
        expect(out[0]?.scale).toBeCloseTo(2, 9);
    });

    it("reuses the output array (zero allocation on the hot path)", () => {
        const reuse: LaidOutGlyph[] = [];
        const a = font.layout("12345", 0, 0, 10, "left", reuse);
        const b = font.layout("12", 0, 0, 10, "left", reuse);
        expect(a).toBe(reuse);
        expect(b).toBe(reuse);
        expect(reuse).toHaveLength(2); // after the second layout only 2 remain
    });

    it("a missing glyph is skipped but still advances the pen", () => {
        const out = font.layout("1?2", 0, 0, 10, "left");
        expect(out).toHaveLength(2);
        // Pen advance: "1" advances 10, "?" advances 5 by spaceWidth ⇒ the third glyph is at x=15
        expect(out[1]?.x).toBeCloseTo(15, 9);
    });
});

describe("BitmapFont instance emission (the key path that replaces cc.Label)", () => {
    const font = makeFont("0123456789");

    it("emit produces one instance per glyph (not per node)", () => {
        const calls: Array<{ x: number; w: number; u0: number }> = [];
        const layout = font.layout("42", 0, 0, 10, "left");
        font.emit(layout, (c) => calls.push({ x: c.x, w: c.w ?? 0, u0: c.u0 ?? 0 }));
        expect(calls).toHaveLength(2);
        expect(calls[0]?.w).toBeCloseTo(10, 9);
        expect(calls[1]?.u0).toBeCloseTo(0.2, 9); // uv of the character "2"
    });

    it("color and opacity are passed through to the instance", () => {
        const seen: Array<unknown> = [];
        const layout = font.layout("1", 0, 0, 10, "left");
        font.emit(layout, (c) => seen.push(c.opacity), undefined, 128);
        expect(seen[0]).toBe(128);
    });

    it("10k tiles × 3 characters → 30,000 instances (versus the original's 10,000 Label nodes)", () => {
        let instances = 0;
        const text = "125";
        for (let i = 0; i < 10000; i++) {
            const layout = font.layout(text, i, 0, 10, "left");
            font.emit(layout, () => instances++);
        }
        expect(instances).toBe(30000);
    });
});

describe("buildMonospaceFont (splitting from an atlas)", () => {
    it("cuts all glyphs by row/column; UVs do not overlap and stay inside [0,1]", () => {
        const chars = "0123456789.%";
        const font = buildMonospaceFont(chars, 0, 0.1, 0.1, {
            baseSize: 20,
            columns: 4,
        });
        expect(font.glyphCount).toBe(chars.length);
        for (let i = 0; i < chars.length; i++) {
            const g = font.getGlyph(chars[i] as string);
            expect(g).toBeDefined();
            expect(g?.u0).toBeGreaterThanOrEqual(0);
            expect(g?.u0).toBeLessThanOrEqual(1);
            expect((g?.u0 ?? 0) + (g?.du ?? 0)).toBeLessThanOrEqual(1.0001);
            expect((g?.v0 ?? 0) + (g?.dv ?? 0)).toBeLessThanOrEqual(1.0001);
        }
    });

    it("columns determines where the row wraps", () => {
        const font = buildMonospaceFont("abcdefgh", 0, 0.25, 0.25, { baseSize: 10, columns: 4 });
        // The 5th character (index 4) should wrap to the second row
        const e = font.getGlyph("e");
        const a = font.getGlyph("a");
        expect(e?.v0).toBeGreaterThan(a?.v0 ?? 0);
        expect(e?.u0).toBeCloseTo(a?.u0 ?? 0, 9);
    });
});

describe("baselineForCenterY (prefab uses the node center, layout uses the baseline)", () => {
    it("the default font (ascent = lineHeight/2) converts to a zero adjustment", () => {
        const f = new BitmapFont(32, { lineHeight: 42 });
        expect(f.baselineForCenterY(100, 16)).toBeCloseTo(100, 9);
    });

    it("Overpass BMFont parameters: base=32, lineHeight=42, scale=0.5 → the center is 5.5 above the baseline", () => {
        const f = new BitmapFont(42, { lineHeight: 42, ascent: 32 });
        // For a target center of 100, the baseline should be 100 - (32 - 21) * 0.5 = 94.5
        expect(f.baselineForCenterY(100, 21)).toBeCloseTo(94.5, 9);
    });

    it("the larger the font size, the more the gap between center and baseline scales up", () => {
        const f = new BitmapFont(42, { lineHeight: 42, ascent: 32 });
        const small = 100 - f.baselineForCenterY(100, 21);
        const big = 100 - f.baselineForCenterY(100, 42);
        expect(big / small).toBeCloseTo(2, 6);
    });
});
