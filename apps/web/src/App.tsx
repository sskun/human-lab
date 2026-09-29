/**
 * 应用外壳：顶栏 + 按路由渲染页面
 *   /chat   实时聊天（会话制，听 → 想 → 说）
 *   /video  数字人视频（文案 → 口播视频 / 语音）
 *   /admin  后台（概览 / 运行日志 / 任务记录 / 会话记录）
 */
import { useEffect } from 'react';
import { navigate, useRoute } from './lib/router';
import TopNav from './components/TopNav';
import ChatPage from './pages/ChatPage';
import VideoPage from './pages/VideoPage';
import AdminPage from './pages/admin/AdminPage';

const TITLES = { chat: '实时聊天', video: '数字人视频', admin: '后台' } as const;

export default function App() {
  const route = useRoute();

  // 路径归一：/ → /chat、未知路径回落等，用 replace 不产生多余历史记录
  useEffect(() => {
    if (window.location.pathname !== route.path) navigate(route.path, true);
    document.title = `${TITLES[route.page]} · Human Lab`;
  }, [route]);

  return (
    <>
      <a href="#main" className="skip-link">
        跳到主要内容
      </a>
      <TopNav route={route} />
      <main id="main" className={`main main-${route.page}`}>
        {route.page === 'chat' && <ChatPage />}
        {route.page === 'video' && <VideoPage />}
        {route.page === 'admin' && <AdminPage tab={route.tab} />}
      </main>
    </>
  );
}
