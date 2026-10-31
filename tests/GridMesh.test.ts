/**
 * Grid mesh caching: the map grid is uploaded once and reused while the visible rect, zoom and
 * colour stay the same. A change in any of them must rebuild the mesh.
 */

import { describe, expect, it } from "vitest";
import { Color } from "../src/Color";
import { Camera2D } from "../src/renderer/Camera2D";
import { DEFAULT_WORLD_CONFIG, WorldRenderer } from "../src/renderer/WorldRenderer";
import type { Renderer2D } from "../src/renderer/Renderer2D";
import type { RenderMesh } from "../src/renderer/RenderDevice";

interface FakeGridRenderer {
    renderer: Renderer2D;
    camera: Camera2D;
    isLost: boolean;
    createMeshCalls: number;
    drawMeshCalls: number;
    disposeMeshCalls: number;
    lastVertices: Float32Array | null;
}

function makeRenderer(): FakeGridRenderer {
    const camera = new Camera2D();
    camera.viewportWidth = 320;
    camera.viewportHeight = 320;
    const fake: FakeGridRenderer = {
        camera,
        isLost: false,
        createMeshCalls: 0,
        drawMeshCalls: 0,
        disposeMeshCalls: 0,
        lastVertices: null,
        renderer: {} as Renderer2D,
    };
    fake.renderer = {
        get camera() {
            return camera;
        },
        get isLost() {
            return fake.isLost;
        },
        getVisibleRect: (out?: { x: number; y: number; width: number; height: number }) => camera.getVisibleRect(out),
        createMesh: (vertices: Float32Array): RenderMesh => {
            fake.createMeshCalls++;
            fake.lastVertices = vertices;
            return { kind: "webgl2", vertexCount: vertices.length / 6 };
        },
        drawMesh: (_mesh: RenderMesh) => {
            fake.drawMeshCalls++;
        },
        disposeMesh: (_mesh: RenderMesh) => {
            fake.disposeMeshCalls++;
        },
    } as unknown as Renderer2D;
    return fake;
}

function makeWorld(fake: FakeGridRenderer): WorldRenderer {
    return new WorldRenderer(fake.renderer, {
        ...DEFAULT_WORLD_CONFIG,
        gridKind: "hex",
        maxTile: 50,
        tileSize: 32,
    });
}

describe("grid mesh caching", () => {
    it("uploads once and draws every frame while the camera is still", () => {
        const fake = makeRenderer();
        const world = makeWorld(fake);
        world.drawGrid();
        world.drawGrid();
        world.drawGrid();

        expect(fake.createMeshCalls).toBe(1);
        expect(fake.drawMeshCalls).toBe(3);
        expect(fake.disposeMeshCalls).toBe(0);
        expect(world.gridCacheStats).toEqual({ hit: 2, miss: 1 });
    });

    it("bakes the grid colour and vertex count into the uploaded mesh", () => {
        const fake = makeRenderer();
        const world = makeWorld(fake);
        world.drawGrid();
        const v = fake.lastVertices as Float32Array;
        expect(v.length / 6).toBe(world.stats.gridLines * 6);
        // default theme (Blue) grid colour #4F6376
        expect(v[2]).toBeCloseTo(0x4f / 255, 5);
        expect(v[3]).toBeCloseTo(0x63 / 255, 5);
        expect(v[4]).toBeCloseTo(0x76 / 255, 5);
        expect(v[5]).toBe(1);
    });

    it("rebuilds when the zoom changes the line width", () => {
        const fake = makeRenderer();
        const world = makeWorld(fake);
        world.drawGrid();
        fake.camera.zoom = 2;
        world.drawGrid();

        expect(fake.createMeshCalls).toBe(2);
        expect(fake.disposeMeshCalls).toBe(1);
        expect(fake.drawMeshCalls).toBe(2);
    });

    it("rebuilds when the camera pans past the quantized tile step", () => {
        const fake = makeRenderer();
        const world = makeWorld(fake);
        world.drawGrid();
        fake.camera.position.set(32 * 4, 0);
        world.drawGrid();

        expect(fake.createMeshCalls).toBe(2);
        expect(fake.disposeMeshCalls).toBe(1);
    });

    it("rebuilds when the grid colour changes", () => {
        const fake = makeRenderer();
        const world = makeWorld(fake);
        world.drawGrid();
        world.updateConfig({ gridColor: new Color(10, 20, 30, 255) });
        world.drawGrid();

        expect(fake.createMeshCalls).toBe(2);
        expect(fake.disposeMeshCalls).toBe(1);
        const v = fake.lastVertices as Float32Array;
        expect(v[2]).toBeCloseTo(10 / 255, 5);
        expect(v[3]).toBeCloseTo(20 / 255, 5);
        expect(v[4]).toBeCloseTo(30 / 255, 5);
    });

    it("keeps the mesh while the grid is hidden and reuses it when shown again", () => {
        const fake = makeRenderer();
        const world = makeWorld(fake);
        world.drawGrid();
        world.updateConfig({ showGrid: false });
        world.drawGrid();
        expect(fake.drawMeshCalls).toBe(1);
        expect(fake.disposeMeshCalls).toBe(0);

        world.updateConfig({ showGrid: true });
        world.drawGrid();
        expect(fake.createMeshCalls).toBe(1);
        expect(fake.drawMeshCalls).toBe(2);
    });

    it("does nothing while the renderer is lost", () => {
        const fake = makeRenderer();
        const world = makeWorld(fake);
        fake.isLost = true;
        world.drawGrid();
        expect(fake.createMeshCalls).toBe(0);
        expect(fake.drawMeshCalls).toBe(0);

        fake.isLost = false;
        world.drawGrid();
        expect(fake.createMeshCalls).toBe(1);
        expect(fake.drawMeshCalls).toBe(1);
    });

    it("releases the mesh on dispose", () => {
        const fake = makeRenderer();
        const world = makeWorld(fake);
        world.drawGrid();
        world.dispose();
        expect(fake.disposeMeshCalls).toBe(1);
        expect(fake.createMeshCalls).toBe(1);
    });
});
