/**
 * Instance layout and batch offset tests.
 *
 * Instance attributes are fetched by `gl_InstanceID`, which restarts at 0 for every draw, so
 * `flush()` must rebind the attribute pointers to `batch.start * stride`. If it does not, the
 * second texture's batch draws the first batch's instances (atlas content where text should be).
 *
 * Covered here: the `INSTANCE_ATTRIBS` offsets/total and the `start`/`count` recorded by batch
 * splitting.
 */

import { describe, expect, it } from "vitest";
import { INSTANCE_ATTRIBS, FLOATS_PER_INSTANCE } from "../src/InstanceBuffer";
import { BatchList, VERTEX_SHADER_SOURCE } from "../src/renderer/SpriteBatch";

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
        const locations = VERTEX_SHADER_SOURCE.match(/layout\(location = \d+\)/g) ?? [];
        expect(INSTANCE_ATTRIBS.length).toBe(locations.length);
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

    it("start strictly increases and covers exactly all instances", () => {
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

    it("with multiple textures the 2nd batch's start must be > 0", () => {
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
