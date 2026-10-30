/**
 * Renderer structure, layout and facade tests.
 *
 * The shader layout must stay in sync with `INSTANCE_ATTRIBS`; a mismatch only shows up as a
 * garbled frame on a real device. The facade tests use a fake `RenderDevice` to cover resize,
 * projection hand-off, stats and lifetime guards without a GPU.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Color } from "../src/Color";
import { Mat3 } from "../src/Mat3";
import { FLOATS_PER_INSTANCE, INSTANCE_ATTRIBS } from "../src/InstanceBuffer";
import type { SpriteDrawCall } from "../src/InstanceBuffer";
import { BatchList, FRAGMENT_SHADER_SOURCE, VERTEX_SHADER_SOURCE } from "../src/renderer/SpriteBatch";
import type { Texture } from "../src/renderer/Texture";
import { Renderer2D } from "../src/renderer/Renderer2D";
import type { RenderDevice, RenderTexture, Segment, TextureOptions } from "../src/renderer/RenderDevice";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Shader and instance layout consistency", () => {
    it("the number of shader attribute locations matches INSTANCE_ATTRIBS", () => {
        const locations = [...VERTEX_SHADER_SOURCE.matchAll(/layout\(location = (\d+)\)/g)];
        expect(locations.length).toBe(INSTANCE_ATTRIBS.length);
    });

    it("the sum of attribute component counts = FLOATS_PER_INSTANCE", () => {
        const sum = INSTANCE_ATTRIBS.reduce((acc, a) => acc + a.size, 0);
        expect(sum).toBe(FLOATS_PER_INSTANCE);
    });

    it("layout(location) numbers are contiguous and start at 0", () => {
        const locations = [...VERTEX_SHADER_SOURCE.matchAll(/layout\(location = (\d+)\)/g)].map((m) => Number(m[1]));
        expect(locations).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it("every attribute name in the shader is declared in INSTANCE_ATTRIBS", () => {
        const declared = [...VERTEX_SHADER_SOURCE.matchAll(/layout\(location = \d+\) in \w+ (a_\w+);/g)].map(
            (m) => m[1],
        );
        expect(declared).toEqual(INSTANCE_ATTRIBS.map((a) => a.name));
    });

    it("the vertex shader builds the quad from gl_VertexID (no quad VBO needed)", () => {
        expect(VERTEX_SHADER_SOURCE).toContain("gl_VertexID");
        expect(VERTEX_SHADER_SOURCE).toContain("QUAD[6]");
        const quadEntries = [...VERTEX_SHADER_SOURCE.matchAll(/vec2\(/g)].length;
        expect(quadEntries).toBeGreaterThanOrEqual(6);
    });

    it("instance rotation uses the precomputed (cos,sin); the shader does no trig", () => {
        expect(VERTEX_SHADER_SOURCE).toContain("a_rot");
        expect(VERTEX_SHADER_SOURCE).not.toMatch(/\bcos\s*\(/);
        expect(VERTEX_SHADER_SOURCE).not.toMatch(/\bsin\s*\(/);
    });

    it("both shaders are declared as WebGL2 (#version 300 es)", () => {
        expect(VERTEX_SHADER_SOURCE.startsWith("#version 300 es")).toBe(true);
        expect(FRAGMENT_SHADER_SOURCE.startsWith("#version 300 es")).toBe(true);
    });

    it("the vertex shader outputs v_uv / v_color and the fragment shader takes the same varyings", () => {
        expect(VERTEX_SHADER_SOURCE).toMatch(/out vec2 v_uv;/);
        expect(VERTEX_SHADER_SOURCE).toMatch(/out vec4 v_color;/);
        expect(FRAGMENT_SHADER_SOURCE).toMatch(/in vec2 v_uv;/);
        expect(FRAGMENT_SHADER_SOURCE).toMatch(/in vec4 v_color;/);
    });
});

describe("BatchList grouping", () => {
    const texA = { premultiplied: false } as Texture;
    const texB = { premultiplied: false } as Texture;

    function group(textures: readonly Texture[]): ReadonlyArray<{ texture: Texture; count: number }> {
        const list = new BatchList();
        textures.forEach((texture, i) => list.add(texture, i));
        return list.items;
    }

    it("consecutive identical textures merge into one draw call", () => {
        expect(group([texA, texA, texA])).toEqual([{ texture: texA, start: 0, count: 3 }]);
    });

    it("alternating textures degrade into multiple draw calls", () => {
        expect(group([texA, texB, texA]).map((b) => b.count)).toEqual([1, 1, 1]);
    });

    it("sorting the input by texture minimizes draw calls", () => {
        expect(group([texA, texB, texA, texB, texA, texB]).length).toBe(6);
        expect(group([texA, texA, texA, texB, texB, texB]).length).toBe(2);
    });

    it("10k sprites from the same atlas = 1 draw call", () => {
        const list = new BatchList();
        for (let i = 0; i < 10000; i++) list.add(texA, i);
        expect(list.length).toBe(1);
        expect(list.items[0]?.count).toBe(10000);
    });
});

/* ------------------------------------------------------------------ *
 * Renderer2D facade
 * ------------------------------------------------------------------ */

