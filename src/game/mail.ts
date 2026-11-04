// Reports and telegrams (MessagesWindow / ReportWindow / TelegramWindow, tw2game @1295000–@1342000):
//   reports/get_reports {page, folder}          → {count (pages), page, reports:[{report_id, title, hash, read,
//                                                   date_received, popupData, publish_mode}]}     @1313463
//     folders: all · job · duel · achv · fortbattle · other · deleted (MessagesWindow.Report categoryFilter)
//   reports/show_report (mode) {report_id, hash, animated, simpleheader} → {title, date_received, page (HTML),
//                                                   reportType, reportInfo, ...}                   @1329305
//   reports/delete_single_report {report, type:<folder>, deleted:<folder=='deleted'>} → [failed?]   @1319916
//   messages/get_messages {folder_id:'all', page, visibles:[], include_blocked} → {page, count, folders,
//                                                   messages:[{message_id, subject, partner_name[], partner_id[],
//                                                   own_status (2 answered, 3|5 unread), last_post_date, ...}]} @1296549
//   messages/get_message {tid, page}             → {subject, page, pages, posts:[{name|null, post_date, text, player_id}],
//                                                   head_id, ownbyme}                              @1323710
//   messages/reply {message_id, text}            → [ok, msg]                                       @1326958
//   messages/send {to, subject, text, masstelegramm} → [ok, msg, [kind, names]]                    @1306677
//   messages/delete_messages {messages:[id]}                                                       @1305540
// Report bodies (`page`) and posts are HTML / BBCode; shown as plain text.
import type { GameClient } from '../http/game-client.ts';
import { plainText } from './quests.ts';

export const REPORT_FOLDERS = [
  { key: 'all', label: 'All' },
  { key: 'job', label: 'Work' },
  { key: 'duel', label: 'Duels' },
  { key: 'achv', label: 'Achievements' },
  { key: 'fortbattle', label: 'Fort battles' },
  { key: 'other', label: 'Other' },
  { key: 'deleted', label: 'Deleted' },
] as const;
export type ReportFolder = (typeof REPORT_FOLDERS)[number]['key'];

export interface ReportRow { id: number; title: string; hash: string; read: boolean; date: string; summary: string }
export interface ReportList { page: number; pages: number; reports: ReportRow[] }
export interface Report { id: number; title: string; date: string; type: string; text: string }

export interface TelegramRow {
  id: number;
  subject: string;
  /** Conversation partners; empty for system mail. */
  partners: string[];
  unread: boolean;
  answered: boolean;
  date: string;
}
export interface TelegramList { page: number; pages: number; telegrams: TelegramRow[] }
export interface TelegramPost { from: string; date: string; text: string }
export interface Telegram { id: number; subject: string; page: number; pages: number; posts: TelegramPost[] }

/** Game.TextHandler-ish: BBCode tags dropped, [player]x[/player] → x, then HTML → text. */
export function bbText(s: unknown): string {
  return plainText(String(s ?? '').replace(/\[\/?(b|i|u|del|quote|player|town|fort|url|color|size)(=[^\]]*)?\]/gi, ''));
}

const JOB_LABELS = ['Motivation', 'Time', 'Money', 'Pacific Bonds', 'Bonds', 'Experience', 'Luck', 'Items Found'] as const;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const JOB_LABEL_RE = new RegExp(`^(${JOB_LABELS.map(escapeRe).join('|')})(?![A-Za-z])\\s*:?\\s*(.+)$`, 'i');
const NUMBER_VALUE_RE = /^\d[\d.,]*(?:\s*%|\s*(?:Points?|s|min|h|hours?|days?))?$/i;
const MONEY_VALUE_RE = /^[$€£]\s*\d[\d.,]*(?:\s*%|\s*(?:Points?|s|min|h|hours?|days?))?$/i;

const cleanLabel = (s: string) => s.replace(/:\s*$/, '').trim();
const isValue = (s: string) => NUMBER_VALUE_RE.test(s) || MONEY_VALUE_RE.test(s);
const isKnownLabel = (s: string) => {
  const label = cleanLabel(s).toLowerCase();
  return JOB_LABELS.some((x) => x.toLowerCase() === label);
};
const canonicalLabel = (s: string) => {
  const label = cleanLabel(s).toLowerCase();
  return JOB_LABELS.find((x) => x.toLowerCase() === label) ?? cleanLabel(s);
};
const isGenericLabel = (s: string) => {
  const label = cleanLabel(s);
  return label.length >= 2 && label.length <= 30 && /^[A-Z]/.test(label) && !/[.!?]$/.test(label) && !isValue(label);
};
const normalizeValue = (s: string) => s.trim()
  .replace(/^([$€£])\s+/, '$1')
  .replace(/\s+%$/, '%')
  .replace(/^([+-])\s+/, '$1')
  .replace(/\s+(Points?)$/i, ' $1');

