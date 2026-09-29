// 极简前端路由：History API + useSyncExternalStore（不引入 react-router，避免新增依赖）
import { useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { isPlainLeftClick, resolveRoute, type Route } from './routes';

/** pushState 不会触发 popstate，用自定义事件通知订阅者 */
const NAV_EVENT = 'app:navigate';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAV_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAV_EVENT, onChange);
  };
}

const getPathname = () => window.location.pathname;

/** 当前路由（随浏览器前进/后退、navigate 调用自动更新） */
export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, getPathname);
  return useMemo(() => resolveRoute(pathname), [pathname]);
}

/** 跳转到站内路径；replace=true 时替换当前历史记录（用于路径归一，如 / → /chat） */
export function navigate(to: string, replace = false): void {
  if (to === window.location.pathname) return;
  if (replace) window.history.replaceState(null, '', to);
  else {
    window.history.pushState(null, '', to);
    window.scrollTo(0, 0);
  }
  window.dispatchEvent(new Event(NAV_EVENT));
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

/** 站内链接：普通左键走前端路由；修饰键/中键/target 交给浏览器默认行为（新标签页等） */
export function Link({ to, onClick, target, ...rest }: LinkProps) {
  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (e.defaultPrevented || target || !isPlainLeftClick(e)) return;
    e.preventDefault();
    navigate(to);
  }
  return <a href={to} target={target} onClick={handleClick} {...rest} />;
}
