/**
 * Tweening (Cocos `cc.tween` / `cc.easing` replacement).
 *
 * A single active array is advanced once per frame, tween records are pooled so the
 * steady state allocates nothing, and easing functions are pure and unit-testable.
 */

import type { Color } from "./Color";
import type { Vec2 } from "./Vec2";
import type { Vec3 } from "./Vec3";

/* ------------------------------------------------------------------ *
 * Easing functions (named to match Cocos' cc.easing)
 * ------------------------------------------------------------------ */

export const easing = {
    linear: (t: number): number => t,
    quadIn: (t: number): number => t * t,
    quadOut: (t: number): number => t * (2 - t),
    quadInOut: (t: number): number => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
    cubicIn: (t: number): number => t * t * t,
    cubicOut: (t: number): number => 1 - Math.pow(1 - t, 3),
    cubicInOut: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    sineIn: (t: number): number => 1 - Math.cos((t * Math.PI) / 2),
    sineOut: (t: number): number => Math.sin((t * Math.PI) / 2),
    sineInOut: (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2,
    expoIn: (t: number): number => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
    expoOut: (t: number): number => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    backIn: (t: number): number => {
        // standard easeInBack (Rob Penner / easings.net):
        //   t=0 → 0, t=1 → 1, pulling back first then overshooting in between
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return c3 * t * t * t - c1 * t * t;
    },
    backOut: (t: number): number => {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    elasticOut: (t: number): number => {
        if (t === 0 || t === 1) return t;
        const p = 0.3;
        return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * (2 * Math.PI)) / p) + 1;
    },
    bounceOut: (t: number): number => {
        const n1 = 7.5625;
        const d1 = 2.75;
        if (t < 1 / d1) return n1 * t * t;
        if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
        if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
        return n1 * (t -= 2.625 / d1) * t + 0.984375;
    },
} as const;

export type EasingName = keyof typeof easing;
export type EasingFn = (t: number) => number;

/* ------------------------------------------------------------------ *
 * Tweenable value types
 * ------------------------------------------------------------------ */

/** Tween target: any object with numeric fields (Vec2/Vec3/custom structures all work) */
export interface Tweenable {
    [key: string]: unknown;
}

type NumericKeys<T> = {
    [K in keyof T]: T[K] extends number ? K : never;
}[keyof T] & string;

export interface TweenOptions {
    duration: number;
    easing?: EasingFn;
    /** Delay (seconds) */
    delay?: number;
    /** Repeat count; -1 means infinite */
    repeat?: number;
    /** Whether to yoyo back and forth */
    yoyo?: boolean;
    /** Completion callback */
    onComplete?: () => void;
    /** Per-frame callback (the argument is progress 0~1) */
    onUpdate?: (progress: number) => void;
}

interface ActiveTween<T extends Tweenable> {
    target: T;
    from: Record<string, number>;
    to: Record<string, number>;
    keys: string[];
    elapsed: number;
    duration: number;
    delay: number;
    easing: EasingFn;
    repeat: number;
    completedLoops: number;
    yoyo: boolean;
    reversed: boolean;
    onComplete?: () => void;
    onUpdate?: (progress: number) => void;
    done: boolean;
}

/**
 * Tween manager.
 *
 * Usage:
 * ```ts
 * const tweens = new TweenManager();
 * tweens.to(camera.position, { x: 100, y: 50 }, { duration: 0.3, easing: easing.quadOut });
 * // every frame:
 * tweens.update(dt);
 * ```
 */
export class TweenManager {
    private readonly active: ActiveTween<Tweenable>[] = [];
    /** Reusable pool of tween objects (avoids per-frame allocation) */
    private readonly pool: ActiveTween<Tweenable>[] = [];

    public get count(): number {
        return this.active.length;
    }

    /**
     * Tween from the current values to the target values.
     *
     * Only numeric fields in `props` are handled. A new tween supersedes live tweens on
     * the same properties of the same target, so two tweens never fight over one field.
     */
    public to<T extends Tweenable>(
        target: T,
        props: Partial<Record<NumericKeys<T>, number>> & Record<string, number>,
        options: TweenOptions,
    ): void {
        const keys = Object.keys(props);
        // Supersede: drop active tweens writing the same properties of the same target.
        const keySet = new Set(keys);
        for (let i = this.active.length - 1; i >= 0; i--) {
            const t = this.active[i] as ActiveTween<Tweenable> | undefined;
            if (t && t.target === target && t.keys.some((k) => keySet.has(k))) {
                this.active.splice(i, 1);
            }
        }
        const from: Record<string, number> = {};
        const to: Record<string, number> = {};
        for (const k of keys) {
            from[k] = Number(target[k] ?? 0);
            to[k] = Number(props[k] ?? 0);
        }
        const tween = this.obtain();
        tween.target = target as unknown as Tweenable;
        tween.from = from;
        tween.to = to;
        tween.keys = keys;
        tween.elapsed = 0;
        tween.duration = Math.max(1e-6, options.duration);
        tween.delay = options.delay ?? 0;
        tween.easing = options.easing ?? easing.linear;
        tween.repeat = options.repeat ?? 0;
        tween.completedLoops = 0;
        tween.yoyo = options.yoyo ?? false;
        tween.reversed = false;
        tween.onComplete = options.onComplete;
        tween.onUpdate = options.onUpdate;
        tween.done = false;
        this.active.push(tween);
    }

