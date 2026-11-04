export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "45m", "2h10", "3d4h" */
export function shortDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
  return `${Math.floor(hrs / 24)}d${hrs % 24 ? `${hrs % 24}h` : ''}`;
}

export function bar(value: number, max: number, width: number): string {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const full = Math.round(ratio * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export function money(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  return s.length <= width ? s.padEnd(width) : s.slice(0, Math.max(0, width - 1)) + '…';
}

/** Keeps the selected row visible inside a window of `height` rows. */
export function scrollWindow(selected: number, total: number, height: number): [start: number, end: number] {
  if (total <= height) return [0, total];
  const start = Math.min(Math.max(0, selected - Math.floor(height / 2)), total - height);
  return [start, start + height];
}

/** Wall-clock time of an epoch-seconds moment: "14:05", or "Tue 14:05" when it is not today. */
export function formatClock(epochSeconds: number, nowSeconds = Date.now() / 1000): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date(nowSeconds * 1000).toDateString()) return hm;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
}
