import { defineConfig } from "vitest/config";

const testTimeout = 90_000;

export default defineConfig({
  test: {
    testTimeout,
    projects: [
      { test: { name: "unit", testTimeout, include: ["tests/unit/**/*.test.ts"] } },
      {
        test: {
          name: "e2e",
          testTimeout,
          include: ["tests/e2e/**/*.test.ts"],
          globalSetup: ["tests/e2e/global-setup.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
