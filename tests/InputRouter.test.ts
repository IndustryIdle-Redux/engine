/**
 * InputRouter tests with a fake canvas and window (the vitest environment is node,
 * so there is no DOM). The camera is a real Camera2D.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Camera2D } from "../src/renderer/Camera2D";
import { InputRouter } from "../src/renderer/InputRouter";
import type { PointerEventData } from "../src/renderer/InputRouter";

type Listener = (...args: any[]) => void;

function makeCanvas() {
    const listeners = new Map<string, Set<Listener>>();
    const captured = new Set<number>();
    const released: number[] = [];
    const style = { touchAction: "pan-y" };
    const canvas = {
        style,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        addEventListener(type: string, listener: Listener): void {
            let set = listeners.get(type);
            if (!set) {
                set = new Set();
                listeners.set(type, set);
            }
            set.add(listener);
        },
        removeEventListener(type: string, listener: Listener): void {
            listeners.get(type)?.delete(listener);
        },
        setPointerCapture(pointerId: number): void {
            captured.add(pointerId);
        },
        releasePointerCapture(pointerId: number): void {
            captured.delete(pointerId);
            released.push(pointerId);
        },
        hasPointerCapture(pointerId: number): boolean {
            return captured.has(pointerId);
        },
        dispatch(type: string, event: unknown): void {
            for (const listener of listeners.get(type) ?? []) listener(event);
        },
    };
    return {
        canvas: canvas as unknown as HTMLCanvasElement & {
            dispatch(type: string, event: unknown): void;
        },
        captured,
        released,
        style,
        listeners,
    };
}

function makeWindow() {
    const listeners = new Map<string, Set<Listener>>();
    const win = {
        addEventListener(type: string, listener: Listener): void {
            let set = listeners.get(type);
            if (!set) {
                set = new Set();
                listeners.set(type, set);
            }
            set.add(listener);
        },
        removeEventListener(type: string, listener: Listener): void {
            listeners.get(type)?.delete(listener);
        },
        dispatch(type: string, event: unknown): void {
            for (const listener of listeners.get(type) ?? []) listener(event);
        },
    };
    return { win, listeners };
}

function setup() {
    const fakeWindow = makeWindow();
    vi.stubGlobal("window", fakeWindow.win);
    const fakeCanvas = makeCanvas();
    const camera = new Camera2D();
    camera.viewportWidth = 800;
    camera.viewportHeight = 600;
    const input = new InputRouter(fakeCanvas.canvas, camera);
    return { ...fakeCanvas, camera, input, win: fakeWindow.win, keyListeners: fakeWindow.listeners };
}

function pointerEvent(init: {
    pointerId?: number;
    clientX?: number;
    clientY?: number;
    button?: number;
}): PointerEvent {
    return {
        pointerId: init.pointerId ?? 1,
        clientX: init.clientX ?? 0,
        clientY: init.clientY ?? 0,
        button: init.button ?? 0,
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
    } as unknown as PointerEvent;
}

function keyEvent(target: unknown): KeyboardEvent {
    return { target } as unknown as KeyboardEvent;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("InputRouter pointer capture", () => {
    it("captures on pointerdown and releases on pointerup", () => {
        const { canvas, captured, released, input } = setup();

        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 7, clientX: 100, clientY: 100 }));
        expect(captured.has(7)).toBe(true);
        expect(input.isPointerDown()).toBe(true);

        canvas.dispatch("pointerup", pointerEvent({ pointerId: 7, clientX: 100, clientY: 100 }));
        expect(captured.has(7)).toBe(false);
        expect(released).toContain(7);
        expect(input.isPointerDown()).toBe(false);
    });

    it("drops a pointer when capture is lost without a pointerup", () => {
        const { canvas, input } = setup();
        const ups: PointerEventData[] = [];
        input.onPointerUp((e) => ups.push(e));

        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 3, clientX: 20, clientY: 20 }));
        expect(input.isPointerDown()).toBe(true);

        canvas.dispatch("lostpointercapture", pointerEvent({ pointerId: 3 }));
        expect(input.isPointerDown()).toBe(false);
        expect(input.activePointerCount).toBe(0);
        expect(ups.length).toBe(1);
        expect(ups[0]?.phase).toBe("cancel");
        expect(ups[0]?.activePointers).toBe(0);
    });

    it("drops a pointer on pointercancel", () => {
        const { canvas, input } = setup();
        const ups: PointerEventData[] = [];
        input.onPointerUp((e) => ups.push(e));

        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 4 }));
        canvas.dispatch("pointercancel", pointerEvent({ pointerId: 4 }));

        expect(input.isPointerDown()).toBe(false);
        expect(ups[0]?.phase).toBe("cancel");
    });
});

describe("InputRouter pointer deltas", () => {
    it("starts every pointer with a zero delta", () => {
        const { canvas, input } = setup();
        const downs: PointerEventData[] = [];
        input.onPointerDown((e) => downs.push(e));

        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 1, clientX: 10, clientY: 10 }));
        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 2, clientX: 50, clientY: 10 }));

        expect(downs[0]?.deltaScreen.x).toBe(0);
        expect(downs[0]?.deltaScreen.y).toBe(0);
        expect(downs[1]?.deltaScreen.x).toBe(0);
        expect(downs[1]?.deltaScreen.y).toBe(0);
        expect(downs[1]?.startDeltaScreen?.x).toBe(0);
    });

    it("computes each pointer's delta from its own previous position", () => {
        const { canvas, input } = setup();
        const moves: PointerEventData[] = [];
        input.onPointerMove((e) => moves.push(e));

        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 1, clientX: 10, clientY: 10 }));
        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 2, clientX: 50, clientY: 10 }));

        // second finger moves: it must not borrow the first finger's position
        canvas.dispatch("pointermove", pointerEvent({ pointerId: 2, clientX: 60, clientY: 30 }));
        expect(moves[0]?.deltaScreen.x).toBe(10);
        expect(moves[0]?.deltaScreen.y).toBe(20);
        expect(moves[0]?.activePointers).toBe(2);

        // first finger moves afterwards
        canvas.dispatch("pointermove", pointerEvent({ pointerId: 1, clientX: 15, clientY: 12 }));
        expect(moves[1]?.deltaScreen.x).toBe(5);
        expect(moves[1]?.deltaScreen.y).toBe(2);
        // accumulated since pointerdown, not since the last move
        expect(moves[1]?.startDeltaScreen?.x).toBe(5);
        expect(moves[1]?.startDeltaScreen?.y).toBe(2);
    });

    it("keeps startDeltaScreen accumulated since pointerdown on pointerup", () => {
        const { canvas, input } = setup();
        const ups: PointerEventData[] = [];
        input.onPointerUp((e) => ups.push(e));

        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 1, clientX: 10, clientY: 10 }));
        canvas.dispatch("pointermove", pointerEvent({ pointerId: 1, clientX: 20, clientY: 15 }));
        canvas.dispatch("pointerup", pointerEvent({ pointerId: 1, clientX: 30, clientY: 20 }));

        expect(ups[0]?.deltaScreen.x).toBe(10);
        expect(ups[0]?.deltaScreen.y).toBe(5);
        expect(ups[0]?.startDeltaScreen?.x).toBe(20);
        expect(ups[0]?.startDeltaScreen?.y).toBe(10);
    });

    it("reports zero delta for a move of an untracked pointer", () => {
        const { canvas, input } = setup();
        const moves: PointerEventData[] = [];
        input.onPointerMove((e) => moves.push(e));

        canvas.dispatch("pointermove", pointerEvent({ pointerId: 9, clientX: 40, clientY: 40 }));
        expect(moves[0]?.deltaScreen.x).toBe(0);
        expect(moves[0]?.deltaScreen.y).toBe(0);
        expect(moves[0]?.startDeltaScreen).toBeNull();
    });
});

describe("InputRouter phases", () => {
    it("marks down, move, up and cancel events", () => {
        const { canvas, input } = setup();
        const phases: string[] = [];
        input.onPointerDown((e) => phases.push(e.phase));
        input.onPointerMove((e) => phases.push(e.phase));
        input.onPointerUp((e) => phases.push(e.phase));

        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 1 }));
        canvas.dispatch("pointermove", pointerEvent({ pointerId: 1, clientX: 1 }));
        canvas.dispatch("pointerup", pointerEvent({ pointerId: 1 }));
        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 2 }));
        canvas.dispatch("pointercancel", pointerEvent({ pointerId: 2 }));

        expect(phases).toEqual(["down", "move", "up", "down", "cancel"]);
    });
});

describe("InputRouter keyboard target filtering", () => {
    it("ignores key events from text fields but not from the canvas", () => {
        const { win, input } = setup();
        const keys: string[] = [];
        input.onKeyDown(() => keys.push("down"));
        input.onKeyUp(() => keys.push("up"));

        win.dispatch("keydown", keyEvent({ tagName: "INPUT" }));
        win.dispatch("keydown", keyEvent({ tagName: "TEXTAREA" }));
        win.dispatch("keydown", keyEvent({ tagName: "SELECT" }));
        win.dispatch("keydown", keyEvent({ tagName: "DIV", isContentEditable: true }));
        expect(keys).toEqual([]);

        win.dispatch("keydown", keyEvent({ tagName: "CANVAS" }));
        expect(keys).toEqual(["down"]);

        win.dispatch("keyup", keyEvent({ tagName: "INPUT" }));
        win.dispatch("keyup", keyEvent({ tagName: "CANVAS" }));
        expect(keys).toEqual(["down", "up"]);
    });

    it("does not prevent default when a filtered key event arrives", () => {
        const { win, input } = setup();
        const preventDefault = vi.fn();
        input.onKeyDown(() => undefined);
        win.dispatch("keydown", { target: { tagName: "INPUT" }, preventDefault });
        expect(preventDefault).not.toHaveBeenCalled();
    });
});

describe("InputRouter unsubscribe", () => {
    it("registration returns a function that removes the handler", () => {
        const { canvas, win, input } = setup();
        const onDown = vi.fn();
        const onKeyDown = vi.fn();
        const offDown = input.onPointerDown(onDown);
        const offKeyDown = input.onKeyDown(onKeyDown);

        offDown();
        offKeyDown();

        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 1 }));
        win.dispatch("keydown", keyEvent({ tagName: "CANVAS" }));
        expect(onDown).not.toHaveBeenCalled();
        expect(onKeyDown).not.toHaveBeenCalled();
    });

    it("keeps the other handlers when only one is unsubscribed", () => {
        const { canvas, input } = setup();
        const first = vi.fn();
        const second = vi.fn();
        const offFirst = input.onPointerDown(first);
        input.onPointerDown(second);

        offFirst();
        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 1 }));

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });
});

describe("InputRouter dispose", () => {
    it("restores the original touchAction and removes every listener", () => {
        const { canvas, style, listeners, keyListeners, input } = setup();
        // a pointer is down when dispose happens
        canvas.dispatch("pointerdown", pointerEvent({ pointerId: 1 }));

        input.dispose();

        expect(style.touchAction).toBe("pan-y");
        expect(listeners.get("pointerdown")?.size ?? 0).toBe(0);
        expect(listeners.get("pointerup")?.size ?? 0).toBe(0);
        expect(listeners.get("lostpointercapture")?.size ?? 0).toBe(0);
        expect(keyListeners.get("keydown")?.size ?? 0).toBe(0);
        expect(keyListeners.get("keyup")?.size ?? 0).toBe(0);
        expect(input.isPointerDown()).toBe(false);
    });
});
