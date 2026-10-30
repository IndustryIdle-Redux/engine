/**
 * Input routing: native pointer, wheel and keyboard events on the render canvas.
 * Screen positions are converted to world coordinates through the camera, so callers
 * never have to do that conversion themselves.
 */

import { Vec2 } from "../Vec2";
import type { Camera2D } from "./Camera2D";

export type PointerPhase = "down" | "move" | "up" | "cancel";

export interface PointerEventData {
    /** World coordinates (converted by the camera) */
    world: Vec2;
    /** CSS pixels inside the canvas */
    screen: Vec2;
    /** Displacement since this pointer's previous event (world units) */
    deltaWorld: Vec2;
    /** Displacement since this pointer's previous event (screen pixels) */
    deltaScreen: Vec2;
    /** Displacement since this pointer went down (screen pixels); null if the pointer was not tracked. */
    startDeltaScreen: Vec2 | null;
    /** Event kind; `cancel` is also delivered to the pointer-up handlers. */
    phase: PointerPhase;
    button: number;
    pointerId: number;
    /** Number of pointers still down after this event. */
    activePointers: number;
    altKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    /** Raw event (used when preventDefault is needed) */
    raw: PointerEvent;
}

export interface WheelEventData {
    /** Normalized scroll amount (positive means zoom in) */
    delta: number;
    /** World coordinates (wheel position) */
    world: Vec2;
    screen: Vec2;
    raw: WheelEvent;
}

export type PointerHandler = (e: PointerEventData) => void;
export type WheelHandler = (e: WheelEventData) => void;
export type KeyHandler = (e: KeyboardEvent) => void;

interface PointerState {
    id: number;
    /** Position of this pointer's last event */
    screen: Vec2;
    world: Vec2;
    /** Position where this pointer went down (used for tap-vs-drag) */
    downScreen: Vec2;
}

/** True when a key event comes from a text field, so game shortcuts should not fire. */
function isEditableTarget(target: EventTarget | null): boolean {
    if (!target || typeof target !== "object") return false;
    const el = target as HTMLElement;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (typeof tag !== "string") return false;
    switch (tag.toUpperCase()) {
        case "INPUT":
        case "TEXTAREA":
        case "SELECT":
            return true;
        default:
            return false;
    }
}

/**
 * Input router attached to the render canvas; `dispose()` removes every listener.
 */
export class InputRouter {
    private readonly canvas: HTMLCanvasElement;
    private readonly camera: Camera2D;
    private readonly originalTouchAction: string;

    private readonly downHandlers: PointerHandler[] = [];
    private readonly moveHandlers: PointerHandler[] = [];
    private readonly upHandlers: PointerHandler[] = [];
    private readonly wheelHandlers: WheelHandler[] = [];
    private readonly keyDownHandlers: KeyHandler[] = [];
    private readonly keyUpHandlers: KeyHandler[] = [];

    /** Pointers currently down (multi-touch supported) */
    private readonly pointers = new Map<number, PointerState>();

    /** Finger distance of the previous pinch (0 means not pinching) */
    private lastPinchDistance = 0;

    /** Pinch-zoom callback handed to the business layer (world-space scale factor) */
    public onPinchZoom: ((scaleFactor: number, center: Vec2) => void) | null = null;

    private disposed = false;

    constructor(canvas: HTMLCanvasElement, camera: Camera2D) {
        this.canvas = canvas;
        this.camera = camera;
        this.originalTouchAction = canvas.style.touchAction;

        canvas.addEventListener("pointerdown", this.handlePointerDown);
        canvas.addEventListener("pointermove", this.handlePointerMove);
        canvas.addEventListener("pointerup", this.handlePointerUp);
        canvas.addEventListener("pointercancel", this.handlePointerCancel);
        canvas.addEventListener("lostpointercapture", this.handleLostPointerCapture);
        canvas.addEventListener("wheel", this.handleWheel, { passive: false });
        window.addEventListener("keydown", this.handleKeyDown);
        window.addEventListener("keyup", this.handleKeyUp);
        // keep the page from scrolling/zooming while dragging on a touch screen
        canvas.style.touchAction = "none";
    }

    /* ---------------- registration ---------------- */

