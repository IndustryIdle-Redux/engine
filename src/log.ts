/**
 * Engine-agnostic logging, matching `cc.log` / `cc.warn` / `cc.error` / `cc.assert`.
 *
 * Arguments are variadic and passed straight through to console, preserving the Cocos call shape.
 */

/* eslint-disable no-console */

/** Matches `cc.log` */
export function log(...args: unknown[]): void {
    console.log(...args);
}

/** Matches `cc.warn` */
export function warn(...args: unknown[]): void {
    console.warn(...args);
}

/** Matches `cc.error`; also forwards to the registered error hook. */
export function error(...args: unknown[]): void {
    if (errorHook) errorHook(args);
    console.error(...args);
}

declare const CC_DEBUG: boolean | undefined;

/**
 * Matches Cocos `cc.assert`: throws when the condition is false.
 *
 * When `CC_DEBUG` is defined and false (release builds) this is a no-op, mirroring Cocos'
 * DebugMode.NONE behavior. The engine does not depend on the game's `globals.d.ts`, so
 * `typeof` is used; when `CC_DEBUG` is undefined (unit tests, standalone engine) assertions
 * stay enabled, equivalent to Cocos' editor/debug mode.
 */
export function assert(condition: unknown, message?: string): void {
    if (typeof CC_DEBUG !== "undefined" && !CC_DEBUG) return;
    if (!condition) {
        error(message ?? "Assertion failed");
        throw new Error(message ?? "Assertion failed");
    }
}

/* ------------------------------------------------------------------ *
 * Pluggable error hook
 * ------------------------------------------------------------------ */

type ErrorHook = (args: unknown[]) => void;
let errorHook: ErrorHook | null = null;

/** Register the error hook (used for platform reporting). Pass null to unregister. */
export function setErrorHook(hook: ErrorHook | null): void {
    errorHook = hook;
}

/** Manually forward an error to the registered hook (reusable by callers that need it) */
export function reportError(args: unknown[]): void {
    if (errorHook) errorHook(args);
}
