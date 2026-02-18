import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_BACKEND_URL ?? 'http://localhost:3001',
        changeOrigin: true
      },
      '/health': {
        target: process.env.VITE_DEV_BACKEND_URL ?? 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
});
