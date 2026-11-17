import { defineConfig } from 'vitest/config';

// Runs only the *.db.spec.ts files, against the local Supabase stack.
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api-db',
  test: {
    name: '@xapply/api:db',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.db.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
}));