    /** Color tween (the four RGBA channels are interpolated independently) */
    public toColor(target: Color, to: Color, options: TweenOptions): void {
        this.to(
            target as unknown as Tweenable,
            { r: to.r, g: to.g, b: to.b, a: to.a },
            options,
        );
    }

    /** Position tween (Vec2/Vec3, interpolating by x/y) */
    public toPosition(target: Vec2 | Vec3, to: { x: number; y: number }, options: TweenOptions): void {
        this.to(target as unknown as Tweenable, { x: to.x, y: to.y }, options);
    }

    /** Immediately stop all tweens of a target (does not fire onComplete) */
    public stop(target: Tweenable): void {
        for (const t of this.active) {
            if (t.target === target) t.done = true;
        }
    }

    public stopAll(): void {
        for (const t of this.active) t.done = true;
    }

    /** Snapshot buffer reused by `update` (no allocation per frame) */
    private readonly iterating: ActiveTween<Tweenable>[] = [];

    /**
     * Advance all tweens (called every frame); returns how many finished this frame.
     *
     * Completion callbacks may create or supersede tweens, so the walk uses a snapshot and
     * unlinks by identity. Tweens created from a callback start on the next frame.
     */
    public update(dt: number): number {
        let finished = 0;
        const active = this.active;
        // snapshot in the previous (backwards) order, so competing writes keep their old precedence
        const list = this.iterating;
        list.length = 0;
        for (let i = active.length - 1; i >= 0; i--) list.push(active[i] as ActiveTween<Tweenable>);

        for (let n = 0; n < list.length; n++) {
            const t = list[n] as ActiveTween<Tweenable>;

            if (t.done) {
                this.unlink(t);
                this.release(t);
                continue;
            }

            let delta = dt;

            if (t.delay > 0) {
                t.delay -= dt;
                if (t.delay > 0) continue;
                // Use a per-tween copy of dt: the delay overshoot only advances this tween,
                // and must not change dt for the other tweens in the same frame.
                delta += t.delay;
                t.delay = 0;
            }

            t.elapsed += delta;
            const progress = Math.min(1, t.elapsed / t.duration);
            const eased = t.easing(t.reversed ? 1 - progress : progress);

            for (const k of t.keys) {
                const a = t.from[k] as number;
                const b = t.to[k] as number;
                t.target[k] = a + (b - a) * eased;
            }
            t.onUpdate?.(progress);

            if (progress >= 1) {
                if (t.yoyo && !t.reversed) {
                    t.reversed = true;
                    t.elapsed = 0;
                    continue;
                }
                if (t.repeat === -1 || t.completedLoops < t.repeat) {
                    t.completedLoops++;
                    t.reversed = false;
                    t.elapsed = 0;
                    continue;
                }
                t.done = true;
                finished++;
                // unlink *before* the callback: it may add (or supersede) tweens and shift the array
                this.unlink(t);
                t.onComplete?.();
                this.release(t);
            }
        }
        return finished;
    }

    /** Detach a tween from the active list by identity (never by index — callbacks splice too) */
    private unlink(t: ActiveTween<Tweenable>): void {
        const i = this.active.indexOf(t);
        if (i >= 0) this.active.splice(i, 1);
    }

    private obtain(): ActiveTween<Tweenable> {
        return (
            this.pool.pop() ??
            ({
                target: {},
                from: {},
                to: {},
                keys: [],
                elapsed: 0,
                duration: 1,
                delay: 0,
                easing: easing.linear,
                repeat: 0,
                completedLoops: 0,
                yoyo: false,
                reversed: false,
                done: false,
            } as ActiveTween<Tweenable>)
        );
    }

    private release(t: ActiveTween<Tweenable>): void {
        t.target = {};
        t.from = {};
        t.to = {};
        t.keys = [];
        t.onComplete = undefined;
        t.onUpdate = undefined;
        this.pool.push(t);
    }
}
