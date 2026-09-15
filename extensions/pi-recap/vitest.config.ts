import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['extensions/pi-recap/test/**/*.test.ts'],
  },
});
