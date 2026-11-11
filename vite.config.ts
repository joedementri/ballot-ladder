import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works at any GitLab Pages path (https://<user>.gitlab.io/<project>/).
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: { manualChunks: { maplibre: ['maplibre-gl'], echarts: ['echarts'] } },
    },
  },
  test: { environment: 'node', setupFiles: ['./test/setup.ts'] },
} as any);
