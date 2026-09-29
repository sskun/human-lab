// 路由表（纯函数，无 DOM 依赖）：pathname → 页面。前台两个业务 + 后台四个子页。

export type AdminTab = 'overview' | 'logs' | 'tasks' | 'sessions';

export type Route =
  | { page: 'chat'; path: '/chat' }
  | { page: 'video'; path: '/video' }
  | { page: 'admin'; tab: AdminTab; path: string };

const ADMIN_TABS: readonly AdminTab[] = ['overview', 'logs', 'tasks', 'sessions'];

/** 解析路径：去尾斜杠、忽略大小写；未知路径回落到实时聊天，后台未知子页回落到概览 */
export function resolveRoute(pathname: string): Route {
  const parts = pathname.toLowerCase().split('/').filter(Boolean);
  const [head, sub] = parts;
  if (head === 'video') return { page: 'video', path: '/video' };
  if (head === 'admin') {
    const tab = ADMIN_TABS.find((t) => t === sub && t !== 'overview');
    return tab ? { page: 'admin', tab, path: `/admin/${tab}` } : { page: 'admin', tab: 'overview', path: '/admin' };
  }
  return { page: 'chat', path: '/chat' };
}

/** 修饰键 / 中键点击交给浏览器（新标签页打开等），只有普通左键才走前端路由 */
export function isPlainLeftClick(e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
