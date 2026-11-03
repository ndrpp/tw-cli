// Quests. Request shapes from the client (tw2game):
//   building_quest mode get_open_quests → {quests:[Quest], capacity}       QuestLog.updateQuestLog @2190599
//   building_quest mode ''               → {questEmployer:[{key,name,...}]} saloon, SaloonWindow @2011479
//   quest_employer ''  {employer,x,y}    → {employer:{key,name,open:[Quest]}} | {error}   @1200977
//   quest/accept_quest {quest_id}        → {error,msg,isChallenge,finishable}            @1204341
//   quest/finish_quest {quest_id, reward_option_id} → {error,msg,allRewards,health,...}  @1204845
//   quest/cancel_quest {quest_id}
// A Quest (Quest.init @2194964, captured reply game-c450166a72a56.php): {id,title,soloTitle,group,
// groupTitle,employer,employer_name,employer_coords|false,accepted,acceptable,accessable,finishable,
// requirements:[{solved,info,jsInfo}], questRewards:[{isItem,hidden,info:{css,text,popup_text}}],
// questRewardsOptions, description(html), questHint(html), limited}.
// finish_quest replies may carry `eval` (JS for the browser): never executed here.
import type { GameClient } from '../http/game-client.ts';

/** jsInfo: inventory_changed / wear_changed {id: item, count}; task-finish-job {id: job, count: seconds}. */
export interface QuestRequirement { solved: boolean; info: string; itemId?: number; jobId?: number; count?: number }
export interface QuestReward { item: number | null; text: string }

export interface Quest {
  id: number;
  title: string;
  /** Title without the "(chain)" suffix, for display under a chain header. */
  soloTitle: string;
  groupId: number;
  /** Quest chain ("The Headless Horseman", "Repeatable quests", …). */
  group: string;
  employer: string;
  employerName: string;
  employerAt: { x: number; y: number } | null;
  accepted: boolean;
  acceptable: boolean;
  finishable: boolean;
  requirements: QuestRequirement[];
  rewards: QuestReward[];
  rewardOptions: { id: number; text: string }[];
  description: string;
  hint: string;
  limited: string;
}

export interface QuestEmployer { key: string; name: string; x: number | null; y: number | null; open: Quest[] }

/** HTML → plain text for the terminal. */
export function plainText(html: unknown): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function rewardText(r: Record<string, any>, itemName?: (id: number) => string): QuestReward {
  const info = r.info ?? {};
  if (r.isItem) {
    const id = Number(info.text);
    return { item: id, text: itemName ? itemName(id) : `item ${id}` };
  }
  const label = plainText(info.popup_text ?? info.css ?? '').replace(/^reward_/, '');
  return { item: null, text: `${plainText(info.text)} ${label}`.trim() };
}

function parseRequirement(r: Record<string, any>): QuestRequirement {
  const req: QuestRequirement = { solved: !!r.solved, info: plainText(r.info) };
  const js = r.jsInfo;
  if (js && typeof js === 'object' && js.id !== undefined) {
    if (js.type === 'inventory_changed' || js.type === 'wear_changed') req.itemId = Number(js.id);
    else if (js.type === 'task-finish-job') req.jobId = Number(js.id);
    if (js.count !== undefined) req.count = Number(js.count);
  }
  return req;
}

export function parseQuest(q: Record<string, any>, itemName?: (id: number) => string): Quest {
  const coords = q.employer_coords && typeof q.employer_coords === 'object' ? q.employer_coords : null;
  const opts = q.questRewardsOptions && typeof q.questRewardsOptions === 'object' ? q.questRewardsOptions : null;
  return {
    id: Number(q.id),
    title: plainText(q.title),
    soloTitle: plainText(q.soloTitle ?? q.title),
    groupId: Number(q.group) || 0,
    group: plainText(q.groupTitle) || 'Other quests',
    employer: String(q.employer ?? ''),
    employerName: plainText(q.employer_name),
    employerAt: coords ? { x: Number(coords.x), y: Number(coords.y) } : null,
    accepted: !!q.accepted,
    acceptable: q.acceptable === undefined ? !q.accepted : !!q.acceptable,
    finishable: !!q.finishable,
    requirements: (Array.isArray(q.requirements) ? q.requirements : []).map(parseRequirement),
    rewards: (Array.isArray(q.questRewards) ? q.questRewards : []).filter((r: any) => !r.hidden).map((r: any) => rewardText(r, itemName)),
    rewardOptions: opts
      ? Object.entries<any>(opts).map(([id, o]) => ({ id: Number(o?.id ?? id), text: plainText(o?.title ?? o?.text ?? o?.info?.text ?? `option ${id}`) }))
      : [],
    description: plainText(q.description),
    hint: plainText(q.questHint),
    limited: plainText(q.limited),
  };
}

