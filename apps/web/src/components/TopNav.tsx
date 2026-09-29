// 顶栏：品牌 + 三个一级入口（实时聊天 / 数字人视频 / 后台）
import { Link } from '../lib/router';
import type { Route } from '../lib/routes';
import { IconChat, IconDashboard, IconSparkles, IconVideo } from './Icons';

const NAV = [
  { page: 'chat', to: '/chat', label: '实时聊天', Icon: IconChat },
  { page: 'video', to: '/video', label: '数字人视频', Icon: IconVideo },
  { page: 'admin', to: '/admin', label: '后台', Icon: IconDashboard },
] as const;

export default function TopNav({ route }: { route: Route }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link to="/chat" className="brand" aria-label="Human Lab 首页">
          <span className="brand-mark">
            <IconSparkles size={16} />
          </span>
          <span className="brand-name">Human Lab</span>
        </Link>
        <nav className="nav" aria-label="主导航">
          {NAV.map(({ page, to, label, Icon }) => {
            const on = route.page === page;
            return (
              <Link key={page} to={to} className={`nav-link${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>
                <Icon size={16} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
