/**
 * 2D renderer facade: owns the canvas/device, keeps `Camera2D` in sync and organises one
 * frame as `begin()` → submit shapes/sprites → `end()`.
 *
 * WebGPU is preferred when available; WebGL2 is the fallback. A lost device is reported
 * through `onDeviceLost` and can be rebuilt with `recover()`.
 */

import { Color } from "../Color";
import { Camera2D } from "./Camera2D";
import type { SpriteDrawCall } from "../InstanceBuffer";
import type { RenderDevice, RenderMesh, RenderTexture, TextureOptions } from "./RenderDevice";
import { WebGL2Device } from "./WebGL2Device";
import { WebGPUDevice } from "./WebGPUDevice";
import { circlePath, regularPolygonPath, roundedRectPath, strokePolyline, triangulatePolygon } from "./tessellate";
import type { Point } from "./tessellate";
import type { VisibleRect } from "./GridGeometry";

/** Persisted backend choice; `auto` lets `create()` pick. */
export type RendererBackendChoice = "auto" | "webgl2" | "webgpu";

/**
 * Map a persisted choice onto what `create()` should be asked for.
 *
 * Anything that is not an explicit backend becomes `undefined` ("pick the best available").
 */
export function requestedBackend(choice: RendererBackendChoice | string | null | undefined): "webgl2" | "webgpu" | undefined {
    return choice === "webgl2" || choice === "webgpu" ? choice : undefined;
}