function formatItems(lines: string[]): string[] {
  const items: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^no items? (were|was) found/i.test(line)) return [];
    if (/^\d+$/.test(line)) {
      const last = items[items.length - 1];
      if (last && !/\sx\s\d+$/.test(last)) items[items.length - 1] = `${last} x ${line}`;
      else items.push(line);
      continue;
    }
    const match = /^(.+?)\s*[x×]\s*(\d+)$/i.exec(line)
      ?? /^(.+?)\s*\((\d+)\)$/.exec(line)
      ?? /^(.+?):\s*(\d+)$/.exec(line)
      ?? /^(.+?)\s+(\d+)$/.exec(line);
    if (match) items.push(`${match[1]!.trim()} x ${match[2]}`);
    else items.push(line);
  }
  return items;
}

/**
 * Found items of a job report: show_report's reportInfo.items is [[itemId, ?, count, type], …]. The page only
 * has empty placeholders the browser fills from its js (tw2widget.Item(...).setCount(n)).
 */
export function reportItems(info: unknown, itemName: (id: number) => string): string[] {
  const items = (info as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((i) => Array.isArray(i) && Number(i[0])).map((i) => `${itemName(Number(i[0]))} x ${Number(i[2]) || 1}`);
}

/** The report list's popupData shows found items as one <img alt="name"> each: "name x count", in order. */
export function popupItems(html: unknown): string[] {
  const counts = new Map<string, number>();
  for (const m of String(html ?? '').matchAll(/<img[^>]*src="[^"]*\/items\/[^"]*"[^>]*alt="([^"]+)"/g)) {
    const name = plainText(m[1]);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([n, c]) => `${n} x ${c}`);
}

/**
 * Job report pages are field lists; join label/value pairs and compact the items section. `items` (from
 * reportItems) replaces the page's items section, which is empty in the HTML.
 */
export function formatReport(text: string, type = '', items: string[] = []): string {
  if (type.toLowerCase() !== 'job') return text;
  const out = formatJobReport(text);
  if (!items.length) return out;
  const line = `Items: ${items.join(', ')}`;
  const lines = out.split('\n');
  const at = lines.findIndex((l) => /^Items:/.test(l));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return lines.join('\n');
}

function formatJobReport(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  const push = (line: string) => {
    const value = line.trim();
    if (value && out[out.length - 1] !== value) out.push(value);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^items found:?$/i.test(line)) {
      const raw: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (isKnownLabel(lines[j]!)) break;
        if (/^no items? (were|was) found/i.test(lines[j]!)) {
          j++;
          break;
        }
        raw.push(lines[j]!);
      }
      const items = formatItems(raw);
      push(items.length ? `Items: ${items.join(', ')}` : 'Items: none');
      i = j - 1;
      continue;
    }
    const inlineItems = /^items found:?\s+(.+)$/i.exec(line);
    if (inlineItems) {
      const value = inlineItems[1]!.trim();
      push(`Items: ${/^no items? (were|was) found/i.test(value) ? 'none' : value}`);
      continue;
    }
    const known = JOB_LABEL_RE.exec(line);
    if (known) {
      const value = normalizeValue(known[2]!);
      if (isValue(value)) {
        push(`${canonicalLabel(known[1]!)}: ${value}`);
        continue;
      }
    }
    const next = lines[i + 1];
    if (next) {
      const knownLabel = isKnownLabel(line);
      const genericLabel = !knownLabel && isGenericLabel(line) && NUMBER_VALUE_RE.test(next);
      if ((knownLabel && isValue(next)) || genericLabel) {
        const value = normalizeValue(next);
        let j = i + 1;
        while (j + 1 < lines.length && normalizeValue(lines[j + 1]!) === value) j++;
        push(`${knownLabel ? canonicalLabel(line) : cleanLabel(line)}: ${value}`);
        i = j;
        continue;
      }
    }
    push(line);
  }
  return out.join('\n');
}

