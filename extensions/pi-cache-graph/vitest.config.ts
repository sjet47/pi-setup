import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["extensions/pi-cache-graph/tests/**/*.test.ts"],
  },
});
