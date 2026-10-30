/**
 * Engine-agnostic color value, compatible with Cocos `cc.Color` / `cc.color()`.
 *
 * Cocos semantics kept: no-arg construction is opaque white, `fromHEX` uses a 0/255
 * fallback for unparsable components, and `toHEX(fmt)` supports "#rgb" / "#rrggbbaa".
 * The packed RGB value is kept in sync whenever a channel changes.
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

    /* ---------------- channels (the setters sync the packed value) ---------------- */

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

    /** Set the color from a hex string, in place. */
    public fromHEX(hexString: string): this {
        const s = hexString.charAt(0) === "#" ? hexString.substring(1) : hexString;
        this._r = parseInt(s.substring(0, 2), 16) || 0;
        this._g = parseInt(s.substring(2, 4), 16) || 0;
        this._b = parseInt(s.substring(4, 6), 16) || 0;
        // A 6-digit input leaves an empty alpha substring; the Cocos ||255 fallback makes it opaque.
        this._a = parseInt(s.substring(6, 8), 16) || 255;
        this._syncVal();
        return this;
    }

    /**
     * Hex string without a `#` prefix. `"#rgb"` and `"#rrggbbaa"` select the short and
     * alpha forms; any other value (including `"#rrggbb"`) yields the 6-digit form, as in Cocos.
     */
    public toHEX(fmt?: "#rgb" | "#rrggbb" | "#rrggbbaa"): string {
        const pad = (n: number): string => (n < 16 ? "0" : "") + n.toString(16);
        const hex = [pad(this._r), pad(this._g), pad(this._b)];
        if (fmt === "#rgb") {
            // The array is fixed at length 3 and filled just above; the casts only satisfy noUncheckedIndexedAccess.
            hex[0] = (hex[0] as string)[0] as string;
            hex[1] = (hex[1] as string)[0] as string;
            hex[2] = (hex[2] as string)[0] as string;
        } else if (fmt === "#rrggbbaa") {
            hex.push(pad(this._a));
        }
        return hex.join("");
    }

    /**
     * CSS color string, matching Cocos `toCSS(opt)`: `"rgb"` and `"rgba"` have their own
     * forms, any other value is forwarded to `toHEX` with a `#` prefix.
     * The game relies on `toCSS("#rrggbb")` for `<input type="color">` values.
     */
    public toCSS(opt?: "rgb" | "rgba" | "#rgb" | "#rrggbb" | "#rrggbbaa"): string {
        if (opt && opt !== "rgba") {
            return opt === "rgb" ? `rgb(${this._r},${this._g},${this._b})` : "#" + this.toHEX(opt);
        }
        return `rgba(${this._r},${this._g},${this._b},${(this._a / 255).toFixed(2)})`;
    }

    /** Packed RGB value (without alpha) */
    public toRGBValue(): number {
        return this._val & 0xffffff;
    }

    /** Set from an rgb array */
    public fromRGB(array: number[] | Uint8Array): this {
        this._r = array[0] as number;
        this._g = array[1] as number;
        this._b = array[2] as number;
        this._syncVal();
        return this;
    }

    /** Set from an RGBA array */
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

    /* ---------------- channel reads ---------------- */

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

    /**
     * Per-channel linear interpolation: ratio 0 keeps this, ratio 1 becomes `to`.
     * Returns a new Color unless `out` is supplied, and never mutates the receiver.
     */
    public lerp(to: Color, ratio: number, out?: Color): Color {
        const o = out ?? new Color();
        o._r = this._r + (to._r - this._r) * ratio;
        o._g = this._g + (to._g - this._g) * ratio;
        o._b = this._b + (to._b - this._b) * ratio;
        o._a = this._a + (to._a - this._a) * ratio;
        o._syncVal();
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

    /* ---------------- per-channel arithmetic (mutable, chainable) ---------------- */

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
