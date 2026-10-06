import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['e2e/**/*.e2e.ts'], testTimeout: 180_000, hookTimeout: 240_000, pool: 'forks', poolOptions: { forks: { singleFork: true } } },
});
