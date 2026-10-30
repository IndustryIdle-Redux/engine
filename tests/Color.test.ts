import { describe, expect, it } from "vitest";
import { Color, newColor } from "../src/Color";

describe("Color construction and hex parsing", () => {
    it("no-arg construction is opaque white (Cocos semantics)", () => {
        const c = new Color();
        expect([c.r, c.g, c.b, c.a]).toEqual([255, 255, 255, 255]);
        expect(c.toRGBValue()).toBe(0xffffff);
    });

    it("fromHEX parses 6-digit colors as opaque", () => {
        const c = new Color().fromHEX("#ef5350");
        expect([c.r, c.g, c.b, c.a]).toEqual([0xef, 0x53, 0x50, 255]);
        // Packed as ABGR, like Cocos: b<<16 | g<<8 | r.
        expect(c.toRGBValue()).toBe((0x50 << 16) | (0x53 << 8) | 0xef);
    });

    it("fromHEX / toHEX agree, with and without a leading #", () => {
        for (const hex of ["000000", "ffffff", "1e2832", "#74b9ff"]) {
            const c = new Color().fromHEX(hex);
            expect(c.toHEX()).toBe(hex.replace("#", ""));
        }
    });

    it("toHEX supports the #rgb and #rrggbbaa forms", () => {
        const c = new Color(0x12, 0x34, 0x56, 0x78);
        expect(c.toHEX("#rgb")).toBe("135");
        expect(c.toHEX("#rrggbbaa")).toBe("12345678");
        expect(c.toHEX("#rrggbb")).toBe("123456");
    });

    it("toRGBValue reflects direct channel writes", () => {
        const c = new Color(1, 2, 3, 4);
        c.setR(10).setG(20).setB(30);
        expect(c.toRGBValue()).toBe((30 << 16) | (20 << 8) | 10);
    });
});

describe("Color.lerp", () => {
    it("does not mutate the receiver and returns a new Color by default", () => {
        const from = new Color(10, 20, 30, 40);
        const to = new Color(50, 60, 70, 80);
        const result = from.lerp(to, 0.5);

        expect(result).not.toBe(from);
        expect(result).not.toBe(to);
        expect([from.r, from.g, from.b, from.a]).toEqual([10, 20, 30, 40]);
        expect([to.r, to.g, to.b, to.a]).toEqual([50, 60, 70, 80]);
        expect([result.r, result.g, result.b, result.a]).toEqual([30, 40, 50, 60]);
    });

    it("keeps the packed RGB value in sync with the interpolated channels", () => {
        const result = new Color(10, 20, 30, 40).lerp(new Color(50, 60, 70, 80), 0.5);

        // Packed value must match the channels instead of the initial 0xffffffff.
        expect(result.toRGBValue()).toBe((50 << 16) | (40 << 8) | 30);
        expect(result.toRGBValue()).not.toBe(0xffffff);
        expect(result.toHEX()).toBe("1e2832");

        // Round-tripping the hex string yields the same channels and packed value.
        const parsed = new Color().fromHEX(result.toHEX());
        expect([parsed.r, parsed.g, parsed.b]).toEqual([30, 40, 50]);
        expect(parsed.toRGBValue()).toBe(result.toRGBValue());
    });

    it("writes the result into out and syncs its packed value too", () => {
        const out = new Color();
        const returned = new Color(0, 0, 0, 0).lerp(new Color(255, 255, 255, 255), 1, out);

        expect(returned).toBe(out);
        expect([out.r, out.g, out.b, out.a]).toEqual([255, 255, 255, 255]);
        expect(out.toRGBValue()).toBe(0xffffff);
    });

    it("ratio 0 keeps the receiver's channels, ratio 1 becomes the target", () => {
        const from = new Color(1, 2, 3, 4);
        const to = new Color(101, 102, 103, 104);
        expect(from.lerp(to, 0).toRGBValue()).toBe((3 << 16) | (2 << 8) | 1);
        expect(from.lerp(to, 1).toRGBValue()).toBe((103 << 16) | (102 << 8) | 101);
    });

    it("newColor factory matches new Color() (no args = opaque white)", () => {
        expect(newColor().equals(new Color())).toBe(true);
        expect(newColor().toRGBValue()).toBe(0xffffff);
    });
});
