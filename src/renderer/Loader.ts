/**
 * Asset loading — replaces Cocos's `cc.resources.load` / `loadDir` / `cc.SpriteAtlas`.
 *
 * ### Differences from the original implementation
 * The original loads a **build-time generated AutoAtlas** through Cocos's Asset Bundle
 * (214 building images → packed into 1 701×1024 PNG at build time, indexed by SpriteFrame name at runtime).
 * Here we use **standard Web assets** instead:
 *  - images go through `<img>` / `createImageBitmap` (native browser caching)
 *  - an atlas is just "one PNG + a set of UV rects"; the rects come from a manifest JSON or from code
 *
 * Upside: free of Cocos's UUID/`.meta` system, assets can be served directly by any CDN/static server.
 *
 * This module only depends on `fetch` / `Image` / `createImageBitmap`, so it runs in the browser and in
 * modern Node (which has fetch) — the loading logic itself is testable (inject a fetch stub).
 *
 * ### Backend-agnostic textures
 * Textures are created through the `RenderDevice` seam (`device.createTexture(image, w, h, options)`),
 * **not** through `Texture.fromImage(gl, …)`. That GL-specific path used to stop the "backend agnostic
 * above `Renderer2D`" rule right at resource loading: every texture would have been a WebGL2 texture even
 * when the WebGPU backend was active. `Loader` therefore now takes a `RenderDevice`, exactly like
 * `Renderer2D.createTexture`.
 */

import type { RenderDevice, RenderTexture, TextureOptions } from "./RenderDevice";

/**
 * Atlas sub-rect → UV.
 *
 * ### ⚠️ This is the easiest place in the project to get wrong, and the hardest to notice once wrong
 * `Texture.fromImage` uploads with `UNPACK_FLIP_Y_WEBGL = true`,
 * and **what it flips is the whole atlas**: inside the GPU the relation between `v` and the image row is
 *   `image row = (1 - v) · H`
 * while in `SpriteBatch`'s `v_uv = uvPos + q · uvSize`, `q.y = 1` is the **top of the quad**.
 *
 * So for the "top of the quad" to show the sprite's **top row** `y`, we need:
 *   top v = uvPos.y + uvSize.y = 1 - y/H
 *   bottom v = uvPos.y          = 1 - (y+h)/H
 * i.e. `uvPos.y = 1 - (y+h)/H`, not the intuitive `y/H`.
 *
 * The intuitive `y/H` **flips every sprite vertically** and samples the neighboring region, showing up as "sprites shattered into pieces".
 * Note: when testing orientation with the **whole texture** (uvPos=0, uvSize=1) both formulas give 0,
 * so **this bug cannot be caught that way** — you must test with a real, non-full sub-rect.
 */
export function atlasRectToUV(
    rect: { x: number; y: number; width: number; height: number },
    atlasWidth: number,
    atlasHeight: number,
): { u0: number; v0: number; du: number; dv: number } {
    return {
        u0: rect.x / atlasWidth,
        // note: NOT rect.y / atlasHeight (see the derivation above)
        v0: 1 - (rect.y + rect.height) / atlasHeight,
        du: rect.width / atlasWidth,
        dv: rect.height / atlasHeight,
    };
}

