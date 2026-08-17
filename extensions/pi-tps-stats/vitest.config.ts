import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["extensions/pi-tps-stats/tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
