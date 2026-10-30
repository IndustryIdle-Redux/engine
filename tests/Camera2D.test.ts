import { describe, expect, it } from "vitest";
import { Camera2D } from "../src/renderer/Camera2D";
import { Vec2 } from "../src/Vec2";

function makeCamera(): Camera2D {
    const c = new Camera2D();
    c.viewportWidth = 800;
    c.viewportHeight = 600;
    c.position.set(0, 0);
    c.zoom = 1;
    return c;
}

describe("Camera2D zoom clamp", () => {
    it("clamps zero and negative zoom to a small positive minimum", () => {
        const c = makeCamera();
        c.zoom = 0;
        expect(c.zoom).toBeGreaterThan(0);
        expect(c.zoom).toBeLessThanOrEqual(1e-3);
        c.zoom = -2;
        expect(c.zoom).toBeGreaterThan(0);
        c.zoom = Number.NaN;
        expect(Number.isFinite(c.zoom)).toBe(true);
        c.zoom = 2;
        expect(c.zoom).toBe(2);
    });

    it("keeps the visible rect and projection finite at the minimum", () => {
        const c = makeCamera();
        c.zoom = 0;
        const rect = c.getVisibleRect();
        expect(Number.isFinite(rect.width)).toBe(true);
        expect(Number.isFinite(rect.height)).toBe(true);
        expect(Number.isFinite(c.updateProjection().transformPoint(0, 0).x)).toBe(true);
    });
});

describe("Camera2D projection", () => {
    it("with the camera at the origin and zoom=1, the viewport center maps to the NDC origin", () => {
        const c = makeCamera();
        const m = c.updateProjection();
        // World origin → NDC (0,0)
        const p = m.transformPoint(0, 0);
        expect(p.x).toBeCloseTo(0, 10);
        expect(p.y).toBeCloseTo(0, 10);
    });

    it("the viewport's right edge maps to NDC x=+1 and the top edge to y=+1 (Y is up, no flip needed)", () => {
        const c = makeCamera();
        const m = c.updateProjection();
        const right = m.transformPoint(400, 0);
        expect(right.x).toBeCloseTo(1, 10);
        const top = m.transformPoint(0, 300);
        expect(top.y).toBeCloseTo(1, 10);
    });

    it("after the camera moves, the camera position maps to the NDC origin", () => {
        const c = makeCamera();
        c.position.set(123, -45);
        const m = c.updateProjection();
        const p = m.transformPoint(123, -45);
        expect(p.x).toBeCloseTo(0, 10);
        expect(p.y).toBeCloseTo(0, 10);
    });

    it("after zooming in 2x, the same world distance spans 2x the NDC", () => {
        const c = makeCamera();
        c.zoom = 2;
        const m = c.updateProjection();
        const p = m.transformPoint(100, 0);
        const c1 = makeCamera();
        const p1 = c1.updateProjection().transformPoint(100, 0);
        expect(p.x).toBeCloseTo(p1.x * 2, 10);
    });
});

describe("Camera2D coordinate conversion", () => {
    it("worldToScreen: the camera position lands at the viewport center", () => {
        const c = makeCamera();
        c.position.set(50, 20);
        const s = c.worldToScreen(50, 20);
        expect(s.x).toBeCloseTo(400, 10);
        expect(s.y).toBeCloseTo(300, 10);
    });

    it("worldToScreen: world +Y corresponds to screen -Y (screen Y points down)", () => {
        const c = makeCamera();
        const above = c.worldToScreen(0, 100);
        const below = c.worldToScreen(0, -100);
        expect(above.y).toBeLessThan(300);
        expect(below.y).toBeGreaterThan(300);
    });

    it("screenToWorld is the inverse of worldToScreen", () => {
        const c = makeCamera();
        c.position.set(-37, 91);
        c.zoom = 1.75;
        for (const [sx, sy] of [
            [0, 0],
            [400, 300],
            [800, 600],
            [123, 456],
        ] as const) {
            const w = c.screenToWorld(sx, sy);
            const back = c.worldToScreen(w.x, w.y);
            expect(back.x).toBeCloseTo(sx, 9);
            expect(back.y).toBeCloseTo(sy, 9);
        }
    });

    it("screenToWorldMatrix agrees with per-point screenToWorld (the batch path must not drift)", () => {
        const c = makeCamera();
        c.position.set(15, -60);
        c.zoom = 0.8;
        const m = c.screenToWorldMatrix();
        const tmp = new Vec2();
        for (const [sx, sy] of [
            [0, 0],
            [800, 600],
            [250, 480],
        ] as const) {
            const viaMatrix = m.transformPoint(sx, sy, tmp);
            const viaPoint = c.screenToWorld(sx, sy);
            expect(viaMatrix.x).toBeCloseTo(viaPoint.x, 9);
            expect(viaMatrix.y).toBeCloseTo(viaPoint.y, 9);
        }
    });
});

describe("Camera2D visibility tests", () => {
    it("the visible rect equals viewport size / zoom", () => {
        const c = makeCamera();
        c.zoom = 2;
        const r = c.getVisibleRect();
        expect(r.width).toBeCloseTo(400, 10);
        expect(r.height).toBeCloseTo(300, 10);
        expect(r.x).toBeCloseTo(-200, 10);
        expect(r.y).toBeCloseTo(-150, 10);
    });

    it("point visibility", () => {
        const c = makeCamera();
        expect(c.isPointVisible(0, 0)).toBe(true);
        expect(c.isPointVisible(399, 299)).toBe(true);
        expect(c.isPointVisible(401, 0)).toBe(false);
        expect(c.isPointVisible(0, 301)).toBe(false);
    });

    it("margin can widen the bounds (used for preloading)", () => {
        const c = makeCamera();
        expect(c.isPointVisible(450, 0)).toBe(false);
        expect(c.isPointVisible(450, 0, 100)).toBe(true);
    });

    it("a partially intersecting rect also counts as visible", () => {
        const c = makeCamera();
        // The top-left corner is outside the viewport, but the lower-right part intersects it
        expect(c.isRectVisible(-390, 250, 100, 100)).toBe(true);
        // Completely outside
        expect(c.isRectVisible(-800, -800, 10, 10)).toBe(false);
    });

    it("caches the visible bounds across per-point calls and invalidates on any camera change", () => {
        // The overlay calls this once per tile (10,000 tiles on a full map), so it must neither allocate
        // nor recompute while the camera is still. The cache key is (position, zoom, viewport).
        const c = makeCamera();
        const before = c.visibleRectStats.recompute;
        for (let i = 0; i < 1000; i++) c.isPointVisible(i % 500, i % 500);
        expect(c.visibleRectStats.recompute).toBe(before + 1);

        c.position.x += 10;
        c.isPointVisible(0, 0);
        expect(c.visibleRectStats.recompute).toBe(before + 2);

        c.zoom = 2.5;
        c.isPointVisible(0, 0);
        expect(c.visibleRectStats.recompute).toBe(before + 3);

        c.viewportWidth = 1024;
        c.isPointVisible(0, 0);
        expect(c.visibleRectStats.recompute).toBe(before + 4);

        // ...and the cached value still agrees with the fresh computation
        const cached = c.isPointVisible(399, 299);
        const fresh = c.getVisibleRect();
        expect(cached).toBe(
            399 >= fresh.x && 399 <= fresh.x + fresh.width && 299 >= fresh.y && 299 <= fresh.y + fresh.height,
        );
    });
});
