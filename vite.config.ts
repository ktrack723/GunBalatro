import { defineConfig } from 'vite'

export default defineConfig({
  base: process.env.GH_PAGES ? '/GunBalatro/' : '/',
  build: {
    target: 'es2020',
    assetsInlineLimit: 4096,
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
  },
  server: { host: true, port: 5173 },
})
