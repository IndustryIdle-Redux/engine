/**
 * 2D renderer facade -- replaces Cocos's `cc.game` / `cc.director` / `cc.view` / `cc.Graphics`.
 *
 * Responsibilities:
 *  - own the render device + the canvas size (including devicePixelRatio handling)
 *  - organise one frame: `begin()` → submit shapes/sprites → `end()`
 *  - keep `Camera2D`'s viewport size in sync (replaces the 52 uses of `cc.winSize`)
 *  - expose draw call counts (replaces reading `cc.renderer.drawCalls`, an engine-private field)
 *
 * ### Two backends behind one facade
 * | backend | role |
 * |---|---|
 * | `WebGL2Device` | **compatibility** — conservative; runs everywhere |
 * | `WebGPUDevice` | **primary** — aggressive optimisation target |
 *
 * Picked at boot by `Renderer2D.create()` (WebGPU when available, WebGL2 otherwise).
 * Everything above this class (`WorldRenderer`, `WorldView`, UI, the demos) is backend-agnostic.
 *
 * ### Draw order
 * Call order is preserved exactly (logistics lines over buildings, selection rings over dots):
 * devices flush their current batch when the submission kind switches. (The old two-batch code
 * always drew "all vectors then all sprites", which silently reordered the scene.)
 *
 * ### Key differences from Cocos
 * **No scene graph, no Component, no lifecycle, no per-node dirty flags.**
 * The world layer just writes the visible entities into the batch every frame -- which is also the root reason the 13,042 nodes are gone.
 */

import { Color } from "../Color";
import { Camera2D } from "./Camera2D";
import type { SpriteDrawCall } from "../InstanceBuffer";
import type { RenderDevice, RenderTexture, TextureOptions } from "./RenderDevice";
import { WebGL2Device } from "./WebGL2Device";
import { WebGPUDevice } from "./WebGPUDevice";
import { circlePath, regularPolygonPath, roundedRectPath, strokePolyline, triangulatePolygon } from "./tessellate";
import type { Point } from "./tessellate";
import type { VisibleRect } from "./GridGeometry";

/**
 * Persisted backend choice (`Settings → Display → Render Backend`).
 *
 * `auto` leaves the decision to `Renderer2D.create()` (WebGPU when available, WebGL2 otherwise).
 */
export type RendererBackendChoice = "auto" | "webgl2" | "webgpu";

/**
 * Map a persisted choice onto what `create()` should be asked for.
 *
 * Anything that is not an explicit backend (including `"auto"`, `undefined` and values written by a
 * newer/older build) becomes `undefined` = "pick the best available".
 */
export function requestedBackend(choice: RendererBackendChoice | string | null | undefined): "webgl2" | "webgpu" | undefined {
    return choice === "webgl2" || choice === "webgpu" ? choice : undefined;
}

/**
 * Whether this browser exposes WebGPU at all (`navigator.gpu`).
 *
 * A cheap capability check for the settings UI — picking WebGPU where the API does not exist can
 * only end in the boot fallback (or a WebGL2 fallback), so the option is disabled instead.
 * Acquiring an adapter/device can still fail for other reasons and is handled by `create()`.
 */
export function webgpuAvailable(): boolean {
    return typeof navigator !== "undefined" && !!navigator.gpu;
}

export interface RendererOptions {
    alpha?: boolean;
    antialias?: boolean;
    /** Maximum devicePixelRatio (default 2, to avoid over-rendering on 4K screens) */
    maxPixelRatio?: number;
    /** force a backend (default: WebGPU when available, else WebGL2) */
    backend?: "webgl2" | "webgpu";
}

export class Renderer2D {
    public readonly canvas: HTMLCanvasElement;
    public readonly camera = new Camera2D();
    /** the active backend (WebGPU when available; `kind` says which) */
    public readonly device: RenderDevice;

    /** Logical size (CSS pixels) */
    public width = 1;
    public height = 1;
    public pixelWidth = 1;
    public pixelHeight = 1;
    public pixelRatio = 1;

    private readonly maxPixelRatio: number;
    private disposed = false;

