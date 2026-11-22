import { defineConfig } from "vitest/config";

const testTimeout = 90_000;

export default defineConfig({
  test: {
    testTimeout,
    teardownTimeout: 60_000,
    projects: [
      { test: { name: "unit", testTimeout, include: ["tests/unit/**/*.test.ts"] } },
      {
        test: {
          name: "e2e",
          testTimeout,
          // Windows에서 실제 Chromium 프로세스와 SDK 연결이 닫힐 때까지 기다린다.
          hookTimeout: 60_000,
          include: ["tests/e2e/**/*.test.ts"],
          globalSetup: ["tests/e2e/global-setup.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
