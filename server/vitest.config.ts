import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    pool: "forks",
    // Several suites set NODE_ENV and CLIENT_DIST_PATH to exercise the
    // production static-serving path, and createApp reads both at call time.
    // When files interleave, those writes land while another file is building
    // its app, which produced a roughly one-in-ten failure that surfaced as an
    // unrelated assertion in whichever test was unlucky. Running files
    // sequentially removes the window.
    fileParallelism: false,
    maxWorkers: 1,
    include: ["src/**/*.test.ts"],
  },
});
