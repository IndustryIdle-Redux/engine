/**
 * Deterministic randomness matching the game's `xmur3` + `sfc32` (`shared/util/Helper.ts`).
 *
 * The constants and shift sequence are reproduced verbatim so the same seed yields the same
 * values, and therefore the same map layout, as the original client.
 */

/** xmur3 string hash (returns a 32-bit unsigned generator) */
export function xmur3(str: string): () => number {
    let h = (1779033703 ^ str.length) | 0;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return function next(): number {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        h = (h ^= h >>> 16) >>> 0;
        return h;
    };
}

/** sfc32 PRNG (returns floats in [0,1)) */
export function sfc32(a: number, b: number, c: number, d: number): () => number {
    return function next(): number {
        a |= 0;
        b |= 0;
        c |= 0;
        d |= 0;
        const t = (((a + b) | 0) + d) | 0;
        d = (d + 1) | 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) | 0;
        c = (c << 21) | (c >>> 11);
        c = (c + t) | 0;
        return (t >>> 0) / 4294967296;
    };
}

/** Exactly matches the game's `srand(seed)`: string → [0,1) generator */
export function srand(seed: string): () => number {
    const s = xmur3(seed);
    return sfc32(s(), s(), s(), s());
}

/**
 * Pick one element from an array using a random function, matching the game's
 * `Array.prototype.randOne` (`this[Math.floor(this.length * rnd())]`).
 *
 * Returns `undefined` for an empty array.
 */
export function randOne<T>(arr: readonly T[], rnd: () => number): T | undefined {
    return arr[Math.floor(arr.length * rnd())];
}
