// 展示用格式化（纯函数，无 DOM 依赖，可直接单测）

/** 运行时长：秒 → "2 天 1 小时" / "3 小时 5 分钟" / "2 分钟"（只保留两级，够看即可） */
export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

/** 字节数 → B / KB / MB；空值显示横线 */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 时间戳 → "MM-DD HH:MM:SS"。
 * 只做字符串截取不做时区换算：服务端落库的日志/任务时间已是本地时间（YYYY-MM-DD HH:MM:SS.SSS）。
 * 非预期格式原样返回，避免显示成 Invalid Date。
 */
export function formatClock(ts: string): string {
  const m = /^\d{4}-(\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? `${m[1]} ${m[2]}` : ts;
}
