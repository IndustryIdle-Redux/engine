/**
 * `Settings → Display → Render Backend` plumbing that does not need a GPU:
 *  - `requestedBackend()` — what the boot hands to `Renderer2D.create()` (only an explicit backend
 *    may be *forced*; `auto`/unknown values must leave the choice to the renderer)
 *  - `webgpuAvailable()` — the capability check behind disabling the WebGPU entry
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { requestedBackend, webgpuAvailable } from "../src/renderer/Renderer2D";

afterEach(() => {
    vi.unstubAllGlobals();
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
    it("is false where `navigator.gpu` does not exist (this test env / older browsers)", () => {
        vi.stubGlobal("navigator", {});
        expect(webgpuAvailable()).toBe(false);
    });

    it("is true when the browser exposes navigator.gpu", () => {
        vi.stubGlobal("navigator", { gpu: {} });
        expect(webgpuAvailable()).toBe(true);
    });
});