    private register<T>(handlers: T[], handler: T): () => void {
        handlers.push(handler);
        return () => {
            const index = handlers.indexOf(handler);
            if (index >= 0) handlers.splice(index, 1);
        };
    }

    public onPointerDown(h: PointerHandler): () => void {
        return this.register(this.downHandlers, h);
    }
    public onPointerMove(h: PointerHandler): () => void {
        return this.register(this.moveHandlers, h);
    }
    public onPointerUp(h: PointerHandler): () => void {
        return this.register(this.upHandlers, h);
    }
    public onWheel(h: WheelHandler): () => void {
        return this.register(this.wheelHandlers, h);
    }
    public onKeyDown(h: KeyHandler): () => void {
        return this.register(this.keyDownHandlers, h);
    }
    public onKeyUp(h: KeyHandler): () => void {
        return this.register(this.keyUpHandlers, h);
    }

    /* ---------------- state queries ---------------- */

    public get activePointerCount(): number {
        return this.pointers.size;
    }

    public isPointerDown(): boolean {
        return this.pointers.size > 0;
    }

    /** Midpoint of all current pointers in world coordinates (for pinch/pan) */
    public getPointersCenter(out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        if (this.pointers.size === 0) return r.set(this.camera.position.x, this.camera.position.y);
        let x = 0;
        let y = 0;
        for (const p of this.pointers.values()) {
            x += p.world.x;
            y += p.world.y;
        }
        return r.set(x / this.pointers.size, y / this.pointers.size);
    }

    /* ---------------- event handling ---------------- */

    private toScreen(e: PointerEvent): Vec2 {
        const rect = this.canvas.getBoundingClientRect();
        return new Vec2(e.clientX - rect.left, e.clientY - rect.top);
    }

    private buildPointerData(e: PointerEvent, phase: PointerPhase): PointerEventData {
        const screen = this.toScreen(e);
        const world = this.camera.screenToWorld(screen.x, screen.y);
        const state = this.pointers.get(e.pointerId);

        // Each pointer measures its delta from its own previous position, so a second finger
        // never borrows the first finger's position. The first event of a pointer has no delta.
        const deltaScreen = state ? screen.clone().sub(state.screen) : new Vec2();
        // Derive the world delta from the screen delta and the current zoom. Subtracting two
        // screenToWorld results would fold the camera's own motion into the delta and cause
        // jitter. Screen y is down while world y is up, hence the negation.
        const zoom = this.camera.zoom || 1;
        const deltaWorld = new Vec2(deltaScreen.x / zoom, -deltaScreen.y / zoom);

        const startDeltaScreen = state ? screen.clone().sub(state.downScreen) : null;

        return {
            world,
            screen,
            deltaWorld,
            deltaScreen,
            startDeltaScreen,
            phase,
            button: e.button,
            pointerId: e.pointerId,
            activePointers: this.pointers.size,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            raw: e,
        };
    }

    private handlePointerDown = (e: PointerEvent): void => {
        const screen = this.toScreen(e);
        this.pointers.set(e.pointerId, {
            id: e.pointerId,
            screen,
            world: this.camera.screenToWorld(screen.x, screen.y),
            downScreen: screen.clone(),
        });

        if (this.pointers.size === 2) this.lastPinchDistance = this.pinchDistance();

        // keep receiving move/up events even when the pointer leaves the canvas
        if (typeof this.canvas.setPointerCapture === "function") {
            this.canvas.setPointerCapture(e.pointerId);
        }

        const data = this.buildPointerData(e, "down");
        for (const h of this.downHandlers) h(data);
    };

    private handlePointerMove = (e: PointerEvent): void => {
        // build first: the delta uses the position stored by the previous event
        const data = this.buildPointerData(e, "move");

        const state = this.pointers.get(e.pointerId);
        if (state) {
            state.screen.copy(data.screen);
            state.world.copy(data.world);
        }

        // two-finger pinch to zoom
        if (this.pointers.size === 2 && this.lastPinchDistance > 0) {
            const distance = this.pinchDistance();
            const factor = distance / this.lastPinchDistance;
            this.lastPinchDistance = distance;
            if (Math.abs(factor - 1) > 1e-4) {
                this.onPinchZoom?.(factor, this.getPointersCenter());
            }
        }

        for (const h of this.moveHandlers) h(data);
    };