/** A single rect in the atlas manifest (pixels) */
export interface AtlasRect {
    /** sprite name (matches the original's SpriteFrame name, e.g. a building key) */
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Atlas manifest file format (our own definition, replacing Cocos's AutoAtlas) */
export interface AtlasManifest {
    /** image path relative to the asset root directory */
    image: string;
    /** total atlas size (pixels) */
    width: number;
    height: number;
    /** sprite rects; the coordinate origin is the image's top-left corner */
    rects: AtlasRect[];
}

/** A loaded atlas: texture + name → UV mapping */
export class Atlas {
    public readonly texture: RenderTexture;
    public readonly width: number;
    public readonly height: number;
    private readonly uvByName = new Map<string, { u0: number; v0: number; du: number; dv: number }>();
    private readonly sizeByName = new Map<string, { width: number; height: number }>();

    constructor(texture: RenderTexture, manifest: AtlasManifest) {
        this.texture = texture;
        this.width = manifest.width;
        this.height = manifest.height;
        for (const r of manifest.rects) {
            // Always go through atlasRectToUV, so nobody writes their own copy (that is exactly how V got flipped once)
            this.uvByName.set(r.name, atlasRectToUV(r, manifest.width, manifest.height));
            this.sizeByName.set(r.name, { width: r.width, height: r.height });
        }
    }

    public has(name: string): boolean {
        return this.uvByName.has(name);
    }

    public getUV(name: string): { u0: number; v0: number; du: number; dv: number } | undefined {
        return this.uvByName.get(name);
    }

    public getSize(name: string): { width: number; height: number } | undefined {
        return this.sizeByName.get(name);
    }

    public get size(): number {
        return this.uvByName.size;
    }

    /**
     * Convenience: draw one sprite into the batch (looks up UV and size automatically).
     *
     * Returns false when it is `null` (sprite missing), so callers can fall back instead of throwing.
     */
    public draw(
        name: string,
        push: (texture: RenderTexture, call: { x: number; y: number; w: number; h: number; ax?: number; ay?: number; u0: number; v0: number; du: number; dv: number }) => void,
        x: number,
        y: number,
        opts: { scale?: number; ax?: number; ay?: number } = {},
    ): boolean {
        const uv = this.uvByName.get(name);
        const sz = this.sizeByName.get(name);
        if (!uv || !sz) return false;
        const s = opts.scale ?? 1;
        push(this.texture, {
            x,
            y,
            w: sz.width * s,
            h: sz.height * s,
            ...(opts.ax !== undefined ? { ax: opts.ax } : {}),
            ...(opts.ay !== undefined ? { ay: opts.ay } : {}),
            u0: uv.u0,
            v0: uv.v0,
            du: uv.du,
            dv: uv.dv,
        });
        return true;
    }
}

export interface LoaderOptions {
    /** asset root path (defaults to the empty string, i.e. relative to the current page) */
    basePath?: string;
    /** texture filter options */
    texture?: TextureOptions;
    /** custom fetch (for test injection) */
    fetchImpl?: typeof fetch;
}

/**
 * Asset loader.
 *
 * It only does "fetch bytes → decode → build texture"; no Cocos-style dependency graph and refcounting
 * (that would need the UUID system, and escaping it is the whole point).
 */
export class Loader {
    private readonly basePath: string;
    private readonly textureOptions: TextureOptions;
    private readonly fetchImpl: typeof fetch;

    constructor(options: LoaderOptions = {}) {
        this.basePath = options.basePath ?? "";
        this.textureOptions = options.texture ?? {};
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    }

    private url(path: string): string {
        if (/^(https?:)?\/\//.test(path) || path.startsWith("/")) return path;
        return `${this.basePath}${path}`;
    }

    /** Fetch binary (for WASM / workers etc.; replaces `fetch(getResourceUrl(...))`) */
    public async bytes(path: string): Promise<ArrayBuffer> {
        const res = await this.fetchImpl(this.url(path));
        if (!res.ok) throw new Error(`[loader] load failed ${path}: HTTP ${res.status}`);
        return res.arrayBuffer();
    }

    /** Fetch JSON (atlas manifests, config) */
    public async json<T>(path: string): Promise<T> {
        const res = await this.fetchImpl(this.url(path));
        if (!res.ok) throw new Error(`[loader] load failed ${path}: HTTP ${res.status}`);
        return (await res.json()) as T;
    }

    /** Fetch text (replaces `cc.TextAsset`, e.g. worker scripts, CSS) */
    public async text(path: string): Promise<string> {
        const res = await this.fetchImpl(this.url(path));
        if (!res.ok) throw new Error(`[loader] load failed ${path}: HTTP ${res.status}`);
        return res.text();
    }

    /**
     * Decode an image URL into a texture through the device seam.
     *
     * Prefer `createImageBitmap` (can decode off the main thread, and needs no DOM),
     * falling back to `<img>`. Both set `crossOrigin` so CDNs work.
     */
    public async texture(device: RenderDevice, path: string): Promise<RenderTexture> {
        const url = this.url(path);

        if (typeof createImageBitmap === "function") {
            const res = await this.fetchImpl(url);
            if (!res.ok) throw new Error(`[loader] load failed ${path}: HTTP ${res.status}`);
            const blob = await res.blob();
            const bitmap = await createImageBitmap(bitmapSource(blob));
            const t = device.createTexture(bitmap, bitmap.width, bitmap.height, this.textureOptions);
            bitmap.close();
            return t;
        }

        return new Promise<RenderTexture>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                resolve(device.createTexture(img, img.naturalWidth, img.naturalHeight, this.textureOptions));
            };
            img.onerror = () => reject(new Error(`[loader] image decode failed: ${path}`));
            img.src = url;
        });
    }

    /** Load the manifest + image and assemble a usable atlas */
    public async atlas(device: RenderDevice, manifestPath: string): Promise<Atlas> {
        const manifest = await this.json<AtlasManifest>(manifestPath);
        const texture = await this.texture(device, manifest.image);
        return new Atlas(texture, manifest);
    }
}

/** Extracted so tests can swap it (Blob also works in Node) */
function bitmapSource(blob: Blob): ImageBitmapSource {
    return blob as unknown as ImageBitmapSource;
}
