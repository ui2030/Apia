import { defineConfig } from 'vite'
import { resolve } from 'path'

function getManualChunkName(id) {
  const normalizedId = String(id || '').replaceAll('\\', '/')

  if (!normalizedId.includes('/node_modules/')) return null
  if (normalizedId.includes('/@pixiv/three-vrm/')) return 'vendor-vrm'
  if (normalizedId.includes('/axios/')) return 'vendor-network'

  if (normalizedId.includes('/three/build/three.module.js')) {
    return 'vendor-three'
  }

  if (normalizedId.includes('/three/examples/jsm/')) {
    return 'vendor-three-examples'
  }

  if (
    normalizedId.includes('/three/src/math/') ||
    normalizedId.includes('/three/src/core/')
  ) {
    return 'vendor-three-foundation'
  }

  if (
    normalizedId.includes('/three/src/renderers/') ||
    normalizedId.includes('/three/src/textures/')
  ) {
    return 'vendor-three-renderer'
  }

  if (
    /\/three\/src\/(animation|audio|cameras|extras|geometries|helpers|lights|loaders|materials|objects|scenes)\//.test(normalizedId)
  ) {
    return 'vendor-three-scene'
  }

  if (normalizedId.includes('/three/')) {
    return 'vendor-three'
  }

  return 'vendor'
}

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 560,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
        chat: resolve(__dirname, 'chat.html'),
        corner: resolve(__dirname, 'corner.html')
      },
      output: {
        manualChunks(id) {
          return getManualChunkName(id)
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  optimizeDeps: {
    include: ['three', '@pixiv/three-vrm']
  }
})
