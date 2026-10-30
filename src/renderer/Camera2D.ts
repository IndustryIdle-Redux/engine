/**
 * 2D camera and visible-area helpers.
 *
 * World coordinates: origin at the scene center, +X right, +Y up, in pixels.
 * Screen coordinates: origin at the canvas top-left, +X right, +Y down, in CSS pixels.
 */

import { Mat3 } from "../Mat3";
import { Vec2 } from "../Vec2";

/** A zoom of 0 collapses the projection and makes the visible rect infinite. */
const MIN_ZOOM = 1e-4;

export class Camera2D {
    /** Camera center (world coordinates) */
    public readonly position = new Vec2(0, 0);
    /** Viewport size (CSS pixels) */
    public viewportWidth = 1;
    public viewportHeight = 1;

    /** World → clip-space matrix (recomputed every frame) */
    private readonly viewProjection = new Mat3();
    /** Screen → world matrix (used for hit-testing; reused to avoid per-frame allocation) */
    private readonly inverseVP = new Mat3();

    private _zoom = 1;

    /**
     * Cached visible bounds for the per-entity predicates.
     *
     * Invalidated by comparing the five inputs the rect depends on, cheaper than allocating a rect
     * per call (the overlay can ask thousands of times per frame).
     */
    private readonly visBounds = { x: 0, y: 0, width: 0, height: 0 };
    private visX = Number.NaN;
    private visY = Number.NaN;
    private visZoom = Number.NaN;
    private visW = Number.NaN;
    private visH = Number.NaN;
    /** How many times the cached bounds were actually recomputed */
    public readonly visibleRectStats = { recompute: 0 };

    /** Zoom; >1 means magnified. Clamped to a small positive minimum. */
    public get zoom(): number {
        return this._zoom;
    }

    public set zoom(value: number) {
        this._zoom = value > MIN_ZOOM ? value : MIN_ZOOM;
    }

    /**
     * Compute the projection matrix used by the shader.
     *
     * Translate to the camera, scale by zoom, then map to NDC (-1..1, Y up). NDC Y is up
     * like the world, so no flip is needed.
     */
    public updateProjection(out?: Mat3): Mat3 {
        const m = out ?? this.viewProjection;
        const sx = (2 * this.zoom) / this.viewportWidth;
        const sy = (2 * this.zoom) / this.viewportHeight;
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
     * Screen → world in matrix form, for transforming many points at once.
     *
     * Same semantics as `screenToWorld`. Built analytically instead of by inversion because
     * world→NDC and NDC→screen each flip Y, and composing the flips is easy to get wrong.
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

    /** Currently visible world rectangle (frustum culling). Pass `out` to reuse an object. */
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

    /** Refresh `visBounds` if any input changed (no allocation) */
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

    /** Whether a single point is visible (margin widens the bounds, e.g. for preloading) */
    public isPointVisible(x: number, y: number, margin = 0): boolean {
        this.updateVisibleBounds();
        const r = this.visBounds;
        return (
            x >= r.x - margin && x <= r.x + r.width + margin && y >= r.y - margin && y <= r.y + r.height + margin
        );
    }

    /** Whether a rectangle is visible (margin widens the bounds) */
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