/** popupData field labels are icons (images/job/clock.png …): their words, so the preview is not bare numbers. */
const POPUP_ICONS: Record<string, string> = {
  clock: 'Time', dollar: 'Money', upb: 'Bonds', experience: 'XP', danger: 'Danger', motivation: 'Motivation', luck: 'Luck', star: 'XP',
};

/** The report list's popupData as text: icon labels named, item images left out (popupItems names them). */
export function popupText(html: unknown): string {
  const labelled = String(html ?? '')
    .replace(/<img[^>]*src="[^"]*\/items\/[^"]*"[^>]*>/gi, '')
    .replace(/<img[^>]*src="[^"]*\/([a-z_]+)\.png"[^>]*>/gi, (_, icon: string) => (POPUP_ICONS[icon.toLowerCase()] ? `${POPUP_ICONS[icon.toLowerCase()]}: ` : ''));
  return plainText(labelled).replace(/\n{2,}/g, '\n');
}

/** The list summary's "Found items:" heading is followed by images only: put the names after it. */
function withItems(summary: string, items: string[]): string {
  if (!items.length) return summary;
  return /Found items:/i.test(summary) ? summary.replace(/Found items:/i, `Found items: ${items.join(', ')}`) : `${summary}\nFound items: ${items.join(', ')}`;
}

/**
 * One log line for a report row. Job reports become "Job: +XP, $, extras · found items" from the list summary
 * ("Time: 1 hour Money: 297\nBonds: 0 XP: 161\nDanger: 0 355 Cempasúchil\nFound items: Water x 11"; an
 * unlabelled "<n> <name>" after a labelled number is an event currency). Other reports keep their title.
 */
export function reportLogLine(r: ReportRow): string {
  const job = /^Job report:\s*(.+)$/i.exec(r.title)?.[1];
  if (!job) return `Report: ${r.title}`;
  const num = (re: RegExp) => Number(re.exec(r.summary)?.[1]) || 0;
  const xp = num(/\bXP:\s*(\d+)/i);
  const money = num(/\bMoney:\s*(\d+)/i);
  const extras = [...r.summary.matchAll(/:\s*\d+\s+(\d+\s+[^\d\s:][^\n:]*)$/gm)].map((m) => m[1]!.trim());
  const found = /^Found items:\s*(.+)$/im.exec(r.summary)?.[1]?.trim();
  const gains = [xp && `+${xp} XP`, money && `$${money}`, ...extras].filter(Boolean).join(', ');
  return `${job}${gains ? `: ${gains}` : ''}${found ? ` · found ${found}` : ''}`;
}

function fail(json: any, what: string): never {
  throw new Error(plainText(json?.msg ?? json?.error ?? `${what} failed`));
}

/** show_report reply → job, items, seconds (see MailApi.jobReport). */
export function parseJobReport(json: Record<string, any>): { jobId: number; items: [number, number][]; seconds: number | null } | null {
  const info = json.reportInfo;
  const jobId = Number(info?.job_id);
  if (String(json.reportType ?? '') !== 'job' || !jobId) return null;
  const items: [number, number][] = (Array.isArray(info.items) ? info.items : [])
    .filter((i: unknown) => Array.isArray(i) && Number(i[0]))
    .map((i: unknown[]) => [Number(i[0]), Number(i[2]) || 1] as [number, number]);
  const m = plainText(json.page).match(/(\d+)\s*(second|minute|hour)s?\b/i);
  const seconds = m ? Number(m[1]) * ({ second: 1, minute: 60, hour: 3600 } as Record<string, number>)[m[2]!.toLowerCase()]! : null;
  return { jobId, items, seconds };
}

export class MailApi {
  private client: GameClient;

  private itemName: (id: number) => string;

  constructor(client: GameClient, itemName: (id: number) => string = (id) => `item ${id}`) {
    this.client = client;
    this.itemName = itemName;
  }

  async reports(page = 1, folder: ReportFolder = 'all'): Promise<ReportList> {
    const json = await this.client.remoteCall('reports', 'get_reports', { page, folder });
    if (json.error) fail(json, 'reports/get_reports');
    return {
      page: Number(json.page) || page,
      pages: Number(json.count) || 1,
      reports: (Array.isArray(json.reports) ? json.reports : []).map((r: any) => ({
        id: Number(r.report_id), title: plainText(r.title), hash: String(r.hash ?? ''), read: !!r.read,
        date: plainText(r.date_received), summary: withItems(popupText(r.popupData), popupItems(r.popupData)),
      })),
    };
  }

