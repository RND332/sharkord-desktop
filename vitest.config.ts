import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // the SDK resolves `electron` through Node, which has no app export outside a real runtime
    server: { deps: { inline: ['@sentry/electron'] } }
  }
});