/** Whether this browser exposes WebGPU at all. Adapter/device acquisition is handled by `create()`. */
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
    private readonly solidTextures = new Map<number, RenderTexture>();
    private disposed = false;

    /**
     * @param device an already-created backend (from `create()`); when omitted a WebGL2 device
     * is created. A canvas has only one context type, so the WebGPU path injects its device.
     */
    constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}, device?: RenderDevice) {
        this.canvas = canvas;
        this.maxPixelRatio = options.maxPixelRatio ?? 2;
        this.device = device ?? Renderer2D.createGLDevice(canvas, options);
        this.resize();
    }

    /**
     * Create the best available backend: WebGPU first, then WebGL2. Any WebGPU failure
     * (sync or async) falls back unless WebGPU was explicitly requested.
     */
    public static async create(canvas: HTMLCanvasElement, options: RendererOptions = {}): Promise<Renderer2D> {
        if (options.backend !== "webgl2") {
            let gpu: WebGPUDevice | null = null;
            try {
                gpu = await WebGPUDevice.create(canvas, options);
            } catch {
                gpu = null;
            }
            if (gpu) return new Renderer2D(canvas, options, gpu);
            if (options.backend === "webgpu") {
                throw new Error("[renderer] WebGPU was requested but could not be initialized");
            }
        }
        return new Renderer2D(canvas, options);
    }

    private static createGLDevice(canvas: HTMLCanvasElement, options: RendererOptions): RenderDevice {
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

    /* ---------------- device state ---------------- */

    public get isLost(): boolean {
        return this.device.isLost;
    }

    /** Called once when the backend device/context is lost. */
    public get onDeviceLost(): (() => void) | null {
        return this.device.onLost;
    }

    public set onDeviceLost(handler: (() => void) | null) {
        this.device.onLost = handler;
    }

    /** Rebuild backend resources after loss. Returns false when recovery failed. */
    public async recover(): Promise<boolean> {
        if (this.disposed) return false;
        return this.device.recover();
    }

    /**
     * Reset the drawing buffer from the canvas CSS size and devicePixelRatio.
     * @returns whether the size changed
     */
    public resize(cssWidth?: number, cssHeight?: number): boolean {
        if (this.disposed) return false;
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

    /** Currently visible world rectangle (basis for frustum culling) */
    public getVisibleRect(out?: VisibleRect): VisibleRect {
        return this.camera.getVisibleRect(out);
    }

    /* ---------------- Frame organisation ---------------- */

    public begin(clearColor?: Color): void {
        if (this.disposed || this.device.isLost) return;
        const projection = this.camera.updateProjection();
        this.device.beginFrame(clearColor, projection);
    }

    /** End a frame (the device flushes both batches in call order) */
    public end(): void {
        if (this.disposed || this.device.isLost) return;
        this.device.endFrame();
    }

    /** Total draw call count for the current frame (graphics + sprites) */
    public get drawCalls(): number {
        return this.device.drawCalls;
    }

    /** Render stats for this frame. Read after `end()` for final values. */
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
        if (this.disposed || this.device.isLost) return;
        this.device.drawSprite(texture, call);
    }

    public createTexture(image: TexImageSource, width: number, height: number, options?: TextureOptions): RenderTexture {
        if (this.disposed) throw new Error("[renderer] renderer has been disposed");
        return this.device.createTexture(image, width, height, options);
    }

    /** Re-upload an existing texture, optionally with a different image or size. */
    public updateTexture(
        texture: RenderTexture,
        image: TexImageSource,
        width: number,
        height: number,
        options?: TextureOptions,
    ): void {
        if (this.disposed) throw new Error("[renderer] renderer has been disposed");
        this.device.updateTexture(texture, image, width, height, options);
    }

    public disposeTexture(texture: RenderTexture): void {
        if (this.disposed) return;
        this.device.disposeTexture(texture);
    }

    /** 1×1 solid-colour texture. Instances are cached per colour. */
    public createSolidTexture(r = 255, g = 255, b = 255, a = 255): RenderTexture {
        if (this.disposed) throw new Error("[renderer] renderer has been disposed");
        const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
        const cached = this.solidTextures.get(key);
        if (cached) return cached;
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
            ctx.fillRect(0, 0, 1, 1);
        }
        const texture = this.device.createTexture(canvas, 1, 1, { linear: false });
        this.solidTextures.set(key, texture);
        return texture;
    }

    /* ---------------- Vector graphics ---------------- */

    /** Draw one line (expanded into a quad with width) */
    public drawLine(x0: number, y0: number, x1: number, y1: number, width = 1, color?: Color): void {
        if (this.disposed || this.device.isLost) return;
        this.device.addSegments([{ x0, y0, x1, y1 }], width, color);
    }

    /** Draw grid/connection lines in bulk, straight into the vector buffer. */
    public drawSegments(
        segments: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number }>,
        width = 1,
        color?: Color,
    ): void {
        if (this.disposed || this.device.isLost) return;
        this.device.addSegments(segments, width, color);
    }

    /**
     * Upload a static triangle mesh (interleaved `x, y, r, g, b, a`) for geometry that changes
     * rarely, such as the map grid. Draw it with `drawMesh`; release it with `disposeMesh`.
     */
    public createMesh(vertices: Float32Array): RenderMesh {
        if (this.disposed) throw new Error("[renderer] renderer has been disposed");
        return this.device.createMesh(vertices);
    }

    public drawMesh(mesh: RenderMesh): void {
        if (this.disposed || this.device.isLost) return;
        this.device.drawMesh(mesh);
    }

    public disposeMesh(mesh: RenderMesh): void {
        if (this.disposed) return;
        this.device.disposeMesh(mesh);
    }

    /** Stroke a polyline */
    public strokePolyline(points: readonly Point[], width = 1, closed = false, color?: Color): void {
        if (this.disposed || this.device.isLost) return;
        this.device.addTriangles(strokePolyline(points, width, closed), color, 0, 0);
    }

    /** Fill a polygon */
    public fillPolygon(points: readonly Point[], color?: Color): void {
        if (this.disposed || this.device.isLost) return;
        this.device.addTriangles(triangulatePolygon(points), color, 0, 0);
    }

    /** Fill a circle */
    public fillCircle(cx: number, cy: number, radius: number, color?: Color, segments = 32): void {
        if (this.disposed || this.device.isLost) return;
        this.device.addTriangles(triangulatePolygon(circlePath(cx, cy, radius, segments)), color, 0, 0);
    }

    /** Stroke a circle */
    public strokeCircle(cx: number, cy: number, radius: number, width = 1, color?: Color, segments = 32): void {
        if (this.disposed || this.device.isLost) return;
        this.device.addTriangles(strokePolyline(circlePath(cx, cy, radius, segments), width, true), color, 0, 0);
    }

    /** Fill a regular polygon */
    public fillRegularPolygon(
        cx: number,
        cy: number,
        radius: number,
        sides: number,
        color?: Color,
        startAngle = 0,
    ): void {
        if (this.disposed || this.device.isLost) return;
        this.device.addTriangles(triangulatePolygon(regularPolygonPath(cx, cy, radius, sides, startAngle)), color, 0, 0);
    }

    /**
     * Fill many regular polygons of the same shape using a precomputed template + translation,
     * avoiding per-tile triangulation.
     */
    public fillPolygonTemplate(
        template: readonly number[],
        centers: ReadonlyArray<{ x: number; y: number }>,
        color?: Color,
    ): void {
        if (this.disposed || this.device.isLost || template.length === 0) return;
        for (let i = 0; i < centers.length; i++) {
            const c = centers[i] as { x: number; y: number };
            this.device.addTriangles(template, color, c.x, c.y);
        }
    }

    /** Draw one template at `(x, y)` with its own colour. */
    public fillPolygonTemplateAt(template: readonly number[], x: number, y: number, color?: Color): void {
        if (this.disposed || this.device.isLost || template.length === 0) return;
        this.device.addTriangles(template, color, x, y);
    }

    /** Build a regular-polygon triangle template centred on the origin (used with `fillPolygonTemplate`) */
    public polygonTemplate(radius: number, sides: number, startAngle = 0): number[] {
        return triangulatePolygon(regularPolygonPath(0, 0, radius, sides, startAngle));
    }

    /** Stroke a rounded rectangle */
    public strokeRoundedRect(
        x: number,
        y: number,
        w: number,
        h: number,
        radius: number,
        width = 1,
        color?: Color,
    ): void {
        if (this.disposed || this.device.isLost) return;
        this.device.addTriangles(strokePolyline(roundedRectPath(x, y, w, h, radius), width, true), color, 0, 0);
    }

    /** Fill a rounded rectangle */
    public fillRoundedRect(x: number, y: number, w: number, h: number, radius: number, color?: Color): void {
        if (this.disposed || this.device.isLost) return;
        this.device.addTriangles(triangulatePolygon(roundedRectPath(x, y, w, h, radius)), color, 0, 0);
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.solidTextures.clear();
        this.device.dispose();
    }
}
