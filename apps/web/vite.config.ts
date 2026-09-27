// Vite 配置：React 插件 + 开发代理
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 开发期代理：浏览器只请求同源的 /api、/media，由 vite 转发到 Express(3001)，
    // 因此前端代码不用写完整后端地址，也天然规避了 CORS 问题。
    proxy: {
      '/api': 'http://localhost:3001',
      '/media': 'http://localhost:3001',
    },
  },
});
