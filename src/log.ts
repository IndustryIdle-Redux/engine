/**
 * Engine-agnostic logging.
 *
 * Matches Cocos' `cc.log / cc.warn / cc.error / cc.assert`.
 * The original implementation only forwarded to console (the release build wrapped `cc.error` once to also report
 * to analytics), so this goes straight to console and keeps **the same call signature** (variadic args + format
 * placeholders passed through).
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

/**
 * Matches `cc.error`.
 *
 * The original release build monkey-patched `cc.error` to also report to analytics; that integration has been removed.
 * Here it triggers the registered hook internally instead, and no longer hangs anything off engine objects.
 */
export function error(...args: unknown[]): void {
    if (errorHook) errorHook(args);
    console.error(...args);
}

/** Matches Cocos `cc.assert`: throws when the condition is false (the message goes to the log) */
/**
 * Assertion.
 *
 * ⚠️ **Must be wired to CC_DEBUG**: in release builds the original assertion is a **no-op** --
 * `General/Helper.ts` wraps it in `if (!CC_DEBUG) { return; }` itself,
 * and Cocos' `cc.assert` is replaced by an empty function under `DebugMode.NONE`
 * (`CCDebug.js:41`).
 *
 * If it always threw here, a dozen high-frequency paths in release builds (`PlayerTrade` auction/tax,
 * `BuildingTicks` power, every building add/remove in `World`) would go from "silently recording"
 * to "throwing and breaking the call stack" -- that is a **behavior difference**, not "being stricter".
 *
 * The engine does not depend on the game's `globals.d.ts`, so `typeof` is used as the fallback:
 * at build time esbuild replaces `CC_DEBUG` with a literal; in unit tests / running the engine standalone it is undefined,
 * and in that case it stays enabled (equivalent to Cocos' editor/debug mode).
 */
declare const CC_DEBUG: boolean | undefined;

export function assert(condition: unknown, message?: string): void {
    if (typeof CC_DEBUG !== "undefined" && !CC_DEBUG) return;
    if (!condition) {
        error(message ?? "Assertion failed");
        throw new Error(message ?? "Assertion failed");
    }
}

/* ------------------------------------------------------------------ *
 * Pluggable error hook (replaces the old monkey patch on cc.error)
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
