import { describe, expect, it } from "vitest";
import { Color } from "../src/Color";
import { TweenManager, easing } from "../src/Tween";
import { Vec2 } from "../src/Vec2";

describe("Easing functions", () => {
    it("every easing is 0 at t=0 and 1 at t=1", () => {
        for (const [name, fn] of Object.entries(easing)) {
            expect(fn(0), `${name}(0)`).toBeCloseTo(0, 6);
            expect(fn(1), `${name}(1)`).toBeCloseTo(1, 6);
        }
    });

    it("easing is monotonically non-decreasing on [0,1] (except back/elastic/bounce)", () => {
        const overshooting = new Set(["backIn", "backOut", "elasticOut", "bounceOut"]);
        for (const [name, fn] of Object.entries(easing)) {
            if (overshooting.has(name)) continue;
            let prev = -Infinity;
            for (let t = 0; t <= 1.0001; t += 0.05) {
                const v = fn(Math.min(1, t));
                expect(v, `${name} goes backwards at t=${t.toFixed(2)}`).toBeGreaterThanOrEqual(prev - 1e-9);
                prev = v;
            }
        }
    });

    it("quadIn midpoint is 0.25, quadOut midpoint is 0.75 (matching Cocos semantics)", () => {
        expect(easing.quadIn(0.5)).toBeCloseTo(0.25, 10);
        expect(easing.quadOut(0.5)).toBeCloseTo(0.75, 10);
    });
});

describe("TweenManager basic tweens", () => {
    it("a linear tween reaches the target within its duration", () => {
        const tweens = new TweenManager();
        const target = { x: 0 };
        tweens.to(target, { x: 100 }, { duration: 1 });
        tweens.update(0.5);
        expect(target.x).toBeCloseTo(50, 6);
        tweens.update(0.5);
        expect(target.x).toBeCloseTo(100, 6);
        expect(tweens.count).toBe(0);
    });

    it("onComplete fires on completion and only once", () => {
        const tweens = new TweenManager();
        let calls = 0;
        tweens.to({ x: 0 }, { x: 1 }, { duration: 0.1, onComplete: () => calls++ });
        tweens.update(0.2);
        tweens.update(0.2);
        expect(calls).toBe(1);
    });

    it("onUpdate receives progress in 0~1", () => {
        const tweens = new TweenManager();
        const seen: number[] = [];
        tweens.to({ x: 0 }, { x: 10 }, { duration: 1, onUpdate: (p) => seen.push(p) });
        tweens.update(0.25);
        tweens.update(0.25);
        expect(seen[0]).toBeCloseTo(0.25, 6);
        expect(seen[1]).toBeCloseTo(0.5, 6);
    });

    it("the target value does not change during delay", () => {
        const tweens = new TweenManager();
        const target = { x: 0 };
        tweens.to(target, { x: 100 }, { duration: 1, delay: 0.5 });
        tweens.update(0.25);
        expect(target.x).toBe(0);
        tweens.update(0.5); // crosses the delay and the tween starts
        expect(target.x).toBeGreaterThan(0);
    });

    it("one tween's delay overshoot does not shorten another tween's advance in the same frame", () => {
        const tweens = new TweenManager();
        const first = { x: 0 };
        const second = { x: 0 };
        // `update` walks the snapshot in reverse insertion order, so `second` is processed first.
        tweens.to(first, { x: 10 }, { duration: 1, delay: 0.3 });
        tweens.to(second, { x: 10 }, { duration: 1, delay: 0.1 });

        tweens.update(0.5);

        // The shorter delay is processed first; both tweens advance on this frame.
        // If the shared dt were mutated, the longer delay would be cut to 0.2 s and `first` would not start.
        expect(first.x).toBeCloseTo(3, 6);
        expect(second.x).toBeCloseTo(1, 6);
    });

    it("overshooting the duration does not overshoot the target value", () => {
        const tweens = new TweenManager();
        const target = { x: 0 };
        tweens.to(target, { x: 100 }, { duration: 0.1 });
        tweens.update(10);
        expect(target.x).toBe(100);
    });
});