    private handlePointerUp = (e: PointerEvent): void => {
        const data = this.buildPointerData(e, "up");
        this.removePointer(e.pointerId);
        this.releasePointerCapture(e.pointerId);
        data.activePointers = this.pointers.size;
        for (const h of this.upHandlers) h(data);
    };

    private handlePointerCancel = (e: PointerEvent): void => {
        const data = this.buildPointerData(e, "cancel");
        this.removePointer(e.pointerId);
        this.releasePointerCapture(e.pointerId);
        data.activePointers = this.pointers.size;
        for (const h of this.upHandlers) h(data);
    };

    private handleLostPointerCapture = (e: PointerEvent): void => {
        const state = this.pointers.get(e.pointerId);
        // the usual case: pointerup already removed the pointer and released the capture
        if (!state) return;

        // Capture can be lost without a pointerup (for example when the pointer leaves the
        // window). Report a cancel so no consumer is left thinking the pointer is still down.
        const data: PointerEventData = {
            world: state.world.clone(),
            screen: state.screen.clone(),
            deltaWorld: new Vec2(),
            deltaScreen: new Vec2(),
            startDeltaScreen: state.screen.clone().sub(state.downScreen),
            phase: "cancel",
            button: e.button,
            pointerId: e.pointerId,
            activePointers: this.pointers.size - 1,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            raw: e,
        };
        this.removePointer(e.pointerId);
        for (const h of this.upHandlers) h(data);
    };

    private removePointer(pointerId: number): void {
        this.pointers.delete(pointerId);
        if (this.pointers.size < 2) this.lastPinchDistance = 0;
    }

    private releasePointerCapture(pointerId: number): void {
        const canvas = this.canvas;
        if (typeof canvas.releasePointerCapture !== "function") return;
        if (typeof canvas.hasPointerCapture === "function" && !canvas.hasPointerCapture(pointerId)) return;
        canvas.releasePointerCapture(pointerId);
    }

    private pinchDistance(): number {
        const pts = [...this.pointers.values()];
        if (pts.length < 2) return 0;
        const a = pts[0] as PointerState;
        const b = pts[1] as PointerState;
        return Math.hypot(b.screen.x - a.screen.x, b.screen.y - a.screen.y);
    }

    private handleWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const screen = new Vec2(e.clientX - rect.left, e.clientY - rect.top);
        const world = this.camera.screenToWorld(screen.x, screen.y);
        // Prefer the legacy `wheelDelta` (wheel notches) over `deltaY` (pixels): touchpads
        // emit many small deltaY values, which would make zooming much slower. Firefox
        // reports `-120 * detail`; the last fallback converts deltaY at 120 units per notch.
        const legacy = e as WheelEvent & { wheelDelta?: number; detail?: number };
        const delta =
            typeof legacy.wheelDelta === "number"
                ? legacy.wheelDelta
                : typeof legacy.detail === "number" && legacy.detail !== 0
                  ? -120 * legacy.detail
                  : (-e.deltaY * 120) / 100;
        for (const h of this.wheelHandlers) h({ delta, world, screen, raw: e });
    };

    private handleKeyDown = (e: KeyboardEvent): void => {
        if (isEditableTarget(e.target)) return;
        for (const h of this.keyDownHandlers) h(e);
    };

    private handleKeyUp = (e: KeyboardEvent): void => {
        if (isEditableTarget(e.target)) return;
        for (const h of this.keyUpHandlers) h(e);
    };

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const c = this.canvas;
        c.removeEventListener("pointerdown", this.handlePointerDown);
        c.removeEventListener("pointermove", this.handlePointerMove);
        c.removeEventListener("pointerup", this.handlePointerUp);
        c.removeEventListener("pointercancel", this.handlePointerCancel);
        c.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
        c.removeEventListener("wheel", this.handleWheel);
        window.removeEventListener("keydown", this.handleKeyDown);
        window.removeEventListener("keyup", this.handleKeyUp);
        c.style.touchAction = this.originalTouchAction;
        this.pointers.clear();
        this.downHandlers.length = 0;
        this.moveHandlers.length = 0;
        this.upHandlers.length = 0;
        this.wheelHandlers.length = 0;
        this.keyDownHandlers.length = 0;
        this.keyUpHandlers.length = 0;
    }
}
