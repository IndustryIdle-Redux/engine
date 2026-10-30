/**
 * Camera and visible-area computation.
 *
 * Replaces `cc.Camera` / `cc.winSize` / `cc.view` / `cc.visibleRect`.
 *
 * In the original version `cc.winSize` appeared **52 times** in business code, `cc.view.*` many more,
 * and `cc.Camera.getScreenToWorldPoint` was used for click hit-testing. All of that is gathered here,
 * and business code now holds a `Camera2D` reference instead (or goes through `Renderer2D.camera`).
 *
 * Coordinate conventions (same as Cocos, no flipping needed during migration):
 *  - **World coordinates**: origin at the scene center, +X right, +Y up, unit is pixels
 *  - **Screen coordinates**: origin at the canvas top-left, +X right, +Y down, unit decided by the caller (CSS pixels here)
 */

import { Mat3 } from "../Mat3";
import { Vec2 } from "../Vec2";

export class Camera2D {
    /** Camera center (world coordinates) */
    public readonly position = new Vec2(0, 0);
    /** Zoom; >1 means magnified */
    public zoom = 1;
    /** Viewport size (CSS pixels) */
    public viewportWidth = 1;
    public viewportHeight = 1;

    /** World → clip-space matrix (recomputed every frame) */
    private readonly viewProjection = new Mat3();
    /** Screen → world matrix (used for hit-testing; the same object is reused to avoid per-frame allocation) */
    private readonly inverseVP = new Mat3();

    /**
     * Cached visible bounds for the two predicate methods.
     *
     * `isPointVisible` / `isRectVisible` are called **per entity and per tile** every frame
     * (`WorldRenderer.drawDeposits`, `drawBuildings`, `drawOverlay`): a 100×100 map with the overlay on
     * makes that 10,000 calls. `getVisibleRect()` used to build a fresh object for each call, i.e.
     * 10,000 short-lived objects per frame of pure GC pressure for a rect that only changes when the
     * camera does. The bounds are now cached and invalidated by comparing the five inputs the rect
     * depends on (position x/y, zoom, viewport w/h); the comparison is cheaper than the allocation.
     */
    private readonly visBounds = { x: 0, y: 0, width: 0, height: 0 };
    private visX = Number.NaN;
    private visY = Number.NaN;
    private visZoom = Number.NaN;
    private visW = Number.NaN;
    private visH = Number.NaN;
    /** How many times the cached bounds were actually recomputed (debug/statistics, like `gridCacheStats`) */
    public readonly visibleRectStats = { recompute: 0 };

    /**
     * Compute the projection matrix used by the shader.
     *
     * Transform chain: translate world coordinates (subtract the camera position) → scale → normalized device coordinates (NDC, -1~1, Y up).
     * Y is up in NDC, which matches the world's +Y up, so **no flip is needed**.
     *
     * The resulting matrix can be passed straight to `u_projection` (mat3).
     */
    public updateProjection(out?: Mat3): Mat3 {
        const m = out ?? this.viewProjection;
        const sx = (2 * this.zoom) / this.viewportWidth;
        const sy = (2 * this.zoom) / this.viewportHeight;
        // translation part: map the camera center to the NDC origin
        m.set(sx, 0, 0, sy, -this.position.x * sx, -this.position.y * sy);
        return m;
    }

    /** World → screen (CSS pixels, top-left origin, Y down) */
    public worldToScreen(worldX: number, worldY: number, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        return r.set(
            (worldX - this.position.x) * this.zoom + this.viewportWidth / 2,
            -(worldY - this.position.y) * this.zoom + this.viewportHeight / 2,
        );
    }

    /** Screen → world (click hit-testing) */
    public screenToWorld(screenX: number, screenY: number, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        return r.set(
            (screenX - this.viewportWidth / 2) / this.zoom + this.position.x,
            -(screenY - this.viewportHeight / 2) / this.zoom + this.position.y,
        );
    }

    /**
     * Screen → world in matrix form (faster than calling `screenToWorld` point by point when transforming in bulk).
     *
     * Exactly the same point-wise semantics as `screenToWorld` (locked down by unit tests).
     * Built analytically rather than by matrix inversion -- because world→NDC and NDC→screen each contain one
     * Y-axis flip (they cancel out), and composing them makes the order easy to get wrong and hard to verify.
     *
     * Derivation (let invZoom = 1/zoom, W/H being the viewport size):
     *   worldX = (sx - W/2) * invZoom + camera.x
     *          = sx * invZoom + (camera.x - W * invZoom / 2)
     *   worldY = -(sy - H/2) * invZoom + camera.y
     *          = sy * (-invZoom) + (camera.y + H * invZoom / 2)
     */
    public screenToWorldMatrix(out?: Mat3): Mat3 {
        const m = out ?? this.inverseVP;
        const invZoom = 1 / this.zoom;
        m.set(
            invZoom,
            0,
            0,
            -invZoom,
            this.position.x - (this.viewportWidth * invZoom) / 2,
            this.position.y + (this.viewportHeight * invZoom) / 2,
        );
        return m;
    }

    /**
     * Currently visible world rectangle (used for frustum culling, replaces `isRectInView`).
     *
     * Pass `out` to reuse an object. When `out` is omitted the caller gets a **fresh** object (the old
     * behaviour, kept because some callers store the result); the per-point predicates below use the
     * internal cache instead, so the per-entity hot path never allocates.
     */
    public getVisibleRect(out?: { x: number; y: number; width: number; height: number }): {
        x: number;
        y: number;
        width: number;
        height: number;
    } {
        const w = this.viewportWidth / this.zoom;
        const h = this.viewportHeight / this.zoom;
        const r = out ?? { x: 0, y: 0, width: 0, height: 0 };
        r.x = this.position.x - w / 2;
        r.y = this.position.y - h / 2;
        r.width = w;
        r.height = h;
        return r;
    }

    /** Refresh `visBounds` if any input the rect depends on changed (no allocation) */
    private updateVisibleBounds(): void {
        if (
            this.visX === this.position.x &&
            this.visY === this.position.y &&
            this.visZoom === this.zoom &&
            this.visW === this.viewportWidth &&
            this.visH === this.viewportHeight
        ) {
            return;
        }
        const w = this.viewportWidth / this.zoom;
        const h = this.viewportHeight / this.zoom;
        this.visBounds.x = this.position.x - w / 2;
        this.visBounds.y = this.position.y - h / 2;
        this.visBounds.width = w;
        this.visBounds.height = h;
        this.visX = this.position.x;
        this.visY = this.position.y;
        this.visZoom = this.zoom;
        this.visW = this.viewportWidth;
        this.visH = this.viewportHeight;
        this.visibleRectStats.recompute++;
    }

    /** Whether a single point is visible (margin widens the bounds, used for preloading) */
    public isPointVisible(x: number, y: number, margin = 0): boolean {
        this.updateVisibleBounds();
        const r = this.visBounds;
        return (
            x >= r.x - margin && x <= r.x + r.width + margin && y >= r.y - margin && y <= r.y + r.height + margin
        );
    }

    /** Whether a rectangle is visible (replaces the `isRectInView` family of `cc.Camera`) */
    public isRectVisible(x: number, y: number, width: number, height: number, margin = 0): boolean {
        this.updateVisibleBounds();
        const r = this.visBounds;
        return (
            x + width >= r.x - margin &&
            x <= r.x + r.width + margin &&
            y + height >= r.y - margin &&
            y <= r.y + r.height + margin
        );
    }
}