const SPRITE: SpriteDrawCall = { x: 0, y: 0, w: 8, h: 8, color: Color.WHITE };

class FakeDevice implements RenderDevice {
    public readonly kind = "webgl2" as const;
    public isLost = false;
    public onLost: (() => void) | null = null;
    public drawCalls = 0;
    public instanceCount = 0;
    public triangleCount = 0;
    public resized: Array<[number, number]> = [];
    public beginCount = 0;
    public endCount = 0;
    public disposeCount = 0;
    public spriteCount = 0;
    public segmentCalls = 0;
    public triangleCalls = 0;
    public readonly textures: RenderTexture[] = [];
    public readonly projection = new Mat3();
    public clearColor: Color | undefined;

    public resize(width: number, height: number): void {
        this.resized.push([width, height]);
    }

    public beginFrame(clearColor: Color | undefined, projection: Mat3): void {
        this.beginCount++;
        this.clearColor = clearColor;
        this.projection.copyFrom(projection);
    }

    public endFrame(): void {
        this.endCount++;
    }

    public createTexture(
        _image: TexImageSource,
        width: number,
        height: number,
        options?: TextureOptions,
    ): RenderTexture {
        const texture: RenderTexture = {
            kind: this.kind,
            width,
            height,
            premultiplied: options?.premultiplyAlpha === true,
        };
        this.textures.push(texture);
        return texture;
    }

    public updateTexture(): void {}
    public disposeTexture(): void {}

    public drawSprite(): void {
        this.spriteCount++;
    }

    public addTriangles(_points: readonly number[], _color: Color | undefined, _dx: number, _dy: number): void {
        this.triangleCalls++;
    }

    public addSegments(_segments: readonly Segment[], _width: number, _color: Color | undefined): void {
        this.segmentCalls++;
    }

    public async recover(): Promise<boolean> {
        return !this.isLost;
    }

    public dispose(): void {
        this.disposeCount++;
    }
}

function makeCanvas(width = 320, height = 240): HTMLCanvasElement {
    return {
        width: 0,
        height: 0,
        clientWidth: width,
        clientHeight: height,
        getBoundingClientRect: () => ({ width, height }),
    } as unknown as HTMLCanvasElement;
}

function makeRenderer(): { renderer: Renderer2D; device: FakeDevice; canvas: HTMLCanvasElement } {
    const device = new FakeDevice();
    const canvas = makeCanvas();
    return { renderer: new Renderer2D(canvas, {}, device), device, canvas };
}

describe("Renderer2D resize", () => {
    it("uses the CSS size and caps the device pixel ratio", () => {
        vi.stubGlobal("devicePixelRatio", 3);
        const { renderer, device, canvas } = makeRenderer();
        expect(renderer.width).toBe(320);
        expect(renderer.height).toBe(240);
        expect(renderer.pixelRatio).toBe(2);
        expect(renderer.pixelWidth).toBe(640);
        expect(renderer.pixelHeight).toBe(480);
        expect(canvas.width).toBe(640);
        expect(canvas.height).toBe(480);
        expect(device.resized).toEqual([[640, 480]]);
        expect(renderer.camera.viewportWidth).toBe(320);
        expect(renderer.camera.viewportHeight).toBe(240);
    });

    it("explicit resize overrides the CSS size", () => {
        vi.stubGlobal("devicePixelRatio", 1);
        const { renderer, device } = makeRenderer();
        expect(renderer.resize(100, 50)).toBe(true);
        expect(renderer.pixelWidth).toBe(100);
        expect(renderer.pixelHeight).toBe(50);
        expect(device.resized[device.resized.length - 1]).toEqual([100, 50]);
        expect(renderer.resize(100, 50)).toBe(false);
    });
});

