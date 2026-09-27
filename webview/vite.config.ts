import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';

export default defineConfig({
  plugins: [react(), Icons({ compiler: 'jsx', jsx: 'react' })],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    chunkSizeWarningLimit: 12000,  // intentional: single bundle for CSP nonce (see comment below)
    rollupOptions: {
      output: {
        entryFileNames: 'assets/main.js',
        assetFileNames: 'assets/[name][extname]',
        // 禁止 code splitting，所有代码打进单个 JS（CSP nonce 只加在入口 script 上）
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
    cssCodeSplit: false,
  },
  server: {
    hmr: false,
    watch: {
      followSymlinks: true,
    },
  },
});
