/**
 * Loader tests: URL joining, manifest validation and the RenderDevice seam.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Loader } from "../src/renderer/Loader";
import type { RenderDevice, RenderTexture, TextureOptions } from "../src/renderer/RenderDevice";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

interface Recorded {
    image: unknown;
    width: number;
    height: number;
    options: TextureOptions | undefined;
}

function makeDevice(): { device: RenderDevice; recorded: Recorded[]; created: RenderTexture[] } {
    const recorded: Recorded[] = [];
    const created: RenderTexture[] = [];
    const device = {
        kind: "webgpu",
        createTexture: (image: TexImageSource, width: number, height: number, options?: TextureOptions): RenderTexture => {
            recorded.push({ image, width, height, options });
            const tex = { kind: "webgpu", width, height, premultiplied: false } as RenderTexture;
            created.push(tex);
            return tex;
        },
    } as unknown as RenderDevice;
    return { device, recorded, created };
}

function makeUrlRecorder(): { urls: string[]; fetchImpl: typeof fetch } {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
        urls.push(String(url));
        return {
            ok: true,
            status: 200,
            text: async () => "ok",
            json: async () => ({}),
            blob: async () => new Blob([]),
            arrayBuffer: async () => new ArrayBuffer(0),
        };
    }) as unknown as typeof fetch;
    return { urls, fetchImpl };
}

/** A loader whose fetch returns `manifest` for JSON and a blob for images. */
function makeManifestLoader(manifest: unknown): { device: RenderDevice; loader: Loader } {
    const { device } = makeDevice();
    const loader = new Loader({
        fetchImpl: (async (url: string) =>
            url.endsWith(".json")
                ? { ok: true, status: 200, json: async () => manifest }
                : { ok: true, status: 200, blob: async () => new Blob([]) }) as unknown as typeof fetch,
    });
    return { device, loader };
}

describe("Loader uses the render-device seam", () => {
    it("decodes through createImageBitmap and hands the image to device.createTexture", async () => {
        const bitmap = { width: 64, height: 32, close: vi.fn() };
        vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));

        const { device, recorded, created } = makeDevice();
        const loader = new Loader({
            basePath: "/assets/",
            texture: { linear: false },
            fetchImpl: (async () => ({ ok: true, blob: async () => new Blob([]) })) as unknown as typeof fetch,
        });

        const tex = await loader.texture(device, "atlas.png");
        expect(recorded.length).toBe(1);
        expect(recorded[0]?.width).toBe(64);
        expect(recorded[0]?.height).toBe(32);
        expect(recorded[0]?.options).toEqual({ linear: false });
        expect(tex).toBe(created[0]);
        expect(bitmap.close).toHaveBeenCalled();
    });

    it("closes the bitmap even when createTexture throws", async () => {
        const bitmap = { width: 8, height: 8, close: vi.fn() };
        vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));

        const device = {
            kind: "webgpu",
            createTexture: (): RenderTexture => {
                throw new Error("texture creation failed");
            },
        } as unknown as RenderDevice;
        const loader = new Loader({
            fetchImpl: (async () => ({ ok: true, blob: async () => new Blob([]) })) as unknown as typeof fetch,
        });

        await expect(loader.texture(device, "atlas.png")).rejects.toThrow("texture creation failed");
        expect(bitmap.close).toHaveBeenCalledTimes(1);
    });

    it("decodes with an image element on the WebGL2 backend", async () => {
        // WebGL ignores UNPACK_FLIP_Y for ImageBitmap, so this backend must not use one.
        const createBitmap = vi.fn();
        vi.stubGlobal("createImageBitmap", createBitmap);
        const images: FakeImage[] = [];
        class FakeImage {
            naturalWidth = 32;
            naturalHeight = 16;
            crossOrigin = "";
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            private _src = "";
            constructor() {
                images.push(this);
            }
            get src(): string {
                return this._src;
            }
            set src(value: string) {
                this._src = value;
                queueMicrotask(() => this.onload?.());
            }
        }
        vi.stubGlobal("Image", FakeImage);

        const recorded: Recorded[] = [];
        const device = {
            kind: "webgl2",
            createTexture: (image: TexImageSource, width: number, height: number): RenderTexture => {
                recorded.push({ image, width, height, options: undefined });
                return { kind: "webgl2", width, height, premultiplied: false } as RenderTexture;
            },
        } as unknown as RenderDevice;
        const loader = new Loader({ basePath: "/assets/" });

        await loader.texture(device, "atlas.png");

        expect(createBitmap).not.toHaveBeenCalled();
        expect(recorded[0]?.width).toBe(32);
        expect(recorded[0]?.height).toBe(16);
        expect(recorded[0]?.image).toBe(images[0]);
    });

    it("builds an atlas whose texture is the device-created one", async () => {
        const bitmap = { width: 128, height: 128, close: vi.fn() };
        vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));

        const { device, created } = makeDevice();
        const manifest = {
            image: "atlas.png",
            width: 128,
            height: 128,
            rects: [{ name: "CoalMine", x: 0, y: 0, width: 32, height: 32 }],
        };
        const loader = new Loader({
            fetchImpl: (async (url: string) =>
                url.endsWith(".json")
                    ? { ok: true, json: async () => manifest }
                    : { ok: true, blob: async () => new Blob([]) }) as unknown as typeof fetch,
        });

        const atlas = await loader.atlas(device, "atlas.json");
        expect(atlas.texture).toBe(created[0]);
        expect(atlas.size).toBe(1);
        expect(atlas.getSize("CoalMine")).toEqual({ width: 32, height: 32 });
        expect(atlas.getUV("CoalMine")).toEqual({ u0: 0, v0: 0.75, du: 0.25, dv: 0.25 });
    });
});

