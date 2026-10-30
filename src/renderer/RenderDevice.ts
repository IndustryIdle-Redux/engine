/**
 * Render device abstraction — the seam between the backend-agnostic renderer facade
 * (`Renderer2D`) and the two graphics backends:
 *
 * | backend | role |
 * |---|---|
 * | `WebGL2Device` | **compatibility** — conservative, battle-tested; kept working on every browser |
 * | `WebGPUDevice`  | **primary** — aggressive optimisation target (compact instances, compute passes, cached buffers) |
 *
 * ### Draw-order guarantee (why `beginFrame`/`endFrame` wrap layers)
 * Both backends batch by kind (textured sprites / solid triangles). To keep the **call order**
 * visible — logistics lines over buildings, selection rings over dots, … — a device must flush
 * the currently active batch when the call kind switches (and at `endFrame`). Batching everything
 * of one kind before the other would silently reorder the scene (that bug existed before this split).
 */

import type { Color } from "../Color";
import type { Mat3 } from "../Mat3";
import type { SpriteDrawCall } from "../InstanceBuffer";

/** Backend-agnostic texture handle (the facade never touches GL/GPU objects) */
export interface RenderTexture {
    readonly width: number;
    readonly height: number;
}

export interface TextureOptions {
    /** linear filtering (pixel-art textures can set false) */
    linear?: boolean;
    /** wrap/repeat */
    wrap?: boolean;
    /** premultiply alpha */
    premultiplyAlpha?: boolean;
}

export interface Segment {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface RenderDevice {
    readonly kind: "webgl2" | "webgpu";

    /** stats for the last finished frame */
    readonly drawCalls: number;
    readonly instanceCount: number;
    readonly triangleCount: number;

    resize(pixelWidth: number, pixelHeight: number): void;

    /** begin a frame; `projection` maps world coordinates to clip space */
    beginFrame(clearColor: Color | undefined, projection: Mat3): void;
    /** finish the frame (flushes both batches in call order) */
    endFrame(): void;

    createTexture(image: TexImageSource, width: number, height: number, options?: TextureOptions): RenderTexture;

    /* ---- textured sprite layer (buildings / deposits / dots / glyphs) ---- */
    drawSprite(texture: RenderTexture, call: SpriteDrawCall): void;

    /* ---- solid triangle layer (grid / lines / highlight / circles) ---- */
    addTriangles(points: readonly number[], color: Color | undefined, dx: number, dy: number): void;
    addSegments(segments: readonly Segment[], width: number, color: Color | undefined): void;

    dispose(): void;
}
