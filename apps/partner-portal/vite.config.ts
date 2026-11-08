import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// Dev: `npm run dev` proxies /api to a locally running partner Worker (wrangler dev, port 8815).
export default defineConfig({
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 }, // no inline assets: keeps the CSP strict (no 'unsafe-inline')
  server: { proxy: { '/api': 'http://localhost:8815' } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