describe("TweenManager multiple properties / types", () => {
    it("tweens several numeric fields at once", () => {
        const tweens = new TweenManager();
        const t = { x: 0, y: 0, alpha: 1 };
        tweens.to(t, { x: 10, y: -20, alpha: 0 }, { duration: 1 });
        tweens.update(0.5);
        expect(t.x).toBeCloseTo(5, 6);
        expect(t.y).toBeCloseTo(-10, 6);
        expect(t.alpha).toBeCloseTo(0.5, 6);
    });

    it("toPosition works on a Vec2", () => {
        const tweens = new TweenManager();
        const v = new Vec2(0, 0);
        tweens.toPosition(v, { x: 100, y: 50 }, { duration: 1 });
        tweens.update(1);
        expect(v.x).toBe(100);
        expect(v.y).toBe(50);
    });

    it("toColor interpolates RGBA together", () => {
        const tweens = new TweenManager();
        const c = new Color(0, 0, 0, 0);
        tweens.toColor(c, new Color(255, 255, 255, 255), { duration: 1 });
        tweens.update(0.5);
        expect(c.r).toBeCloseTo(127.5, 0);
        expect(c.a).toBeCloseTo(127.5, 0);
    });

    it("the easing function is applied", () => {
        const tweens = new TweenManager();
        const target = { x: 0 };
        tweens.to(target, { x: 100 }, { duration: 1, easing: easing.quadIn });
        tweens.update(0.5);
        expect(target.x).toBeCloseTo(25, 6); // quadIn(0.5) = 0.25
    });
});

describe("TweenManager repeat and yoyo", () => {
    it("ends after the specified number of repeats", () => {
        const tweens = new TweenManager();
        const target = { x: 0 };
        let done = 0;
        tweens.to(target, { x: 10 }, { duration: 1, repeat: 2, onComplete: () => done++ });
        // 3 rounds (the initial run + 2 repeats)
        for (let i = 0; i < 3; i++) tweens.update(1.01);
        expect(done).toBe(1);
        expect(tweens.count).toBe(0);
    });

    it("repeat = -1 loops forever", () => {
        const tweens = new TweenManager();
        const target = { x: 0 };
        tweens.to(target, { x: 10 }, { duration: 1, repeat: -1 });
        for (let i = 0; i < 10; i++) tweens.update(1.01);
        expect(tweens.count).toBe(1);
    });

    it("yoyo returns to the start and runs once more", () => {
        const tweens = new TweenManager();
        const target = { x: 0 };
        tweens.to(target, { x: 100 }, { duration: 1, yoyo: true, repeat: 0 });
        tweens.update(1.01); // forward run finishes
        expect(target.x).toBeCloseTo(100, 4);
        tweens.update(1.01); // reverse run finishes
        expect(target.x).toBeCloseTo(0, 4);
    });
});

describe("TweenManager stop and pooling", () => {
    it("stop immediately ends the target's tween without firing onComplete", () => {
        const tweens = new TweenManager();
        const target = { x: 0 };
        let done = 0;
        tweens.to(target, { x: 100 }, { duration: 1, onComplete: () => done++ });
        tweens.stop(target);
        tweens.update(0.5);
        expect(tweens.count).toBe(0);
        expect(done).toBe(0);
    });

    it("stopAll clears everything", () => {
        const tweens = new TweenManager();
        tweens.to({ x: 0 }, { x: 1 }, { duration: 1 });
        tweens.to({ y: 0 }, { y: 1 }, { duration: 1 });
        expect(tweens.count).toBe(2);
        tweens.stopAll();
        tweens.update(0.016);
        expect(tweens.count).toBe(0);
    });

    it("repeatedly creating/finishing tweens does not grow the active count (objects are recycled into the pool)", () => {
        const tweens = new TweenManager();
        for (let i = 0; i < 500; i++) {
            tweens.to({ x: 0 }, { x: 1 }, { duration: 0.01 });
            tweens.update(0.02);
        }
        expect(tweens.count).toBe(0);
    });

    it("the number of tweens finished this frame is returned (usable for stats)", () => {
        const tweens = new TweenManager();
        for (let i = 0; i < 3; i++) tweens.to({ x: 0 }, { x: 1 }, { duration: 0.5 });
        expect(tweens.update(0.6)).toBe(3);
    });
});
