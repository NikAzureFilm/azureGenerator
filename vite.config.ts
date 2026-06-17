import { sentryVitePlugin } from '@sentry/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import path from 'path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  plugins: [
    tanstackStart({
      router: {
        basepath: '/',
      },
      spa: {
        enabled: true,
        maskPath: '/',
      },
    }),
    react(),
    sentryVitePlugin({
      org: 'adamcad',
      project: 'adamcad',
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,

    outDir: 'dist',
    emptyOutDir: true,

    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/@tanstack/react-router/') ||
            id.includes('/node_modules/@tanstack/react-start/') ||
            id.includes('/node_modules/lucide-react/')
          ) {
            return 'vendor';
          }
          if (
            id.includes('/node_modules/three/') ||
            id.includes('/node_modules/three-stdlib/') ||
            id.includes('/node_modules/@react-three/')
          ) {
            return 'three';
          }
        },
      },
    },

    sourcemap: true,
  },
  environments: {
    client: {
      build: {
        outDir: 'dist',
      },
    },
    server: {
      build: {
        outDir: 'dist/server',
      },
    },
  },
  preview: {
    port: 4173,
    host: true,
  },
  server: {
    port: 3000,
    open: false,
  },
  optimizeDeps: {
    exclude: ['@zip.js/zip.js', 'three', 'three-stdlib', '@sentry/vite-plugin'],
  },
});