describe("Renderer2D frame and stats", () => {
    it("begin() hands the camera projection to the device", () => {
        const { renderer, device } = makeRenderer();
        renderer.camera.position.set(10, 20);
        renderer.camera.zoom = 2;
        const clear = new Color(1, 2, 3, 4);
        renderer.begin(clear);
        expect(device.beginCount).toBe(1);
        expect(device.clearColor).toBe(clear);
        const p = device.projection.transformPoint(10, 20);
        expect(p.x).toBeCloseTo(0, 9);
        expect(p.y).toBeCloseTo(0, 9);
        const right = device.projection.transformPoint(10 + 320 / 2 / 2, 20);
        expect(right.x).toBeCloseTo(1, 9);
        expect(device.endCount).toBe(0);
        renderer.end();
        expect(device.endCount).toBe(1);
    });

    it("stats add sprite triangles to the device triangle count", () => {
        const { renderer, device } = makeRenderer();
        device.drawCalls = 3;
        device.instanceCount = 4;
        device.triangleCount = 5;
        expect(renderer.stats).toEqual({ drawCalls: 3, instances: 4, triangles: 13 });
    });

    it("draw calls are no-ops while the device is lost", () => {
        const { renderer, device } = makeRenderer();
        device.isLost = true;
        expect(renderer.isLost).toBe(true);
        renderer.drawSprite(renderer.createTexture({} as TexImageSource, 1, 1), SPRITE);
        renderer.begin();
        renderer.end();
        renderer.drawLine(0, 0, 10, 10);
        expect(device.spriteCount).toBe(0);
        expect(device.beginCount).toBe(0);
        expect(device.endCount).toBe(0);
        expect(device.segmentCalls).toBe(0);
    });
});

describe("Renderer2D texture lifetime", () => {
    it("routes device-lost callbacks through onDeviceLost", () => {
        const { renderer, device } = makeRenderer();
        const handler = (): void => {};
        renderer.onDeviceLost = handler;
        expect(renderer.onDeviceLost).toBe(handler);
        expect(device.onLost).toBe(handler);
    });

    it("createTexture passes options through and createSolidTexture caches per colour", () => {
        vi.stubGlobal("document", {
            createElement: () => ({
                width: 0,
                height: 0,
                getContext: () => ({ fillStyle: "", fillRect: (): void => {} }),
            }),
        });
        const { renderer, device } = makeRenderer();
        const texture = renderer.createTexture({} as TexImageSource, 2, 2, { premultiplyAlpha: true });
        expect(texture.premultiplied).toBe(true);

        const red = renderer.createSolidTexture(255, 0, 0);
        const redAgain = renderer.createSolidTexture(255, 0, 0);
        const green = renderer.createSolidTexture(0, 255, 0);
        expect(redAgain).toBe(red);
        expect(green).not.toBe(red);
        // 1 explicit texture + 2 cached solids
        expect(device.textures.length).toBe(3);
    });

    it("dispose is idempotent, and post-dispose calls are guarded", () => {
        const { renderer, device } = makeRenderer();
        renderer.dispose();
        renderer.dispose();
        expect(device.disposeCount).toBe(1);

        renderer.begin();
        renderer.drawSprite({ kind: "webgl2", width: 1, height: 1, premultiplied: false }, SPRITE);
        renderer.drawLine(0, 0, 1, 1);
        expect(device.beginCount).toBe(0);
        expect(device.spriteCount).toBe(0);
        expect(device.segmentCalls).toBe(0);
        expect(() => renderer.createTexture({} as TexImageSource, 1, 1)).toThrow(/disposed/);
    });
});
