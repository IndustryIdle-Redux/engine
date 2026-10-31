/**
 * Asset loading: fetch, decode and build textures through the backend-agnostic
 * `RenderDevice` seam. There is no dependency graph or refcounting; an atlas is just
 * one image plus a manifest of UV rects.
 */

import type { RenderDevice, RenderTexture, TextureOptions } from "./RenderDevice";

/**
 * Atlas sub-rect to UV.
 *
 * Textures are uploaded flipped vertically (image row = (1 - v) * H), while q.y = 1 is
 * the top of the quad. So the top of the quad must sample the rect's top row:
 *   top v = 1 - y/H, bottom v = 1 - (y + h)/H
 * which gives `v0 = 1 - (y + h)/H`, not the intuitive `y/H`.
 */
export function atlasRectToUV(
    rect: { x: number; y: number; width: number; height: number },
    atlasWidth: number,
    atlasHeight: number,
): { u0: number; v0: number; du: number; dv: number } {
    return {
        u0: rect.x / atlasWidth,
        v0: 1 - (rect.y + rect.height) / atlasHeight,
        du: rect.width / atlasWidth,
        dv: rect.height / atlasHeight,
    };
}

/** A single rect in the atlas manifest (pixels) */
export interface AtlasRect {
    /** Sprite name (e.g. a building key) */
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Atlas manifest: image path relative to the asset root plus sprite rects. */
export interface AtlasManifest {
    image: string;
    /** Total atlas size (pixels) */
    width: number;
    height: number;
    /** Sprite rects, origin at the image's top-left corner */
    rects: AtlasRect[];
}

/** A loaded atlas: texture + name to UV mapping. */
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
            // keep the first entry for a name; Loader.atlas warns about duplicates
            if (this.uvByName.has(r.name)) continue;
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

    /** Draw one sprite into the batch; returns false when the sprite is missing. */
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
    /** Asset root path (defaults to the empty string, i.e. relative to the page) */
    basePath?: string;
    /** Texture filter options */
    texture?: TextureOptions;
    /** Custom fetch (for test injection) */
    fetchImpl?: typeof fetch;
}

/** Asset loader: fetch bytes, decode images and build textures/atlases. */
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
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path) || path.startsWith("/")) return path;
        const base = this.basePath;
        if (!base) return path;
        return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    }

    /** Fetch binary (WASM, workers, ...) */
    public async bytes(path: string): Promise<ArrayBuffer> {
        const res = await this.fetchImpl(this.url(path));
        if (!res.ok) throw new Error(`[loader] load failed ${path}: HTTP ${res.status}`);
        return res.arrayBuffer();
    }

    /** Fetch JSON */
    public async json<T>(path: string): Promise<T> {
        const res = await this.fetchImpl(this.url(path));
        if (!res.ok) throw new Error(`[loader] load failed ${path}: HTTP ${res.status}`);
        return (await res.json()) as T;
    }

    /** Fetch text (worker scripts, CSS, ...) */
    public async text(path: string): Promise<string> {
        const res = await this.fetchImpl(this.url(path));
        if (!res.ok) throw new Error(`[loader] load failed ${path}: HTTP ${res.status}`);
        return res.text();
    }

    /**
     * Decode an image URL into a texture through the device seam.
     *
     * Both backends upload images flipped vertically (WebGL sets `UNPACK_FLIP_Y`,
     * WebGPU passes `flipY` to `copyExternalImageToTexture`), which is what
     * `atlasRectToUV()` assumes. However the WebGL spec says `UNPACK_FLIP_Y_WEBGL`
     * is **ignored for `ImageBitmap` sources**, so a bitmap would arrive unflipped
     * there while WebGPU does flip it. WebGL2 therefore decodes through an
     * `HTMLImageElement`; WebGPU keeps the off-thread bitmap decode.
     */
    public async texture(device: RenderDevice, path: string): Promise<RenderTexture> {
        const url = this.url(path);

        if (device.kind !== "webgl2" && typeof createImageBitmap === "function") {
            const res = await this.fetchImpl(url);
            if (!res.ok) throw new Error(`[loader] load failed ${path}: HTTP ${res.status}`);
            const blob = await res.blob();
            const bitmap = await createImageBitmap(bitmapSource(blob));
            try {
                return device.createTexture(bitmap, bitmap.width, bitmap.height, this.textureOptions);
            } finally {
                bitmap.close();
            }
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

    /** Load the manifest + image and assemble a validated atlas. */
    public async atlas(device: RenderDevice, manifestPath: string): Promise<Atlas> {
        const manifest = validateAtlasManifest(await this.json<unknown>(manifestPath));
        const texture = await this.texture(device, manifest.image);
        if (texture.width !== manifest.width || texture.height !== manifest.height) {
            throw new Error(
                `[loader] atlas manifest ${manifestPath}: declared ${manifest.width}x${manifest.height} ` +
                    `but texture is ${texture.width}x${texture.height}`,
            );
        }
        return new Atlas(texture, manifest);
    }
}

/** Validate an untrusted manifest and drop duplicate rect names (keeping the first). */
function validateAtlasManifest(value: unknown): AtlasManifest {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("[loader] atlas manifest must be an object");
    }
    const manifest = value as Record<string, unknown>;

    if (typeof manifest.image !== "string" || manifest.image.trim() === "") {
        throw new Error("[loader] atlas manifest: image must be a non-empty string");
    }
    const width = manifest.width;
    const height = manifest.height;
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
        throw new Error("[loader] atlas manifest: width must be a finite positive number");
    }
    if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
        throw new Error("[loader] atlas manifest: height must be a finite positive number");
    }
    if (!Array.isArray(manifest.rects)) {
        throw new Error("[loader] atlas manifest: rects must be an array");
    }

    const rects: AtlasRect[] = [];
    const names = new Set<string>();
    for (let i = 0; i < manifest.rects.length; i++) {
        const raw = manifest.rects[i] as unknown;
        const where = `rects[${i}]`;
        if (typeof raw !== "object" || raw === null) {
            throw new Error(`[loader] atlas manifest: ${where} must be an object`);
        }
        const rect = raw as Record<string, unknown>;
        if (typeof rect.name !== "string" || rect.name.trim() === "") {
            throw new Error(`[loader] atlas manifest: ${where}.name must be a non-empty string`);
        }
        for (const field of ["x", "y", "width", "height"] as const) {
            const v = rect[field];
            if (typeof v !== "number" || !Number.isFinite(v)) {
                throw new Error(`[loader] atlas manifest: ${where}.${field} must be a finite number`);
            }
        }
        const x = rect.x as number;
        const y = rect.y as number;
        const w = rect.width as number;
        const h = rect.height as number;
        if (w <= 0 || h <= 0) {
            throw new Error(`[loader] atlas manifest: ${where}.width and .height must be greater than 0`);
        }
        if (x < 0 || y < 0 || x + w > width || y + h > height) {
            throw new Error(
                `[loader] atlas manifest: ${where} "${rect.name}" is outside the ${width}x${height} atlas`,
            );
        }
        if (names.has(rect.name)) {
            console.warn(`[loader] atlas manifest: duplicate rect name "${rect.name}", keeping the first`);
            continue;
        }
        names.add(rect.name);
        rects.push({ name: rect.name, x, y, width: w, height: h });
    }

    return { image: manifest.image, width, height, rects };
}

/** Extracted so tests can swap it (Blob also works in Node) */

function bitmapSource(blob: Blob): ImageBitmapSource {
    return blob as unknown as ImageBitmapSource;
}
