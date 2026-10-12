import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Three independent builds — main, preload, renderer — matching the
// Step 2 process boundary exactly. Nothing here lets renderer code
// import main code or vice versa; only src/shared is common to all three.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@preload': resolve('src/preload'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        // Electron does not support ESM preload scripts in sandboxed
        // renderers — a sandboxed preload must be CommonJS. Emitting
        // .cjs keeps `sandbox: true` intact (package.json sets
        // "type": "module", so the .cjs extension is what marks this
        // single file as CommonJS).
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    // Bundled Cairo fonts + AURA home logo ship from here so the
    // renderer's dev server and production build see the exact same
    // files the packaged app's print windows load via app://assets.
    publicDir: resolve('resources/assets'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
