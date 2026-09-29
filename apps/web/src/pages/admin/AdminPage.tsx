// 管理后台外壳：子页导航（概览 / 运行日志 / 任务记录 / 会话记录）+ 内容区
import type { AdminTab } from '../../lib/routes';
import { Link } from '../../lib/router';
import { IconActivity, IconChat, IconDashboard, IconList } from '../../components/Icons';
import OverviewTab from './OverviewTab';
import LogsTab from './LogsTab';
import TasksTab from './TasksTab';
import SessionsTab from './SessionsTab';

const TABS = [
  { tab: 'overview', to: '/admin', label: '概览', Icon: IconDashboard },
  { tab: 'logs', to: '/admin/logs', label: '运行日志', Icon: IconActivity },
  { tab: 'tasks', to: '/admin/tasks', label: '任务记录', Icon: IconList },
  { tab: 'sessions', to: '/admin/sessions', label: '会话记录', Icon: IconChat },
] as const;

export default function AdminPage({ tab }: { tab: AdminTab }) {
  return (
    <div className="admin">
      <div className="admin-head">
        <div>
          <h1 className="page-title">后台</h1>
          <p className="page-sub">运行日志与调用记录（只读，无鉴权，仅限本机 / 内网使用）</p>
        </div>
        <nav className="subnav" aria-label="后台导航">
          {TABS.map(({ tab: t, to, label, Icon }) => (
            <Link key={t} to={to} className={`subnav-link${tab === t ? ' on' : ''}`} aria-current={tab === t ? 'page' : undefined}>
              <Icon size={15} />
              {label}
            </Link>
          ))}
        </nav>
      </div>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'logs' && <LogsTab />}
      {tab === 'tasks' && <TasksTab />}
      {tab === 'sessions' && <SessionsTab />}
    </div>
  );
}
