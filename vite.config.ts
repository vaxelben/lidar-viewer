import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Virtual module plugin
const virtualModulePlugin = (): Plugin => {
  const virtualModuleId = 'virtual:empty-module'
  const resolvedVirtualModuleId = '\0' + virtualModuleId

  return {
    name: 'virtual-module-plugin',
    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId
      }
    },
    load(id) {
      if (id === resolvedVirtualModuleId) {
        // Empty module that exports the components that are imported
        return `
          export const ZoomWidget = () => null;
          export const CompassWidget = () => null;
          export const FullscreenWidget = () => null;
        `
      }
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    virtualModulePlugin()
  ],
  server: {
    host: true, // Permet l'accès depuis d'autres appareils sur le réseau
    open: true,
    // Middleware pour supporter les requêtes HTTP Range (nécessaire pour COPC)
    middlewareMode: false,
    headers: {
      'Accept-Ranges': 'bytes'
    }
  },
  build: {
    rollupOptions: {
      external: ['@deck.gl/widgets']
    }
  },
  optimizeDeps: {
    exclude: ['@deck.gl/widgets']
  },
  resolve: {
    alias: {
      '@deck.gl/widgets': 'virtual:empty-module'
    }
  }
})
