import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/bridge-extension',
  test: {
    name: '@xapply/bridge-extension',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs}'],
    passWithNoTests: true,
    reporters: ['default'],
  },
}));
