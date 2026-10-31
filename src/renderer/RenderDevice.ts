/**
 * Backend seam between `Renderer2D` and the two graphics backends (`WebGL2Device`,
 * `WebGPUDevice`).
 *
 * Both devices flush their active batch when the draw kind switches, so the submitted
 * call order is preserved (vector overlay over sprites, etc.).
 */

import type { Color } from "../Color";
import type { Mat3 } from "../Mat3";
import type { SpriteDrawCall } from "../InstanceBuffer";

/** Backend-agnostic texture handle. The facade never touches GL/GPU objects. */
export interface RenderTexture {
    /** Which backend created this texture. */
    readonly kind: "webgl2" | "webgpu";
    readonly width: number;
    readonly height: number;
    /** Whether the image was uploaded with premultiplied alpha. */
    readonly premultiplied: boolean;
}

/**
 * Static triangle mesh: interleaved `x, y, r, g, b, a` vertices, uploaded once and drawn with the
 * vector pipeline. Use it for geometry that is rebuilt rarely (map grid lines, cached overlays).
 */
export interface RenderMesh {
    readonly kind: "webgl2" | "webgpu";
    readonly vertexCount: number;
}


export interface TextureOptions {
    /** Linear filtering; set false for pixel-art textures. */
    linear?: boolean;
    /** Repeat/tile instead of clamp-to-edge. */
    wrap?: boolean;
    /** Premultiply alpha on upload. */
    premultiplyAlpha?: boolean;
}

/** Original source of a texture, retained so it can be re-uploaded after loss. */
export interface TextureSource {
    image: TexImageSource;
    width: number;
    height: number;
    options: TextureOptions;
}

export interface Segment {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Pixel size of a decoded image source, or null when the type has no readable size. */
export function textureSourceSize(image: TexImageSource): { width: number; height: number } | null {
    const source = image as unknown as {
        width?: unknown;
        height?: unknown;
        naturalWidth?: unknown;
        naturalHeight?: unknown;
        videoWidth?: unknown;
        videoHeight?: unknown;
    };
    if (
        typeof source.naturalWidth === "number" &&
        source.naturalWidth > 0 &&
        typeof source.naturalHeight === "number" &&
        source.naturalHeight > 0
    ) {
        return { width: source.naturalWidth, height: source.naturalHeight };
    }
    if (
        typeof source.videoWidth === "number" &&
        source.videoWidth > 0 &&
        typeof source.videoHeight === "number" &&
        source.videoHeight > 0
    ) {
        return { width: source.videoWidth, height: source.videoHeight };
    }
    if (
        typeof source.width === "number" &&
        source.width > 0 &&
        typeof source.height === "number" &&
        source.height > 0
    ) {
        return { width: source.width, height: source.height };
    }
    return null;
}

/** Both backends require the declared size to match the decoded source size. */
export function assertTextureSize(image: TexImageSource, width: number, height: number): void {
    const size = textureSourceSize(image);
    if (size && (size.width !== width || size.height !== height)) {
        throw new Error(
            `[renderer] texture size ${width}x${height} does not match the source image (${size.width}x${size.height})`,
        );
    }
}

export interface RenderDevice {
    /** Which backend this device drives; asset code uses it for backend-specific upload rules. */
    readonly kind: "webgl2" | "webgpu";

    /** True after the GPU device or the WebGL2 context has been lost. */
    readonly isLost: boolean;
    /** Called once when the device is lost; rendering is a no-op until `recover()` succeeds. */
    onLost: (() => void) | null;

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

    /** Re-upload a texture, optionally with a different image or size. */
    updateTexture(
        texture: RenderTexture,
        image: TexImageSource,
        width: number,
        height: number,
        options?: TextureOptions,
    ): void;

    disposeTexture(texture: RenderTexture): void;

    /** Upload a static triangle mesh; the data is interleaved `x, y, r, g, b, a`. */
    createMesh(vertices: Float32Array): RenderMesh;
    /** Draw a mesh in the vector layer, flushing pending batches first to preserve call order. */
    drawMesh(mesh: RenderMesh): void;
    disposeMesh(mesh: RenderMesh): void;

    /* ---- textured sprite layer (buildings / deposits / dots / glyphs) ---- */
    drawSprite(texture: RenderTexture, call: SpriteDrawCall): void;

    /* ---- solid triangle layer (grid / lines / highlight / circles) ---- */
    addTriangles(points: readonly number[], color: Color | undefined, dx: number, dy: number): void;
    addSegments(segments: readonly Segment[], width: number, color: Color | undefined): void;

    /** Rebuild GPU resources after loss. WebGL2 cannot force this (the browser restores). */
    recover(): Promise<boolean>;

    dispose(): void;
}
