/**
 * Atlas sub-rect UV tests.
 *
 * This locks down a convention that is **extremely easy to get wrong and extremely hard to notice once wrong**:
 * the texture is uploaded with `UNPACK_FLIP_Y_WEBGL = true` (the whole atlas is flipped),
 * while `q.y = 1` in `SpriteBatch` is the **top** of the quad.
 *
 * So for the "top of the quad" to show the sprite's **top row** `y`, it must be `v0 = 1 - (y+h)/H`,
 * not the intuitive `y/H`. Getting it wrong shows up as **every sprite flipped vertically and sampling the neighboring region**
 * -- which looks like "sprites shredded into pieces".
 *
 * ⚠️ Note: when doing an orientation test with the **whole texture** (uvPos=0, uvSize=1),
 * both formulas give 0, so this bug **cannot be caught**. A non-full sub-rect must be used,
 * which is also why this file exists.
 */

import { describe, expect, it } from "vitest";
import { atlasRectToUV } from "../src/renderer/Loader";

const ATLAS_W = 1024;
const ATLAS_H = 1024;

/**
 * Simulate GPU sampling: given a relative position `q` on the quad (0=bottom, 1=top),
 * work backward to the **image row** of the atlas that it samples.
 *
 * Basis: the texture is uploaded with UNPACK_FLIP_Y_WEBGL=true ⇒ `image row = (1 - v) · H`.
 */
function sampledImageRow(v0: number, dv: number, q: number): number {
    const v = v0 + q * dv;
    return (1 - v) * ATLAS_H;
}

describe("atlasRectToUV: the top of the quad must sample the sprite's top row", () => {
    // Deliberately pick a rect that is not at the top (otherwise y/H and 1-(y+h)/H could happen to be close)
    const rect = { x: 55, y: 597, width: 52, height: 40 };

    it("the top of the quad (q=1) samples rect.y", () => {
        const uv = atlasRectToUV(rect, ATLAS_W, ATLAS_H);
        expect(sampledImageRow(uv.v0, uv.dv, 1)).toBeCloseTo(rect.y, 6);
    });

    it("the bottom of the quad (q=0) samples rect.y + rect.height", () => {
        const uv = atlasRectToUV(rect, ATLAS_W, ATLAS_H);
        expect(sampledImageRow(uv.v0, uv.dv, 0)).toBeCloseTo(rect.y + rect.height, 6);
    });

    it("the u/v components all land in [0,1] without going out of bounds", () => {
        const uv = atlasRectToUV(rect, ATLAS_W, ATLAS_H);
        expect(uv.u0).toBeGreaterThanOrEqual(0);
        expect(uv.v0).toBeGreaterThanOrEqual(0);
        expect(uv.u0 + uv.du).toBeLessThanOrEqual(1.0001);
        expect(uv.v0 + uv.dv).toBeLessThanOrEqual(1.0001);
        expect(uv.du).toBeCloseTo(rect.width / ATLAS_W, 9);
        expect(uv.dv).toBeCloseTo(rect.height / ATLAS_H, 9);
    });

    it("regression: the intuitive v0 = y/H samples wrong (the top row lands near y+2h)", () => {
        const naiveV0 = rect.y / ATLAS_H;
        const naiveDv = rect.height / ATLAS_H;
        const sampled = sampledImageRow(naiveV0, naiveDv, 1);
        // With the intuitive formula the top samples content "below the sprite" instead of rect.y
        expect(Math.abs(sampled - rect.y)).toBeGreaterThan(rect.height);
        // The correct formula has zero error
        const uv = atlasRectToUV(rect, ATLAS_W, ATLAS_H);
        expect(Math.abs(sampledImageRow(uv.v0, uv.dv, 1) - rect.y)).toBeCloseTo(0, 6);
    });

    it("with the whole texture (uvPos=0, uvSize=1) both formulas are correct -- which is why it cannot catch the bug", () => {
        const full = { x: 0, y: 0, width: ATLAS_W, height: ATLAS_H };
        const uv = atlasRectToUV(full, ATLAS_W, ATLAS_H);
        expect(uv.v0).toBeCloseTo(0, 9);
        expect(uv.dv).toBeCloseTo(1, 9);
        // This is exactly why the "four-quadrant test" passed while missing the sub-rect bug
        expect(sampledImageRow(uv.v0, uv.dv, 1)).toBeCloseTo(0, 6);
        expect(sampledImageRow(uv.v0, uv.dv, 0)).toBeCloseTo(ATLAS_H, 6);
    });

    it("any rect satisfies \"top to top, bottom to bottom\" (covering the whole atlas)", () => {
        let s = 0x12345678;
        const rnd = (): number => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 0x100000000;
        };
        for (let i = 0; i < 500; i++) {
            const w = 1 + Math.floor(rnd() * 200);
            const h = 1 + Math.floor(rnd() * 200);
            const r = {
                x: Math.floor(rnd() * (ATLAS_W - w)),
                y: Math.floor(rnd() * (ATLAS_H - h)),
                width: w,
                height: h,
            };
            const uv = atlasRectToUV(r, ATLAS_W, ATLAS_H);
            expect(sampledImageRow(uv.v0, uv.dv, 1), `rect=${JSON.stringify(r)}`).toBeCloseTo(r.y, 4);
            expect(sampledImageRow(uv.v0, uv.dv, 0), `rect=${JSON.stringify(r)}`).toBeCloseTo(
                r.y + r.height,
                4,
            );
        }
    });
});