describe("Loader url joining", () => {
    it("joins basePath and path with exactly one slash", async () => {
        const cases: Array<[string, string, string]> = [
            ["/assets", "atlas.json", "/assets/atlas.json"],
            ["/assets/", "atlas.json", "/assets/atlas.json"],
            ["/assets/", "/atlas.json", "/atlas.json"],
            ["/assets", "/atlas.json", "/atlas.json"],
            ["", "atlas.json", "atlas.json"],
            ["assets", "atlas.json", "assets/atlas.json"],
            ["https://cdn.example/x", "a.png", "https://cdn.example/x/a.png"],
            ["https://cdn.example/x/", "a.png", "https://cdn.example/x/a.png"],
            ["/assets", "https://other.example/y.png", "https://other.example/y.png"],
            ["/assets", "//cdn.example/z.png", "//cdn.example/z.png"],
        ];

        for (const [basePath, path, expected] of cases) {
            const { urls, fetchImpl } = makeUrlRecorder();
            const loader = new Loader({ basePath, fetchImpl });
            await loader.text(path);
            expect(urls[0], `${basePath} + ${path}`).toBe(expected);
        }
    });
});

describe("Loader atlas manifest validation", () => {
    it("rejects invalid manifests with a descriptive error", async () => {
        const cases: Array<[string, unknown]> = [
            ["must be an object", null],
            ["must be an object", []],
            ["image must be a non-empty string", { image: "", width: 128, height: 128, rects: [] }],
            ["image must be a non-empty string", { width: 128, height: 128, rects: [] }],
            ["width must be a finite positive number", { image: "a.png", width: 0, height: 128, rects: [] }],
            ["width must be a finite positive number", { image: "a.png", width: Number.NaN, height: 128, rects: [] }],
            ["height must be a finite positive number", { image: "a.png", width: 128, height: -1, rects: [] }],
            ["rects must be an array", { image: "a.png", width: 128, height: 128, rects: "nope" }],
            [
                "rects[0].x must be a finite number",
                { image: "a.png", width: 128, height: 128, rects: [{ name: "a", x: "0", y: 0, width: 1, height: 1 }] },
            ],
            [
                "width and .height must be greater than 0",
                { image: "a.png", width: 128, height: 128, rects: [{ name: "a", x: 0, y: 0, width: 0, height: 1 }] },
            ],
            [
                ".name must be a non-empty string",
                { image: "a.png", width: 128, height: 128, rects: [{ name: "", x: 0, y: 0, width: 1, height: 1 }] },
            ],
            [
                "is outside the 128x128 atlas",
                { image: "a.png", width: 128, height: 128, rects: [{ name: "a", x: 120, y: 0, width: 16, height: 1 }] },
            ],
        ];

        for (const [message, manifest] of cases) {
            const { device, loader } = makeManifestLoader(manifest);
            await expect(loader.atlas(device, "atlas.json"), JSON.stringify(manifest)).rejects.toThrow(message);
        }
    });

    it("warns about duplicate rect names and keeps the first", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const bitmap = { width: 128, height: 128, close: vi.fn() };
        vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));

        const { device } = makeDevice();
        const manifest = {
            image: "atlas.png",
            width: 128,
            height: 128,
            rects: [
                { name: "Same", x: 0, y: 0, width: 16, height: 16 },
                { name: "Same", x: 32, y: 32, width: 8, height: 8 },
            ],
        };
        const loader = new Loader({
            fetchImpl: (async (url: string) =>
                url.endsWith(".json")
                    ? { ok: true, json: async () => manifest }
                    : { ok: true, blob: async () => new Blob([]) }) as unknown as typeof fetch,
        });

        const atlas = await loader.atlas(device, "atlas.json");
        expect(atlas.size).toBe(1);
        expect(atlas.getSize("Same")).toEqual({ width: 16, height: 16 });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("rejects a texture whose size does not match the manifest", async () => {
        const bitmap = { width: 64, height: 64, close: vi.fn() };
        vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
        const { device, loader } = makeManifestLoader({
            image: "atlas.png",
            width: 128,
            height: 128,
            rects: [{ name: "a", x: 0, y: 0, width: 16, height: 16 }],
        });

        await expect(loader.atlas(device, "atlas.json")).rejects.toThrow("declared 128x128 but texture is 64x64");
    });
});
