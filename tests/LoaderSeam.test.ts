/**
 * `Loader` backend seam.
 *
 * `Loader.texture` used to take a `WebGL2RenderingContext` and return a GL `Texture`
 * (`Texture.fromImage`), so the "everything above `Renderer2D` is backend-agnostic" rule stopped at
 * resource loading: with the WebGPU backend active, an atlas loaded through `Loader` would still have
 * been a WebGL2 texture object. It now goes through `RenderDevice.createTexture` and returns a
 * `RenderTexture`, exactly like `Renderer2D.createTexture`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Loader } from "../src/renderer/Loader";
import type { RenderDevice, RenderTexture, TextureOptions } from "../src/renderer/RenderDevice";

afterEach(() => {
    vi.unstubAllGlobals();
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
            const tex = { width, height } as RenderTexture;
            created.push(tex);
            return tex;
        },
    } as unknown as RenderDevice;
    return { device, recorded, created };
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
        // the loader's texture options are forwarded (they used to be GL-only)
        expect(recorded[0]?.options).toEqual({ linear: false });
        expect(tex).toBe(created[0]);
        // the decoded bitmap is released
        expect(bitmap.close).toHaveBeenCalled();
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
        // UVs still go through the shared helper (the V flip is derived once, in atlasRectToUV)
        expect(atlas.getUV("CoalMine")).toEqual({ u0: 0, v0: 0.75, du: 0.25, dv: 0.25 });
    });
});
