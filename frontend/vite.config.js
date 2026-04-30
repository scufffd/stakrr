import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://127.0.0.1:3060';
  const apiProxy = {
    '/api': {
      target: proxyTarget,
      changeOrigin: true,
    },
  };

  return {
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
      proxy: apiProxy,
    },
    preview: {
      port: 5180,
      proxy: apiProxy,
    },
  };
});
