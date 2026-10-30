import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** The package directory (see `vite.config.ts` for why `root` must be pinned explicitly). */
const dir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Benchmark-only configuration.
 *
 * The pure-CPU grid benchmark is a vitest file, but it must not be part of the default suite: it prints
 * timings instead of asserting behaviour, and its numbers are machine-dependent. Keeping it in a
 * separate config means `npm test -w @industry-idle/engine` stays a correctness gate while
 * `npm run bench:grid` remains an explicit, opt-in measurement.
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
