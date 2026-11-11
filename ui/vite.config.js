import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 打包进 Electron 时页面以 file:// 加载，绝对路径 /assets/… 会解析到磁盘根，
// 必须用相对路径。托管在 Manager API（http://127.0.0.1:17800/）时，
// 页面本身就在根路径下，相对路径同样可用。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: false
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900
  }
})
