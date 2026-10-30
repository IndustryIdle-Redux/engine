/**
 * Engine-agnostic math and random utilities.
 *
 * This is the first piece of the "de-Cocos" work: pure functions that used to be scattered across
 * `cc.misc.*` / the monkey-patched `cc.randf` are gathered into a local module, with semantics **matching the Cocos implementation literally**
 * (implementation taken from the build artifact `build/web-mobile/cocos2d-js.js`; see the line numbers in each function's comment).
 *
 * Why it is worth extracting on its own: these functions are used by 60+ files but **have nothing to do with rendering**,
 * so they could be decoupled from the engine before the renderer was in place (low risk, verifiable immediately).
 */

/* ------------------------------------------------------------------ *
 * Math
 * ------------------------------------------------------------------ */

/**
 * Clamp `value` into [min, max].
 *
 * Semantics match Cocos `cc.misc.clampf` (cocos2d-js.js:31632):
 *  - **if min > max they are swapped automatically** (easy to overlook but real)
 *  - it uses comparisons rather than Math.min/max, so NaN passes straight through (kept identical to Cocos)
 */
export function clampf(value: number, minInclusive: number, maxInclusive: number): number {
    if (minInclusive > maxInclusive) {
        const temp = minInclusive;
        minInclusive = maxInclusive;
        maxInclusive = temp;
    }
    return value < minInclusive ? minInclusive : value < maxInclusive ? value : maxInclusive;
}

/** Clamp `value` into [0, 1]. Matches Cocos `cc.misc.clamp01` (:31640) */
export function clamp01(value: number): number {
    return value < 0 ? 0 : value < 1 ? value : 1;
}

/** Linear interpolation. Matches Cocos `cc.misc.lerp` (:31643) */
export function lerp(a: number, b: number, r: number): number {
    return a + (b - a) * r;
}

/** Normalize an angle into (-180, 180]. Matches the game's original monkey patch `cc.normalizeAngle` (Extensions.ts:141) */
export function normalizeAngle(angle: number): number {
    while (angle < -180) {
        angle += 360;
    }
    while (angle > 180) {
        angle -= 360;
    }
    return angle;
}

/* ------------------------------------------------------------------ *
 * Random
 * ------------------------------------------------------------------ */

/**
 * Random float in the interval [min, max).
 *
 * Matches the game's original monkey patch `cc.randf` (Extensions.ts:155 / Helper.ts:399):
 *   `min + (max - min) * Math.random()`
 *
 * ⚠ Note: **the original implementation is an unseeded Math.random()**, not the engine's seeded RNG.
 * So swapping in this function cannot change any "reproducible" behavior -- there was never a reproducible
 * sequence in the first place, and there is no save-compatibility issue either (saves do not record RNG state).
 */
export function randf(min: number, max: number): number {
    return min + (max - min) * Math.random();
}

/** Random integer in the interval [min, max]. Matches the original monkey patch `cc.randi` (Extensions.ts:151): `Math.round(randf)` */
export function randi(min: number, max: number): number {
    return Math.round(randf(min, max));
}

/* ------------------------------------------------------------------ *
 * Object checks
 * ------------------------------------------------------------------ */

/**
 * Check whether an object has no enumerable properties at all.
 *
 * Matches Cocos `cc.js.isEmptyObject` (cocos2d-js.js:24550):
 *   `for (var key in obj) return false; return true;`
 * Note that it uses **for-in** (including the prototype chain), not `Object.keys(obj).length === 0`.
 * for-in semantics are kept here so the two are exactly equivalent.
 */
export function isEmptyObject(obj: unknown): boolean {
    // use for-in rather than Object.keys: same semantics as Cocos (for-in walks enumerable properties on the prototype chain)
    for (const _key in obj as Record<string, unknown>) {
        void _key;
        return false;
    }
    return true;
}
