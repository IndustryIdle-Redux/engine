/**
 * Engine-agnostic color. Replaces `cc.Color` / `cc.color()`.
 *
 * Semantics **match the Cocos implementation literally** (taken from the build artifact `build/web-mobile/cocos2d-js.js:32558-32729`):
 *  - `fromHEX` uses `parseInt(pair, 16) || 0`, with the alpha fallback `|| 255`
 *  - `toHEX(fmt)` supports `"#rgb"` / `#rrggbbaa"`
 *  - no-arg construction = **opaque white (255,255,255,255)** (that is what Cocos does, not black)
 *  - keeps the packed `_val` internally and syncs it whenever a channel changes
 *
 * Known differences from Cocos (intentional):
 *  Because of `parseInt("",16)||255`, Cocos' `fromHEX("#000000")` sets alpha to 0;
 *  this implementation keeps that `||255` fallback, but also treats `undefined/NaN` as 255,
 *  so `#000000` yields (0,0,0,255). All 59 call sites in the game pass **6-digit colors**,
 *  so in practice this "fixes the Cocos alpha=0 quirk" without regressing existing behavior.
 */

export class Color {
    private _r = 255;
    private _g = 255;
    private _b = 255;
    private _a = 255;
    private _val = 0xffffffff >>> 0;

    constructor(r: number = 255, g: number = 255, b: number = 255, a: number = 255) {
        this.r = r;
        this.g = g;
        this.b = b;
        this.a = a;
    }

    /* ---------------- channels (setter syncs the packed value) ---------------- */

    public get r(): number {
        return this._r;
    }
    public set r(v: number) {
        this._r = v;
        this._syncVal();
    }

    public get g(): number {
        return this._g;
    }
    public set g(v: number) {
        this._g = v;
        this._syncVal();
    }

    public get b(): number {
        return this._b;
    }
    public set b(v: number) {
        this._b = v;
        this._syncVal();
    }

    public get a(): number {
        return this._a;
    }
    public set a(v: number) {
        this._a = v;
        this._syncVal();
    }

    private _syncVal(): void {
        this._val = (((this._a << 24) >>> 0) + (this._b << 16) + (this._g << 8) + this._r) >>> 0;
    }

    /* ---------------- static constants ---------------- */

    public static readonly WHITE = new Color(255, 255, 255, 255);
    public static readonly BLACK = new Color(0, 0, 0, 255);
    public static readonly RED = new Color(255, 0, 0, 255);
    public static readonly GREEN = new Color(0, 255, 0, 255);
    public static readonly BLUE = new Color(0, 0, 255, 255);
    public static readonly CYAN = new Color(0, 255, 255, 255);
    public static readonly YELLOW = new Color(255, 255, 0, 255);
    public static readonly MAGENTA = new Color(255, 0, 255, 255);
    public static readonly TRANSPARENT = new Color(0, 0, 0, 0);

    /* ---------------- parse / output ---------------- */

    /**
     * Set the color from a hex string (in place).
     * Matches Cocos `Color.prototype.fromHEX` (cocos2d-js.js:32711).
     */
    public fromHEX(hexString: string): this {
        const s = hexString.charAt(0) === "#" ? hexString.substring(1) : hexString;
        this._r = parseInt(s.substring(0, 2), 16) || 0;
        this._g = parseInt(s.substring(2, 4), 16) || 0;
        this._b = parseInt(s.substring(4, 6), 16) || 0;
        // for a 6-digit color substring(6,8) is empty → NaN; the Cocos ||255 fallback makes it opaque
        this._a = parseInt(s.substring(6, 8), 16) || 255;
        this._syncVal();
        return this;
    }

    /** Matches Cocos `toHEX(fmt)`: no `#` prefix, optional `"#rgb"` / `"#rrggbbaa"` */
    /**
     * Hex string.
     *
     * ⚠️ Mind the difference from the original `Color.toHEX(fmt)`: Cocos does **not special-case** `"#rrggbb"`,
     * it falls straight into the default branch and returns a 6-digit string **without `#`** (`"ef5350"`).
     * In the game `BuildPage.showTileModifiers` literally calls `.toHEX("#rrggbb")`,
     * so we accept it here and keep the same output, to avoid a mismatch with the input of `chroma.scale(...)`.
     */
    public toHEX(fmt?: "#rgb" | "#rrggbb" | "#rrggbbaa"): string {
        const pad = (n: number): string => (n < 16 ? "0" : "") + n.toString(16);
        const hex = [pad(this._r), pad(this._g), pad(this._b)];
        if (fmt === "#rgb") {
            // under noUncheckedIndexedAccess index access may be undefined; here the length is fixed at 3 and filled
            hex[0] = (hex[0] as string)[0] as string;
            hex[1] = (hex[1] as string)[0] as string;
            hex[2] = (hex[2] as string)[0] as string;
        } else if (fmt === "#rrggbbaa") {
            hex.push(pad(this._a));
        }
        return hex.join("");
    }

