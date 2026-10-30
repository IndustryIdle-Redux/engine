/**
 * Input routing -- replaces Cocos' `cc.Event.EventTouch` / `EventMouse` / `Node.EventType` system.
 *
 * The original implementation hung listeners on `cc.game.canvas` (and forwarded events back and forth
 * between the UI's DOM layer and the canvas, see `canvas.dispatchEvent` in `UISystem.ts`). Here they are
 * managed uniformly on the renderer's canvas, and **screen coordinates are converted to world coordinates**
 * (via `Camera2D.screenToWorldMatrix`), so the business layer no longer needs to call `cc.Camera.getScreenToWorldPoint` itself.
 *
 * Design trade-offs:
 *  - use **native DOM events** instead of custom event objects: one less layer of allocation, and easier to cooperate with DOM UI
 *  - callbacks are stored grouped by type and the array is walked on dispatch (there are very few listeners)
 *  - `pointerId` tracking is used for pinch zoom (two fingers)
 */

import { Vec2 } from "../Vec2";
import type { Camera2D } from "./Camera2D";

export type PointerPhase = "down" | "move" | "up" | "cancel";

export interface PointerEventData {
    /** World coordinates (already converted by the camera) */
    world: Vec2;
    /** CSS pixel coordinates inside the canvas */
    screen: Vec2;
    /** Displacement relative to the previous event (world coordinates) */
    deltaWorld: Vec2;
    /** Displacement relative to the previous event (screen pixels) */
    deltaScreen: Vec2;
    /**
     * Displacement of this pointer relative to **where it went down** (screen pixels);
     * `null` when the gesture did not start on the canvas (e.g. `pointerup` after a press on a DOM overlay).
     *
     * ⚠️ Use this — **not `deltaScreen`** — to tell a tap from a drag on `pointerup`:
     * `deltaScreen` is only the step since the *previous* event, so a drag that pauses
     * before releasing (or whose final `pointermove` is coalesced into `pointerup`)
     * has `deltaScreen ≈ 0` and is misread as a tap.
     */
    startDeltaScreen: Vec2 | null;
    button: number;
    pointerId: number;
    /** Number of pointers currently down (used to detect a pinch) */
    activePointers: number;
    /** Whether the UI layer consumed it (not dispatched when the DOM event target is not the canvas) */
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
    screen: Vec2;
    world: Vec2;
    /** position where this pointer went down (kept untouched by moves; used for tap-vs-drag) */
    downScreen: Vec2;
}

/**
 * Input router.
 *
 * Attached to the render canvas; `dispose()` removes every listener.
 */
export class InputRouter {
    private readonly canvas: HTMLCanvasElement;
    private readonly camera: Camera2D;

    private readonly downHandlers: PointerHandler[] = [];
    private readonly moveHandlers: PointerHandler[] = [];
    private readonly upHandlers: PointerHandler[] = [];
    private readonly wheelHandlers: WheelHandler[] = [];
    private readonly keyDownHandlers: KeyHandler[] = [];
    private readonly keyUpHandlers: KeyHandler[] = [];

    /** Pointers currently down (multi-touch supported) */
    private readonly pointers = new Map<number, PointerState>();
    /** Previous "primary pointer" position, used to compute deltas */
    private lastPrimaryScreen = new Vec2();
    private hasPrimary = false;

    /** Finger distance of the previous pinch (0 means not pinching) */
    private lastPinchDistance = 0;

    /** Pinch-zoom callback handed to the business layer (world-space scale factor) */
    public onPinchZoom: ((scaleFactor: number, center: Vec2) => void) | null = null;

    private disposed = false;

    constructor(canvas: HTMLCanvasElement, camera: Camera2D) {
        this.canvas = canvas;
        this.camera = camera;

        canvas.addEventListener("pointerdown", this.handlePointerDown);
        canvas.addEventListener("pointermove", this.handlePointerMove);
        canvas.addEventListener("pointerup", this.handlePointerUp);
        canvas.addEventListener("pointercancel", this.handlePointerCancel);
        canvas.addEventListener("wheel", this.handleWheel, { passive: false });
        window.addEventListener("keydown", this.handleKeyDown);
        window.addEventListener("keyup", this.handleKeyUp);
        // prevent page scrolling/zooming while dragging on a touch screen
        canvas.style.touchAction = "none";
    }

    /* ---------------- registration ---------------- */