  async report(id: number, hash = ''): Promise<Report> {
    const json = await this.client.remoteCallMode('reports', 'show_report', { report_id: id, hash, animated: 0, simpleheader: 0 });
    if (json.error) fail(json, 'reports/show_report');
    const type = String(json.reportType ?? '');
    return { id, title: plainText(json.title), date: plainText(json.date_received), type, text: formatReport(plainText(json.page, { compact: true }), type, reportItems(json.reportInfo, this.itemName)) };
  }

  /**
   * A job report as data, for calibration: the job (reportInfo.job_id), found items ([itemId, count] from
   * reportInfo.items) and the run length in seconds (the page's first "N second/minute/hour(s)"). Null when it
   * is not a job report.
   */
  async jobReport(id: number, hash = ''): Promise<{ jobId: number; items: [number, number][]; seconds: number | null } | null> {
    const json = await this.client.remoteCallMode('reports', 'show_report', { report_id: id, hash, animated: 0, simpleheader: 0 });
    if (json.error) fail(json, 'reports/show_report');
    return parseJobReport(json);
  }

  async deleteReport(id: number, folder: ReportFolder = 'all'): Promise<void> {
    const json = await this.client.remoteCall('reports', 'delete_single_report', { report: id, type: folder, deleted: folder === 'deleted' });
    if (Array.isArray(json) ? json[0] : json?.error) throw new Error('Report could not be removed');
  }

  async telegrams(page = 1): Promise<TelegramList> {
    const json = await this.client.remoteCall('messages', 'get_messages', { folder_id: 'all', page, visibles: [], include_blocked: 0 });
    if (json.error) fail(json, 'messages/get_messages');
    return {
      page: Number(json.page) || page,
      pages: Number(json.count ?? json.pages) || 1,
      telegrams: (Array.isArray(json.messages) ? json.messages : []).map((m: any) => {
        const names: string[] = Array.isArray(m.partner_name) ? m.partner_name.map(String) : [];
        return {
          id: Number(m.message_id),
          subject: plainText(m.subject),
          partners: names.filter((n) => n && n !== 'NULL'),
          unread: m.own_status === 3 || m.own_status === 5,
          answered: m.own_status === 2,
          date: plainText(m.last_post_date ?? m.date ?? ''),
        };
      }),
    };
  }

  async telegram(id: number, page = 0): Promise<Telegram> {
    const json = await this.client.remoteCall('messages', 'get_message', { tid: id, page });
    if (json.error) fail(json, 'messages/get_message');
    return {
      id,
      subject: plainText(json.subject),
      page: Number(json.page) || 0,
      pages: Number(json.pages) || 1,
      posts: (Array.isArray(json.posts) ? json.posts : []).map((p: any) => ({ from: p.name ? String(p.name) : 'System', date: plainText(p.post_date), text: bbText(p.text) })),
    };
  }

  /** Replies are [ok, message] arrays. */
  async reply(id: number, text: string): Promise<void> {
    const r = await this.client.remoteCall('messages', 'reply', { message_id: id, text });
    if (Array.isArray(r) ? !r[0] : r?.error) throw new Error(plainText(Array.isArray(r) ? r[1] : r.msg) || 'Reply failed');
  }

  /** `to`: names separated by ; or , (MessagesWindow.Telegram.send checks: subject ≥ 1, text ≥ 3 characters). */
  async send(to: string, subject: string, text: string): Promise<void> {
    if (!to.trim()) throw new Error('No recipient');
    if (!subject.trim()) throw new Error('The subject is empty');
    if (text.length < 3) throw new Error('The text has to be at least 3 characters long!');
    const r = await this.client.remoteCall('messages', 'send', { to, subject, text, masstelegramm: 0 });
    if (Array.isArray(r) ? !r[0] : r?.error) throw new Error(plainText(Array.isArray(r) ? r[1] : r.msg) || 'Sending failed');
  }

  async deleteTelegram(id: number): Promise<void> {
    const json = await this.client.remoteCall('messages', 'delete_messages', { messages: [id] });
    if (json?.error) fail(json, 'messages/delete_messages');
  }
}
