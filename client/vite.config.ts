import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The API runs separately in development; Vite proxies /api to it so the
// client can use same-origin relative URLs in both dev and production.
//
// Overridable so a second API can be run alongside the usual one — testing a schema
// change against a throwaway database, for instance, without stopping the server you
// already have up on 4000.
// Narrowly declared rather than pulling in @types/node: this config is the only file
// in the client that runs under Node, and one env var is not worth a dependency.
declare const process: { env: Record<string, string | undefined> };
const API_TARGET = process.env.WHEELHOUSE_API_TARGET ?? 'http://127.0.0.1:4000';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
