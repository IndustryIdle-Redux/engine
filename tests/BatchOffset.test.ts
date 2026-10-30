/**
 * Batch offset regression test.
 *
 * Background (a pit we really fell into): in `SpriteBatch.flush()`
 *   `gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count)`
 * ignores `batch.start`. Instance attributes are fetched via `gl_InstanceID`, and
 * `gl_InstanceID` **restarts at 0 for every draw call** --
 * so the second texture's batch reads instance data from the start of the buffer.
 *
 * Symptom: with a single texture the frame looks perfectly fine; as soon as atlas and font are mixed,
 * **the font batch draws the atlas sprites' content** (showing up as vertical bars where the text should be).
 *
 * This locks down two things:
 *  1. `INSTANCE_ATTRIBS` offsets accumulate, and their total equals `FLOATS_PER_INSTANCE`
 *  2. the `start`/`count` recorded by batch splitting is correct (this is the only basis for rebinding pointers)
 */

import { describe, expect, it } from "vitest";
import { INSTANCE_ATTRIBS, FLOATS_PER_INSTANCE } from "../src/InstanceBuffer";
import { BatchList, SHADER_ATTRIBUTE_COUNT } from "../src/renderer/SpriteBatch";

describe("INSTANCE_ATTRIBS layout", () => {
    it("offsets accumulate item by item with no holes", () => {
        let expected = 0;
        for (const a of INSTANCE_ATTRIBS) {
            expect(a.offset, `offset of ${a.name}`).toBe(expected);
            expected += a.size;
        }
        expect(expected).toBe(FLOATS_PER_INSTANCE);
    });

    it("the attribute count matches the shader layout count", () => {
        expect(INSTANCE_ATTRIBS.length).toBe(SHADER_ATTRIBUTE_COUNT);
    });

    it("the last item is a 4-component color", () => {
        const last = INSTANCE_ATTRIBS[INSTANCE_ATTRIBS.length - 1];
        expect(last?.name).toBe("a_color");
        expect(last?.size).toBe(4);
    });
});

describe("Batch splitting (flush relies on start/count to rebind attribute pointers)", () => {
    const texA = { handle: "A" } as never;
    const texB = { handle: "B" } as never;

    it("the same texture merges into one batch, a different texture starts a new one", () => {
        const list = new BatchList();
        // A A A B B A
        let start = 0;
        for (const t of [texA, texA, texA, texB, texB, texA]) {
            list.add(t, start);
            start += 1;
        }
        expect(list.length).toBe(3);
        expect(list.items[0]).toMatchObject({ texture: texA, start: 0, count: 3 });
        expect(list.items[1]).toMatchObject({ texture: texB, start: 3, count: 2 });
        expect(list.items[2]).toMatchObject({ texture: texA, start: 5, count: 1 });
    });

    it("start strictly increases and covers exactly all instances (flush uses it to compute the pointer offset)", () => {
        const list = new BatchList();
        let n = 0;
        for (let i = 0; i < 50; i++) {
            list.add(i % 3 === 0 ? texA : texB, n);
            n += 1;
        }
        let cursor = 0;
        for (const b of list.items) {
            expect(b.start).toBe(cursor);
            cursor += b.count;
        }
        expect(cursor).toBe(50);
    });

    it("with a single texture there is only one batch, starting at 0", () => {
        const list = new BatchList();
        for (let i = 0; i < 10; i++) list.add(texA, i);
        expect(list.length).toBe(1);
        expect(list.items[0]).toMatchObject({ start: 0, count: 10 });
    });

    it("regression: with multiple textures the 2nd batch's start must be > 0", () => {
        // This was exactly the bug: flush ignored start, so the second batch re-read instance 0,
        // showing up as "vertical bars of atlas content where the font should be".
        const list = new BatchList();
        list.add(texA, 0);
        list.add(texB, 1);
        expect(list.items[1]?.start).toBe(1);
        expect(list.items[1]?.start).toBeGreaterThan(0);
    });

    it("reset clears the batches (no start/count left over from the previous frame)", () => {
        const list = new BatchList();
        list.add(texA, 0);
        list.reset();
        expect(list.length).toBe(0);
    });
});
