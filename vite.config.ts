import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** The package directory. Set explicitly: vite/vitest resolve `lib.entry` and `test.include`
 *  relative to `root`, which otherwise defaults to the *current working directory* (the repo root). */
const dir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
    root: dir,
    // A library build needs an explicit resolution order: the engine sources
    // use extensionless relative imports, matching the Cocos project it came from.
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
        // The world-layer suites (`tests/features/**` in the game workspace) need game code and run
        // under the game's own vitest config; this one covers the engine package only.
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
