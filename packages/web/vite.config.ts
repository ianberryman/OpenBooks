import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    // The app consumes the public REST API only (spec §12). In dev that means
    // proxying to the same /v1 surface an external integrator would call, so
    // there is no privileged path that only the first-party app can use.
    proxy: {
      '/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
