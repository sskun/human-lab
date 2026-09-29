// Vite 配置：React 插件 + 开发代理
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 后端地址：与根目录 .env 的 PORT 保持一致 */
const API_TARGET = 'http://localhost:3101';

export default defineConfig({
  plugins: [react()],
  server: {
    // 端口避开 vite 默认 5173，防止和其他项目串；strictPort：被占用时直接报错，而不是悄悄换到下一个端口
    port: 5273,
    strictPort: true,
    // 开发期代理：浏览器只请求同源的 /api、/media，由 vite 转发到后端，
    // 因此前端代码不用写完整后端地址，也天然规避了 CORS 问题。
    proxy: {
      '/api': API_TARGET,
      '/media': API_TARGET,
    },
  },
});
