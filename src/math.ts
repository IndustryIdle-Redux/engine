/**
 * Engine-agnostic math and random utilities.
 *
 * Pure functions replacing the `cc.misc.*` helpers and the game's monkey patches,
 * with the same semantics as the Cocos/ game implementations they replace.
 */

/* ------------------------------------------------------------------ *
 * Math
 * ------------------------------------------------------------------ */

/**
 * Clamp `value` into [min, max].
 *
 * Matches Cocos `cc.misc.clampf`: if min > max they are swapped, and the comparisons
 * rather than Math.min/max let NaN pass straight through.
 */
export function clampf(value: number, minInclusive: number, maxInclusive: number): number {
    if (minInclusive > maxInclusive) {
        const temp = minInclusive;
        minInclusive = maxInclusive;
        maxInclusive = temp;
    }
    return value < minInclusive ? minInclusive : value < maxInclusive ? value : maxInclusive;
}

/** Clamp `value` into [0, 1]. Matches Cocos `cc.misc.clamp01` */
export function clamp01(value: number): number {
    return value < 0 ? 0 : value < 1 ? value : 1;
}

/** Linear interpolation. Matches Cocos `cc.misc.lerp` */
export function lerp(a: number, b: number, r: number): number {
    return a + (b - a) * r;
}

/** Normalize an angle into (-180, 180]. Matches the game's original `cc.normalizeAngle` */
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
 * Matches the game's original `cc.randf`: `min + (max - min) * Math.random()`.
 * It is unseeded (not the engine's seeded RNG) and saves do not record RNG state.
 */
export function randf(min: number, max: number): number {
    return min + (max - min) * Math.random();
}

/** Random integer in the interval [min, max]. Matches the original `cc.randi` */
export function randi(min: number, max: number): number {
    return Math.round(randf(min, max));
}

/* ------------------------------------------------------------------ *
 * Object checks
 * ------------------------------------------------------------------ */

/**
 * Check whether an object has no enumerable properties at all.
 *
 * Matches Cocos `cc.js.isEmptyObject`: it uses for-in (including the prototype chain)
 * rather than `Object.keys(obj).length === 0`, and that semantics is kept here.
 */
export function isEmptyObject(obj: unknown): boolean {
    for (const _key in obj as Record<string, unknown>) {
        void _key;
        return false;
    }
    return true;
}
