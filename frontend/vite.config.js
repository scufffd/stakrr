import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'process', 'crypto', 'stream', 'util'],
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  define: {
    'process.env': {},
  },
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3060',
        changeOrigin: true,
      },
    },
  },
});
