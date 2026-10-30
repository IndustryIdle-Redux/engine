/**
 * WebGL2 texture wrapper. The atlas model is "one texture + one UV sub-rect per sprite",
 * so sprites that share a texture merge into a single instanced draw.
 */

import { assertTextureSize, type TextureOptions, type TextureSource } from "./RenderDevice";

export type { TextureOptions } from "./RenderDevice";

/** Creates the GL object and applies the sampler parameters for the given options. */
function createHandle(gl: WebGL2RenderingContext, options: TextureOptions): WebGLTexture {
    const handle = gl.createTexture();
    if (!handle) throw new Error("[renderer] createTexture failed");
    const filter = options.linear === false ? gl.NEAREST : gl.LINEAR;
    const wrap = options.wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return handle;
}

/** Uploads an image or a 1×1 pixel block. Flipped on Y so UV (0,0) is the image top-left. */
function upload(
    gl: WebGL2RenderingContext,
    handle: WebGLTexture,
    image: TexImageSource | null,
    pixels: Uint8Array | null,
    premultiplied: boolean,
): void {
    gl.bindTexture(gl.TEXTURE_2D, handle);
    try {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, image !== null);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiplied);
        if (image) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        }
    } finally {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }
}

export class Texture {
    public readonly kind = "webgl2" as const;
    public handle: WebGLTexture;
    public width: number;
    public height: number;
    public premultiplied = false;

    private source: TextureSource | null;
    private pixels: Uint8Array | null;
    private disposed = false;

    private constructor(handle: WebGLTexture, source: TextureSource | null, pixels: Uint8Array | null) {
        this.handle = handle;
        this.source = source;
        this.pixels = pixels;
        this.width = source ? source.width : 1;
        this.height = source ? source.height : 1;
    }

    public static fromImage(
        gl: WebGL2RenderingContext,
        image: TexImageSource,
        width: number,
        height: number,
        options: TextureOptions = {},
    ): Texture {
        assertTextureSize(image, width, height);
        const handle = createHandle(gl, options);
        const texture = new Texture(handle, { image, width, height, options }, null);
        texture.premultiplied = options.premultiplyAlpha === true;
        upload(gl, handle, image, null, texture.premultiplied);
        return texture;
    }

    /** 1×1 solid-colour texture, used by sprites that have no image (bars, blocks). */
    public static solid(gl: WebGL2RenderingContext, r = 255, g = 255, b = 255, a = 255): Texture {
        const handle = createHandle(gl, {});
        const pixels = new Uint8Array([r, g, b, a]);
        const texture = new Texture(handle, null, pixels);
        upload(gl, handle, null, pixels, false);
        return texture;
    }

    /** Re-upload in place; keeps callers' references valid. */
    public update(
        gl: WebGL2RenderingContext,
        image: TexImageSource,
        width: number,
        height: number,
        options: TextureOptions = this.source?.options ?? {},
    ): void {
        if (this.disposed) throw new Error("[renderer] texture has been disposed");
        assertTextureSize(image, width, height);
        this.source = { image, width, height, options };
        this.pixels = null;
        this.width = width;
        this.height = height;
        this.premultiplied = options.premultiplyAlpha === true;
        // Filter settings are per-object, so they must be re-applied when options change.
        const filter = options.linear === false ? gl.NEAREST : gl.LINEAR;
        const wrap = options.wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
        gl.bindTexture(gl.TEXTURE_2D, this.handle);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        gl.bindTexture(gl.TEXTURE_2D, null);
        upload(gl, this.handle, this.source.image, null, this.premultiplied);
    }

    /** Recreate the GL object and re-upload, after the context has been restored. */
    public reload(gl: WebGL2RenderingContext): void {
        if (this.disposed) return;
        const options = this.source?.options ?? {};
        this.handle = createHandle(gl, options);
        upload(gl, this.handle, this.source?.image ?? null, this.pixels, this.premultiplied);
    }

    public dispose(gl: WebGL2RenderingContext): void {
        if (this.disposed) return;
        this.disposed = true;
        gl.deleteTexture(this.handle);
    }
}