    public onPointerDown(h: PointerHandler): void {
        this.downHandlers.push(h);
    }
    public onPointerMove(h: PointerHandler): void {
        this.moveHandlers.push(h);
    }
    public onPointerUp(h: PointerHandler): void {
        this.upHandlers.push(h);
    }
    public onWheel(h: WheelHandler): void {
        this.wheelHandlers.push(h);
    }
    public onKeyDown(h: KeyHandler): void {
        this.keyDownHandlers.push(h);
    }
    public onKeyUp(h: KeyHandler): void {
        this.keyUpHandlers.push(h);
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

    private buildPointerData(e: PointerEvent): PointerEventData {
        const screen = this.toScreen(e);
        const world = this.camera.screenToWorld(screen.x, screen.y);

        const deltaScreen = this.hasPrimary ? screen.clone().sub(this.lastPrimaryScreen) : new Vec2();
        // ⚠️ the world delta must be **derived directly from the screen delta and the current zoom**, not from
        // the difference "this screenToWorld − the previous screenToWorld":
        // the camera moves while dragging, so the world coordinates computed last time came from the **old camera**,
        // which mixes the camera's own displacement into the delta → positive feedback → the view jitters.
        // The original does exactly this: `cameraPosition.sub(cc.v3(e.getDelta()).divSelf(this.cameraZoom))`.
        // `screenToWorld` has a flipped y axis (screen y down, world y up), hence y is negated.
        const zoom = this.camera.zoom || 1;
        const deltaWorld = this.hasPrimary
            ? new Vec2(deltaScreen.x / zoom, -deltaScreen.y / zoom)
            : new Vec2();

        this.lastPrimaryScreen.copy(screen);
        this.hasPrimary = true;

        // total displacement since this pointer went down (see the `startDeltaScreen` doc)
        const state = this.pointers.get(e.pointerId);
        const startDeltaScreen = state ? screen.clone().sub(state.downScreen) : null;

        return {
            world,
            screen,
            deltaWorld,
            deltaScreen,
            startDeltaScreen,
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
        const world = this.camera.screenToWorld(screen.x, screen.y);
        this.pointers.set(e.pointerId, { id: e.pointerId, screen, world, downScreen: screen.clone() });

        if (this.pointers.size === 2) {
            // starting a pinch: record the initial distance
            this.lastPinchDistance = this.pinchDistance();
        }
        const data = this.buildPointerData(e);
        for (const h of this.downHandlers) h(data);
    };

    private handlePointerMove = (e: PointerEvent): void => {
        const screen = this.toScreen(e);
        const world = this.camera.screenToWorld(screen.x, screen.y);
        const state = this.pointers.get(e.pointerId);
        if (state) {
            state.screen.copy(screen);
            state.world.copy(world);
        }

        // two-finger pinch → zoom
        if (this.pointers.size === 2 && this.lastPinchDistance > 0) {
            const d = this.pinchDistance();
            const factor = d / this.lastPinchDistance;
            this.lastPinchDistance = d;
            if (Math.abs(factor - 1) > 1e-4) {
                this.onPinchZoom?.(factor, this.getPointersCenter());
            }
        }

        const data = this.buildPointerData(e);
        for (const h of this.moveHandlers) h(data);
    };

    private handlePointerUp = (e: PointerEvent): void => {
        const data = this.buildPointerData(e);
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.lastPinchDistance = 0;
        data.activePointers = this.pointers.size;
        for (const h of this.upHandlers) h(data);
    };

    private handlePointerCancel = (e: PointerEvent): void => {
        const data = this.buildPointerData(e);
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.lastPinchDistance = 0;
        data.activePointers = this.pointers.size;
        for (const h of this.upHandlers) h(data);
    };

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
        /**
         * Wheel delta -- **must use the legacy `wheelDelta`, not just `deltaY`**.
         *
         * Cocos listens to the `mousewheel` event and takes `event.wheelDelta` directly
         * (`mouseEvent.setScrollData(0, event.wheelDelta)` in `cocos2d-js.js`,
         *  with Firefox falling back to `-120 * event.detail`).
         *
         * The two have **different dimensions**: `wheelDelta` is given in "wheel notches" (measured constant at ±120 in Chrome),
         * while `deltaY` is pixels/lines. Measured on the same event:
         * | deltaY | wheelDelta | deltaY would be slower by |
         * |---|---|---|
         * | −100 | 120 | 1.2× |
         * | −53 | 120 | 2.26× |
         * | −1 | 120 | 120× |
         * A touchpad produces small, high-frequency deltas, so using `deltaY` makes zooming hundreds of times slower.
         * Since the goal is "match the original", take `wheelDelta` just like the original does.
         */
        const legacy = e as WheelEvent & { wheelDelta?: number; detail?: number };
        const delta =
            typeof legacy.wheelDelta === "number"
                ? legacy.wheelDelta
                : typeof legacy.detail === "number" && legacy.detail !== 0
                  ? -120 * legacy.detail
                  : // final fallback: convert at "one notch = 120" (one notch on a Chrome mouse wheel is deltaY≈100)
                    (-e.deltaY * 120) / 100;
        for (const h of this.wheelHandlers) h({ delta, world, screen, raw: e });
    };

    private handleKeyDown = (e: KeyboardEvent): void => {
        for (const h of this.keyDownHandlers) h(e);
    };

    private handleKeyUp = (e: KeyboardEvent): void => {
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
        c.removeEventListener("wheel", this.handleWheel);
        window.removeEventListener("keydown", this.handleKeyDown);
        window.removeEventListener("keyup", this.handleKeyUp);
        this.pointers.clear();
        this.downHandlers.length = 0;
        this.moveHandlers.length = 0;
        this.upHandlers.length = 0;
        this.wheelHandlers.length = 0;
        this.keyDownHandlers.length = 0;
        this.keyUpHandlers.length = 0;
    }
}
