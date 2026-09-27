// React 入口：把 <App /> 挂载到 index.html 的 #root 节点
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('index.html 里缺少 <div id="root">');

// StrictMode：开发期对组件做双重渲染以暴露副作用问题（生产环境无影响）
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
