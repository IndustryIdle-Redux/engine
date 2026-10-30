/**
 * GPU texture wrapper.
 *
 * Corresponds to and replaces Cocos's `cc.Texture2D` / `cc.SpriteFrame` / `cc.SpriteAtlas`.
 *
 * Key design: **the atlas is the norm, not a special case**.
 * The original used Cocos's AutoAtlas (214 building images packed into one 701×1024 PNG);
 * here we use a "one texture + one UV sub-rectangle per sprite" model directly,
 * which fits instanced batch rendering naturally (sprites sharing a texture finish in one draw call).
 */

export interface TextureOptions {
    /** Whether to use linear filtering (default true; pixel-art textures can set false) */
    linear?: boolean;
    /** Whether to repeat/tile (needed when the map grid lines are baked into a texture) */
    wrap?: boolean;
    /** Premultiply alpha (default false) */
    premultiplyAlpha?: boolean;
}

export class Texture {
    public readonly handle: WebGLTexture;
    public readonly width: number;
    public readonly height: number;
    /** Tracks whether this has already been released, to avoid a double delete */
    private disposed = false;

    private constructor(handle: WebGLTexture, width: number, height: number) {
        this.handle = handle;
        this.width = width;
        this.height = height;
    }

    /**
     * Create a texture from an already-decoded image.
     *
     * Upload directly with `WebGL2RenderingContext`'s `texImage2D`
     * and **flip the Y axis** (`UNPACK_FLIP_Y_WEBGL`),
     * so the UV origin matches the top-left of the screen -- the same convention as Cocos's `SpriteFrame`,
     * which means UV math ported over from Cocos needs no changes.
     */
    public static fromImage(
        gl: WebGL2RenderingContext,
        image: TexImageSource,
        width: number,
        height: number,
        options: TextureOptions = {},
    ): Texture {
        const handle = gl.createTexture();
        if (!handle) throw new Error("[renderer] createTexture failed");

        gl.bindTexture(gl.TEXTURE_2D, handle);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, options.premultiplyAlpha === true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

        const filter = options.linear === false ? gl.NEAREST : gl.LINEAR;
        const wrap = options.wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        // Mipmaps off: 2D sprites normally don't need them, and it saves a generateMipmap call
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

        return new Texture(handle, width, height);
    }

    /**
     * Create a solid-color 1×1 texture.
     *
     * For sprites with no image (color blocks, health bars, grid lines) -- this way they can also go through batch rendering,
     * without needing a separate shader.
     */
    public static solid(gl: WebGL2RenderingContext, r = 255, g = 255, b = 255, a = 255): Texture {
        const handle = gl.createTexture();
        if (!handle) throw new Error("[renderer] createTexture failed");
        gl.bindTexture(gl.TEXTURE_2D, handle);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            1,
            1,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            new Uint8Array([r, g, b, a]),
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return new Texture(handle, 1, 1);
    }

    /** Release GPU resources */
    public dispose(gl: WebGL2RenderingContext): void {
        if (this.disposed) return;
        this.disposed = true;
        gl.deleteTexture(this.handle);
    }
}
