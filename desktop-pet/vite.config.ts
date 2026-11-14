import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'

const nodeExternal = ['electron', /^node:/]

export default defineConfig(({ mode }): UserConfig => {
  if (mode === 'electron-main') {
    return {
      build: {
        target: 'node22',
        outDir: 'dist-electron',
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: { main: 'electron/main.ts' },
          formats: ['es'],
          fileName: () => 'main.js',
        },
        rollupOptions: { external: nodeExternal },
      },
    }
  }

  if (mode === 'electron-preload') {
    return {
      build: {
        target: 'node22',
        outDir: 'dist-electron',
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: { preload: 'electron/preload.ts' },
          formats: ['cjs'],
          fileName: () => 'preload.cjs',
        },
        rollupOptions: { external: ['electron'] },
      },
    }
  }

  return {
    root: 'renderer',
    base: './',
    plugins: [react()],
    build: {
      outDir: '../dist-renderer',
      emptyOutDir: true,
    },
  }
})
