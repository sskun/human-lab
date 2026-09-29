// 通用 UI 小件：加载圈、状态徽标、错误条、空状态、数字人头像
import { useState, type ReactNode } from 'react';
import { IconAlert, IconSparkles } from './Icons';

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role={label ? 'status' : undefined} aria-label={label} />;
}

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/** 状态徽标：颜色之外始终带文字，不单靠颜色表达含义 */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="error-banner" role="alert">
      <IconAlert size={16} />
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}

/** 数字人头像：优先用当前形象图，加载失败（未配置形象/服务未起）回落为渐变图标 */
export function AvatarImage({ src, size = 'md', alt = '数字人形象' }: { src?: string; size?: 'sm' | 'md' | 'lg'; alt?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <span className={`avatar avatar-${size} avatar-fallback`} role="img" aria-label={alt}>
        <IconSparkles size={size === 'lg' ? 40 : size === 'md' ? 22 : 16} />
      </span>
    );
  }
  return <img className={`avatar avatar-${size}`} src={src} alt={alt} onError={() => setBroken(true)} />;
}
