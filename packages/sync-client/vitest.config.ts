import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// The worktree symlinks node_modules from the main checkout, so npm workspace
// linking cannot resolve @balance/core -- alias it straight to source.
// better-sqlite3 is resolved from THIS package's node_modules and aliased by
// absolute path so drizzle-orm (hoisted elsewhere) finds the same binary.
const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The convergence suite boots a real server on PGLite; generous timeout.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@balance/core": resolve(__dirname, "../core/src/index.ts"),
      "better-sqlite3": require.resolve("better-sqlite3"),
    },
  },
});
