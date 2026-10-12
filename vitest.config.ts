import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  },
  resolve: {
    alias: {
      // 'electron' is stubbed for unit tests so main-process code that
      // only touches app.getPath/getVersion can run outside a real
      // Electron runtime. See tests/mocks/electron.ts.
      electron: resolve(__dirname, 'tests/mocks/electron.ts'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  }
})
