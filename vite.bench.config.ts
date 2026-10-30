import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** The package directory (see `vite.config.ts` for why `root` is pinned explicitly). */
const dir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Benchmark-only configuration.
 *
 * The grid benchmark is a vitest file that prints timings instead of asserting behavior,
 * and its numbers are machine-dependent. Keeping it in a separate config leaves the
 * default suite as a correctness gate while `npm run bench:grid` stays opt-in.
 */
export default defineConfig({
    root: dir,
    resolve: {
        extensions: [".ts", ".tsx", ".mjs", ".js", ".mts", ".json"],
    },
    test: {
        include: ["bench/**/*.test.ts"],
        environment: "node",
    },
});
