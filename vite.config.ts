import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** The package directory. Pinned explicitly because `lib.entry` and `test.include` resolve
 *  relative to `root`, which would otherwise default to the current working directory. */
const dir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
    root: dir,
    // The engine sources use extensionless relative imports, so `.ts` must be in the order.
    resolve: {
        extensions: [".ts", ".tsx", ".mjs", ".js", ".mts", ".json"],
    },
    build: {
        target: "es2022",
        sourcemap: true,
        lib: {
            entry: "src/index.ts",
            formats: ["es"],
            fileName: "industry-idle-engine",
        },
    },
    test: {
        // World-layer suites live in the game workspace under its own vitest config;
        // this config only covers the engine package.
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