export interface QuestChain { groupId: number; title: string; quests: Quest[]; finishable: number }

/** Quests grouped by chain, chains sorted by name; quests keep the server's order inside a chain. */
export function groupByChain(quests: Quest[]): QuestChain[] {
  const chains = new Map<string, QuestChain>();
  for (const q of quests) {
    const key = q.groupId ? `#${q.groupId}` : q.group;
    let c = chains.get(key);
    if (!c) chains.set(key, (c = { groupId: q.groupId, title: q.group, quests: [], finishable: 0 }));
    c.quests.push(q);
    if (q.finishable) c.finishable++;
  }
  return [...chains.values()].sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
}

export class QuestApi {
  client: GameClient;
  itemName?: (id: number) => string;

  constructor(client: GameClient, itemName?: (id: number) => string) {
    this.client = client;
    this.itemName = itemName;
  }

  async openQuests(): Promise<{ quests: Quest[]; capacity: number }> {
    const json = await this.client.remoteCallMode('building_quest', 'get_open_quests');
    if (json.error) throw new Error(json.msg ?? 'Quest log failed');
    return { quests: (json.quests ?? []).map((q: any) => parseQuest(q, this.itemName)), capacity: Number(json.capacity) || 0 };
  }

  /** Quest givers in the saloon (no map position). */
  async saloon(): Promise<{ key: string; name: string }[]> {
    const json = await this.client.remoteCallMode('building_quest', '');
    if (json.error) throw new Error(json.msg ?? 'Saloon failed');
    return (json.questEmployer ?? [])
      .filter((e: any) => e && e.key && e.key !== 'wallpaper_telekom')
      .map((e: any) => ({ key: String(e.key), name: plainText(e.name) }));
  }

  async employer(key: string, at?: { x: number; y: number } | null): Promise<QuestEmployer> {
    const json = await this.client.remoteCall('quest_employer', '', { employer: key, x: at?.x, y: at?.y });
    if (json.error) throw new Error(typeof json.error === 'string' ? json.error : json.msg ?? 'Quest giver failed');
    const e = json.employer ?? {};
    return {
      key: String(e.key ?? key),
      name: plainText(e.name ?? key),
      x: at?.x ?? null,
      y: at?.y ?? null,
      open: (e.open ?? []).map((q: any) => parseQuest(q, this.itemName)),
    };
  }

  async accept(questId: number): Promise<{ finishable: boolean }> {
    const json = await this.client.remoteCall('quest', 'accept_quest', { quest_id: questId });
    if (json.error) throw new Error(json.msg ?? 'Could not accept the quest');
    return { finishable: !!json.finishable };
  }

  async finish(questId: number, rewardOption?: number): Promise<{ msg: string; health?: number; rewards: string[] }> {
    const json = await this.client.remoteCall('quest', 'finish_quest', { quest_id: questId, reward_option_id: rewardOption });
    if (json.error) throw new Error(json.msg ?? 'Could not finish the quest');
    const rewards: string[] = [];
    for (const r of Array.isArray(json.allRewards) ? json.allRewards : Object.values(json.allRewards ?? {})) {
      const t = rewardText(r as any, this.itemName).text;
      if (t) rewards.push(t);
    }
    return { msg: plainText(json.msg ?? ''), health: typeof json.health === 'number' ? json.health : undefined, rewards };
  }

  async cancel(questId: number): Promise<void> {
    const json = await this.client.remoteCall('quest', 'cancel_quest', { quest_id: questId });
    if (json.error) throw new Error(json.msg ?? 'Could not cancel the quest');
  }
}
