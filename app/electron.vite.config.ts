import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // The AI package is a workspace dependency, loaded at runtime (see src/main/ai.ts) and
        // shipped as-is by electron-builder (it reads its prompts/ folder from disk).
        external: ['@reelstudio/ai']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // the macOS permission helper window (src/main/mac-permission-helper.ts)
          'permission-helper': resolve(__dirname, 'src/preload/permission-helper.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    plugins: [react()]
  }
})
