/**
 * Backend selection without a GPU:
 *  - `requestedBackend()` maps the persisted setting onto `create()`'s argument
 *  - `webgpuAvailable()` is the capability check behind the settings entry
 *  - `Renderer2D.create()` falls back to WebGL2 on any WebGPU failure unless WebGPU is forced
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Color } from "../src/Color";
import { Mat3 } from "../src/Mat3";
import type { SpriteDrawCall } from "../src/InstanceBuffer";
import { Renderer2D, requestedBackend, webgpuAvailable } from "../src/renderer/Renderer2D";
import { WebGPUDevice } from "../src/renderer/WebGPUDevice";
import type { RenderDevice, RenderTexture, Segment } from "../src/renderer/RenderDevice";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("requestedBackend", () => {
    it("treats auto / undefined / unknown values as 'let the renderer pick'", () => {
        expect(requestedBackend("auto")).toBeUndefined();
        expect(requestedBackend(undefined)).toBeUndefined();
        expect(requestedBackend(null)).toBeUndefined();
        expect(requestedBackend("")).toBeUndefined();
        expect(requestedBackend("vulkan" as string)).toBeUndefined();
    });

    it("passes an explicit backend through", () => {
        expect(requestedBackend("webgl2")).toBe("webgl2");
        expect(requestedBackend("webgpu")).toBe("webgpu");
    });
});

describe("webgpuAvailable", () => {
    it("is false where `navigator.gpu` does not exist", () => {
        vi.stubGlobal("navigator", {});
        expect(webgpuAvailable()).toBe(false);
    });

    it("is true when the browser exposes navigator.gpu", () => {
        vi.stubGlobal("navigator", { gpu: {} });
        expect(webgpuAvailable()).toBe(true);
    });
});

class FakeDevice implements RenderDevice {
    public readonly kind: "webgl2" | "webgpu";
    public isLost = false;
    public onLost: (() => void) | null = null;
    public drawCalls = 0;
    public instanceCount = 0;
    public triangleCount = 0;

    constructor(kind: "webgl2" | "webgpu" = "webgl2") {
        this.kind = kind;
    }

    public resize(): void {}
    public beginFrame(_clearColor: Color | undefined, _projection: Mat3): void {}
    public endFrame(): void {}
    public createTexture(_image: TexImageSource, width: number, height: number): RenderTexture {
        return { kind: this.kind, width, height, premultiplied: false };
    }
    public updateTexture(): void {}
    public disposeTexture(): void {}
    public drawSprite(_texture: RenderTexture, _call: SpriteDrawCall): void {}
    public addTriangles(_points: readonly number[], _color: Color | undefined, _dx: number, _dy: number): void {}
    public addSegments(_segments: readonly Segment[], _width: number, _color: Color | undefined): void {}
    public async recover(): Promise<boolean> {
        return !this.isLost;
    }
    public dispose(): void {}
}

function makeCanvas(): HTMLCanvasElement {
    return {
        width: 0,
        height: 0,
        clientWidth: 64,
        clientHeight: 64,
        getBoundingClientRect: () => ({ width: 64, height: 64 }),
        getContext: () => null,
    } as unknown as HTMLCanvasElement;
}

function mockGLDevice(device: RenderDevice): void {
    const target = Renderer2D as unknown as { createGLDevice: (...args: unknown[]) => RenderDevice };
    vi.spyOn(target, "createGLDevice").mockReturnValue(device);
}

describe("Renderer2D.create backend fallback", () => {
    it("falls back to WebGL2 when WebGPU creation resolves null", async () => {
        vi.spyOn(WebGPUDevice, "create").mockResolvedValue(null);
        const gl = new FakeDevice("webgl2");
        mockGLDevice(gl);
        const renderer = await Renderer2D.create(makeCanvas());
        expect(renderer.device).toBe(gl);
    });

    it("falls back when WebGPU creation rejects (async failure)", async () => {
        vi.spyOn(WebGPUDevice, "create").mockRejectedValue(new Error("adapter lost"));
        const gl = new FakeDevice("webgl2");
        mockGLDevice(gl);
        const renderer = await Renderer2D.create(makeCanvas());
        expect(renderer.device).toBe(gl);
    });

    it("falls back when WebGPU creation throws synchronously", async () => {
        vi.spyOn(WebGPUDevice, "create").mockImplementation(() => {
            throw new Error("boom");
        });
        const gl = new FakeDevice("webgl2");
        mockGLDevice(gl);
        const renderer = await Renderer2D.create(makeCanvas());
        expect(renderer.device).toBe(gl);
    });

    it("uses WebGPU when it was created", async () => {
        const gpu = new FakeDevice("webgpu");
        vi.spyOn(WebGPUDevice, "create").mockResolvedValue(gpu as unknown as WebGPUDevice);
        const gl = new FakeDevice("webgl2");
        mockGLDevice(gl);
        const renderer = await Renderer2D.create(makeCanvas());
        expect(renderer.device).toBe(gpu);
    });

    it("throws when WebGPU was forced and creation failed", async () => {
        vi.spyOn(WebGPUDevice, "create").mockResolvedValue(null);
        mockGLDevice(new FakeDevice("webgl2"));
        await expect(Renderer2D.create(makeCanvas(), { backend: "webgpu" })).rejects.toThrow(/WebGPU was requested/);
    });
});