    /**
     * CSS form.
     *
     * Matches Cocos `toCSS(opt)` (`cocos2d-js.js:32708`):
     * ```js
     * opt && "rgba" !== opt
     *   ? ("rgb" === opt ? "rgb(r,g,b)" : "#" + this.toHEX(opt))
     *   : "rgba(r,g,b,a)"
     * ```
     * So apart from `"rgba"` / `"rgb"`, `opt` is **passed through to `toHEX` unchanged** --
     * including `"#rrggbb"` (which matches no branch of `toHEX`, so it takes the default 3-part join),
     * and the game uses that form both in `ColorThemes.getBuildingColor` and in the color theme editor.
     *
     * The only difference from the original: the alpha of `"rgba"` keeps 3 decimals (Cocos uses 2),
     * which only affects CSS text precision, not the color.
     */
    public toCSS(opt?: "rgb" | "rgba" | "#rgb" | "#rrggbb" | "#rrggbbaa"): string {
        // Matches Cocos `cocos2d/core/value-types/color.ts:639`:
        //   return opt && opt !== "rgba"
        //     ? opt === "rgb" ? `rgb(r,g,b)` : "#" + this.toHEX(opt)
        //     : `rgba(r,g,b,a)`;
        // ⚠️ note that `"#" +` -- Cocos' `toHEX` does **not** include `#`,
        // so only `toCSS("#rrggbb")` gets the `#`. Without it the value fed to `<input type="color">`
        // (from `getBuildingColor` / the theme editor) is invalid, and the browser treats it as black.
        if (opt && opt !== "rgba") {
            return opt === "rgb" ? `rgb(${this._r},${this._g},${this._b})` : "#" + this.toHEX(opt);
        }
        return `rgba(${this._r},${this._g},${this._b},${(this._a / 255).toFixed(2)})`;
    }

    /** Packed RGB value (without alpha); matches Cocos `toRGBValue` */
    public toRGBValue(): number {
        return this._val & 0xffffff;
    }

    /** Set from an rgb array (matches Cocos `fromRGB`) */
    public fromRGB(array: number[] | Uint8Array): this {
        this._r = array[0] as number;
        this._g = array[1] as number;
        this._b = array[2] as number;
        this._syncVal();
        return this;
    }

    /** Set from an RGBA array (matches Cocos `fromRGBA`) */
    public fromRGBA(array: number[] | Uint8Array): this {
        this._r = array[0] as number;
        this._g = array[1] as number;
        this._b = array[2] as number;
        this._a = array[3] as number;
        this._syncVal();
        return this;
    }

    public clone(): Color {
        return new Color(this._r, this._g, this._b, this._a);
    }

    /* ---------------- channel reads (matching Cocos' getX form) ---------------- */

    public getR(): number {
        return this._r;
    }
    public getG(): number {
        return this._g;
    }
    public getB(): number {
        return this._b;
    }
    public getA(): number {
        return this._a;
    }

    /* ---------------- channel writes (mutable, chainable) ---------------- */

    public setR(v: number): this {
        this.r = v;
        return this;
    }

    public setG(v: number): this {
        this.g = v;
        return this;
    }

    public setB(v: number): this {
        this.b = v;
        return this;
    }

    public setA(v: number): this {
        this.a = v;
        return this;
    }

    /** Per-channel linear interpolation (returns a new object, does not modify this), ratio=0 keeps this, ratio=1 becomes to */
    public lerp(to: Color, ratio: number, out?: Color): Color {
        // Matches Cocos `Color.prototype.lerp`: **returns a new object, does not modify this**.
        // ⚠️ this used to modify `this` in place, while the only call site is
        // `getCurrentColor().grid.lerp(getCurrentColor().background, 0.5)`
        // in `WaveManager.recalculateWormholePath`
        // -- every recompute pulled the **global theme color object** another half-step toward the background,
        // so after a dozen redraws the grid lines matched the background and became entirely invisible, and the theme was permanently polluted.
        const o = out ?? new Color();
        o._r = this._r + (to._r - this._r) * ratio;
        o._g = this._g + (to._g - this._g) * ratio;
        o._b = this._b + (to._b - this._b) * ratio;
        o._a = this._a + (to._a - this._a) * ratio;
        return o;
    }

    public set(other: Color): this;
    public set(r: number, g: number, b: number, a?: number): this;
    public set(rOrColor: number | Color, g?: number, b?: number, a?: number): this {
        if (typeof rOrColor === "object") {
            this._r = rOrColor.r;
            this._g = rOrColor.g;
            this._b = rOrColor.b;
            this._a = rOrColor.a;
        } else {
            this._r = rOrColor;
            this._g = g ?? 0;
            this._b = b ?? 0;
            this._a = a ?? 255;
        }
        this._syncVal();
        return this;
    }

    public equals(other: Color): boolean {
        return this._r === other.r && this._g === other.g && this._b === other.b && this._a === other.a;
    }

    /* ---------------- per-channel arithmetic (matching Cocos' methods of the same name) ---------------- */

    public add(other: Color): this {
        this._r += other.r;
        this._g += other.g;
        this._b += other.b;
        this._a += other.a;
        this._syncVal();
        return this;
    }

    public subtract(other: Color): this {
        this._r -= other.r;
        this._g -= other.g;
        this._b -= other.b;
        this._a -= other.a;
        this._syncVal();
        return this;
    }

    public multiply(other: Color): this {
        this._r *= other.r;
        this._g *= other.g;
        this._b *= other.b;
        this._a *= other.a;
        this._syncVal();
        return this;
    }

    public divide(other: Color): this {
        this._r /= other.r;
        this._g /= other.g;
        this._b /= other.b;
        this._a /= other.a;
        this._syncVal();
        return this;
    }

    public scale(s: number): this {
        this._r *= s;
        this._g *= s;
        this._b *= s;
        this._a *= s;
        this._syncVal();
        return this;
    }

    public toString(): string {
        return `rgba(${this._r}, ${this._g}, ${this._b}, ${this._a})`;
    }
}

/** Cocos-compatible `cc.color(r, g, b, a)` factory (no args = opaque white) */
export function newColor(r?: number, g?: number, b?: number, a?: number): Color {
    return new Color(r ?? 255, g ?? 255, b ?? 255, a ?? 255);
}
