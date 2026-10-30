/**
 * Renderer structure and layout tests.
 *
 * This does **not test pixel output** (that needs a real GPU); it tests the contracts where a mistake "silently renders wrong positions / drops sprites":
 *  1. the number of `layout(location)` entries in the shader matches `INSTANCE_ATTRIBS`
 *  2. the per-instance stride matches `InstanceBuffer`'s layout
 *  3. the attribute names declared by the shader match the names in `INSTANCE_ATTRIBS`
 *
 * On a real device such mismatches only show up as a "garbled frame" and are extremely hard to track down, so tests must lock them down.
 */

import { describe, expect, it } from "vitest";
import { FLOATS_PER_INSTANCE, INSTANCE_ATTRIBS } from "../src/InstanceBuffer";
import {
    FRAGMENT_SHADER_SOURCE,
    SHADER_ATTRIBUTE_COUNT,
    VERTEX_SHADER_SOURCE,
} from "../src/renderer/SpriteBatch";

describe("Shader and instance layout consistency", () => {
    it("the attribute count matches INSTANCE_ATTRIBS' length", () => {
        expect(SHADER_ATTRIBUTE_COUNT).toBe(INSTANCE_ATTRIBS.length);
    });

    it("the sum of attribute component counts = FLOATS_PER_INSTANCE (the stride must not be wrong)", () => {
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
        const expected = INSTANCE_ATTRIBS.map((a) => a.name);
        expect(declared).toEqual(expected);
    });

    it("the vertex shader builds the quad from gl_VertexID (no quad VBO needed)", () => {
        expect(VERTEX_SHADER_SOURCE).toContain("gl_VertexID");
        expect(VERTEX_SHADER_SOURCE).toContain("QUAD[6]");
        // Two triangles = 6 vertices
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

    it("the vertex shader outputs v_uv / v_color and the fragment shader takes varyings of the same names", () => {
        // Note: do not write `expect(A).toContain(x) || expect(B).toContain(x)` --
        // the first failing expect throws, so the right side of `||` is never evaluated.
        expect(VERTEX_SHADER_SOURCE).toMatch(/out vec2 v_uv;/);
        expect(VERTEX_SHADER_SOURCE).toMatch(/out vec4 v_color;/);
        expect(FRAGMENT_SHADER_SOURCE).toMatch(/in vec2 v_uv;/);
        expect(FRAGMENT_SHADER_SOURCE).toMatch(/in vec4 v_color;/);
    });
});

describe("Batch rendering grouping strategy", () => {
    /** Replicate SpriteBatch's batching logic (pure logic, verifiable in Node) */
    function groupBatches(textures: string[]): { texture: string; count: number }[] {
        const batches: { texture: string; count: number }[] = [];
        for (const t of textures) {
            const last = batches[batches.length - 1];
            if (last && last.texture === t) last.count++;
            else batches.push({ texture: t, count: 1 });
        }
        return batches;
    }

    it("consecutive identical textures merge into one draw call", () => {
        expect(groupBatches(["A", "A", "A"])).toEqual([{ texture: "A", count: 3 }]);
    });

    it("alternating textures degrade into multiple draw calls", () => {
        expect(groupBatches(["A", "B", "A"])).toEqual([
            { texture: "A", count: 1 },
            { texture: "B", count: 1 },
            { texture: "A", count: 1 },
        ]);
    });

    it("sorting the input by texture minimizes draw calls", () => {
        const unsorted = ["A", "B", "A", "B", "A", "B"];
        const sorted = [...unsorted].sort();
        expect(groupBatches(unsorted).length).toBe(6);
        expect(groupBatches(sorted).length).toBe(2);
    });

    it("10k sprites from the same atlas = 1 draw call (the original Cocos approach used 10k nodes)", () => {
        const textures = new Array(10000).fill("buildingAtlas");
        const batches = groupBatches(textures);
        expect(batches.length).toBe(1);
        expect(batches[0]?.count).toBe(10000);
    });
});