    /**
     * @param device an already-created backend (from `create()`); when omitted a WebGL2 device
     * is created — note a canvas can only ever have **one** context type, so the WebGPU path
     * must inject its device here instead of letting the constructor touch the canvas first.
     */
    constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}, device?: RenderDevice) {
        this.canvas = canvas;
        this.maxPixelRatio = options.maxPixelRatio ?? 2;
        this.device = device ?? Renderer2D.createGLDevice(canvas, options);
        this.resize();
    }

    /**
     * Best-backend factory: **WebGPU first** (the aggressive optimisation target),
     * WebGL2 as the compatibility fallback. The persisted setting (or a `?backend=`-style override
     * for benchmarks) selects through `options.backend`.
     */
    public static async create(canvas: HTMLCanvasElement, options: RendererOptions = {}): Promise<Renderer2D> {
        if (options.backend !== "webgl2") {
            const gpu = await WebGPUDevice.create(canvas).catch(() => null);
            if (gpu) {
                return new Renderer2D(canvas, options, gpu);
            }
            if (options.backend === "webgpu") {
                throw new Error("[renderer] WebGPU was requested but is not available");
            }
        }
        return new Renderer2D(canvas, options);
    }

    private static createGLDevice(canvas: HTMLCanvasElement, options: RendererOptions): RenderDevice {
        // ⚠️ `alpha: false` — the game canvas is a full-screen opaque layer; with `alpha: true`
        // the drawing buffer keeps a dead alpha channel (screenshots come out fully transparent
        // and composite wrongly in image viewers). Same for the WebGPU backend (`alphaMode: "opaque"`).
        const gl = canvas.getContext("webgl2", {
            alpha: options.alpha === true,
            antialias: options.antialias !== false,
            premultipliedAlpha: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: false,
        });
        if (!gl) throw new Error("[renderer] WebGL2 is not supported in this environment");
        return new WebGL2Device(gl);
    }

    /**
     * Reset the drawing buffer from the canvas CSS size and devicePixelRatio.
     *
     * Replaces `cc.view` + the `AutoResizeCanvas` component.
     * @returns whether the size changed (callers can use this to decide whether to recompute cached world coordinates)
     */
    public resize(cssWidth?: number, cssHeight?: number): boolean {
        const rect = this.canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(cssWidth ?? rect.width ?? this.canvas.clientWidth ?? 1));
        const h = Math.max(1, Math.round(cssHeight ?? rect.height ?? this.canvas.clientHeight ?? 1));
        const dpr = Math.min(this.maxPixelRatio, globalThis.devicePixelRatio || 1);

        const pw = Math.max(1, Math.round(w * dpr));
        const ph = Math.max(1, Math.round(h * dpr));

        const changed = this.width !== w || this.height !== h || this.pixelRatio !== dpr;
        this.width = w;
        this.height = h;
        this.pixelRatio = dpr;
        this.pixelWidth = pw;
        this.pixelHeight = ph;

        if (this.canvas.width !== pw || this.canvas.height !== ph) {
            this.canvas.width = pw;
            this.canvas.height = ph;
        }
        this.camera.viewportWidth = w;
        this.camera.viewportHeight = h;
        this.device.resize(pw, ph);
        return changed;
    }

    /** Currently visible world rectangle (the basis for the world layer's frustum culling) */
    public getVisibleRect(out?: VisibleRect): VisibleRect {
        return this.camera.getVisibleRect(out);
    }

    /* ---------------- Frame organisation ---------------- */

    public begin(clearColor?: Color): void {
        const projection = this.camera.updateProjection();
        this.device.beginFrame(clearColor, projection);
    }

    /** End a frame (the device flushes both batches in call order) */
    public end(): void {
        this.device.endFrame();
    }

    /** Total draw call count for the current frame (graphics + sprites) */
    public get drawCalls(): number {
        return this.device.drawCalls;
    }

    /**
     * Render stats for this frame. Read after `end()` for that frame's final values.
     *
     * Purpose: performance benchmarks and real-load measurement (against the original Cocos draw call count).
     */
    public get stats(): { drawCalls: number; instances: number; triangles: number } {
        const instances = this.device.instanceCount;
        return {
            drawCalls: this.device.drawCalls,
            instances,
            triangles: this.device.triangleCount + instances * 2,
        };
    }

    /* ---------------- Sprites / textures ---------------- */

    public drawSprite(texture: RenderTexture, call: SpriteDrawCall): void {
        this.device.drawSprite(texture, call);
    }

    public createTexture(image: TexImageSource, width: number, height: number, options?: TextureOptions): RenderTexture {
        return this.device.createTexture(image, width, height, options);
    }

    public createSolidTexture(r = 255, g = 255, b = 255, a = 255): RenderTexture {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
            ctx.fillRect(0, 0, 1, 1);
        }
        return this.device.createTexture(canvas, 1, 1, { linear: false });
    }

    /* ---------------- Vector graphics ---------------- */

    /** Draw one line (expanded into a quad with width) */
    public drawLine(x0: number, y0: number, x1: number, y1: number, width = 1, color?: Color): void {
        this.device.addSegments([{ x0, y0, x1, y1 }], width, color);
    }

    /**
     * Draw grid lines/connection lines in bulk.
     *
     * Just pass in `GridGeometry`'s output; this is the entry point that replaces the original `drawGrid` (10,000 `stroke()` calls).
     * Internally it **writes straight into the vertex buffer** with no intermediate arrays (grid lines number in the thousands per frame, so this matters).
     */
    public drawSegments(
        segments: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number }>,
        width = 1,
        color?: Color,
    ): void {
        this.device.addSegments(segments, width, color);
    }

    /** Stroke a polyline (path hints, logistics links) */
    public strokePolyline(points: readonly Point[], width = 1, closed = false, color?: Color): void {
        this.device.addTriangles(strokePolyline(points, width, closed), color, 0, 0);
    }

    /** Fill a polygon (selection highlight, regions) */
    public fillPolygon(points: readonly Point[], color?: Color): void {
        this.device.addTriangles(triangulatePolygon(points), color, 0, 0);
    }

    /** Fill a circle (resource dots, ranges) */
    public fillCircle(cx: number, cy: number, radius: number, color?: Color, segments = 32): void {
        this.device.addTriangles(triangulatePolygon(circlePath(cx, cy, radius, segments)), color, 0, 0);
    }

    /** Stroke a circle (attack range ring) */
    public strokeCircle(cx: number, cy: number, radius: number, width = 1, color?: Color, segments = 32): void {
        this.device.addTriangles(strokePolyline(circlePath(cx, cy, radius, segments), width, true), color, 0, 0);
    }

    /** Fill a regular polygon (hexagon tile highlight) */
    public fillRegularPolygon(
        cx: number,
        cy: number,
        radius: number,
        sides: number,
        color?: Color,
        startAngle = 0,
    ): void {
        this.device.addTriangles(triangulatePolygon(regularPolygonPath(cx, cy, radius, sides, startAngle)), color, 0, 0);
    }

    /**
     * Fill many regular polygons of the same shape in bulk using **template + translation**.
     *
     * The overlay color blocks draw the same hexagon/square for every visible tile, and per-tile `triangulatePolygon`
     * allocates 2 arrays per tile and runs ear clipping each time; measured: 280 visible tiles cost **2.9 ms/frame in the submission stage**.
     * Here the template is computed once and afterwards only additions are written.
     *
     * @param template triangle vertices centred on the origin (obtained from `polygonTemplate`)
     * @param centers every position to fill
     */
    public fillPolygonTemplate(
        template: readonly number[],
        centers: ReadonlyArray<{ x: number; y: number }>,
        color?: Color,
    ): void {
        if (template.length === 0) return;
        for (let i = 0; i < centers.length; i++) {
            const c = centers[i] as { x: number; y: number };
            this.device.addTriangles(template, color, c.x, c.y);
        }
    }

    /**
     * Draw one template at `(x, y)` with its own colour — the per-shape variant of
     * `fillPolygonTemplate`, for many **differently coloured** shapes of the same geometry
     * (e.g. transport dots). No per-call path allocation or triangulation.
     */
    public fillPolygonTemplateAt(template: readonly number[], x: number, y: number, color?: Color): void {
        if (template.length === 0) return;
        this.device.addTriangles(template, color, x, y);
    }

    /** Build a regular-polygon triangle template centred on the origin (used with `fillPolygonTemplate`) */
    public polygonTemplate(radius: number, sides: number, startAngle = 0): number[] {
        return triangulatePolygon(regularPolygonPath(0, 0, radius, sides, startAngle));
    }

    /** Stroke a rounded rectangle (selection box) */
    public strokeRoundedRect(
        x: number,
        y: number,
        w: number,
        h: number,
        radius: number,
        width = 1,
        color?: Color,
    ): void {
        this.device.addTriangles(strokePolyline(roundedRectPath(x, y, w, h, radius), width, true), color, 0, 0);
    }

    /** Fill a rounded rectangle */
    public fillRoundedRect(x: number, y: number, w: number, h: number, radius: number, color?: Color): void {
        this.device.addTriangles(triangulatePolygon(roundedRectPath(x, y, w, h, radius)), color, 0, 0);
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.device.dispose();
    }
}
