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
import { entries, type JsonObject, obj, objs, vals } from '../util/json.ts';

/** jsInfo: inventory_changed / wear_changed {id: item, count}; task-finish-job {id: job, count: seconds}. */
/**
 * kind: item (have it: inventory_changed) · wear (wear it: wear_changed) · job (task-finish-job) · bought ("Item 'X'
 * bought", no jsInfo; `buy` is the name) · window ("This quest is only available between 06:00 and 11:00
 * o'clock.": finish inside those server hours) · other (anything else: wait timers, visits, duels, …).
 */
export interface QuestRequirement {
  solved: boolean;
  info: string;
  itemId?: number;
  jobId?: number;
  count?: number;
  kind?: 'item' | 'wear' | 'job' | 'bought' | 'window' | 'other';
  buy?: string;
  /** window: server hours, "HH:MM". */
  window?: { from: string; to: string };
}
export interface QuestReward {
  item: number | null;
  text: string;
}

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

/**
 * End of a time-limited quest from its `limited` text ("… until the 16.11.2026 at 12:00."), as epoch seconds
 * (read as UTC: the game's timezone is unverified), or null.
 */
export function questEnds(limited: string): number | null {
  const matchValue = limited.match(/until(?: the)? (\d{1,2})\.(\d{1,2})\.(\d{4})(?: at (\d{1,2}):(\d{2}))?/i);
  if (!matchValue) {
    return null;
  }
  return (
    Date.UTC(
      Number(matchValue[3]),
      Number(matchValue[2]) - 1,
      Number(matchValue[1]),
      Number(matchValue[4] ?? 23),
      Number(matchValue[5] ?? 59),
    ) / 1000
  );
}

export interface QuestEmployer {
  key: string;
  name: string;
  x: number | null;
  y: number | null;
  open: Quest[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  times: '×',
  middot: '·',
  deg: '°',
  euro: '€',
  pound: '£',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  aacute: 'á',
  agrave: 'à',
  acirc: 'â',
  atilde: 'ã',
  auml: 'ä',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  iacute: 'í',
  igrave: 'ì',
  icirc: 'î',
  iuml: 'ï',
  ntilde: 'ñ',
  oacute: 'ó',
  ograve: 'ò',
  ocirc: 'ô',
  otilde: 'õ',
  ouml: 'ö',
  oslash: 'ø',
  uacute: 'ú',
  ugrave: 'ù',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  yuml: 'ÿ',
  szlig: 'ß',
};

/** Decode numeric and common named HTML entities in one pass (no double decoding). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);?/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1]?.toLowerCase() === 'x';
      const codePoint = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (
        Number.isInteger(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return String.fromCodePoint(codePoint);
      }
      return match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** HTML → plain text for the terminal. `compact` drops blank lines (reports are field lists). */
/** The first game-formatted number in text ("1.234" or "1,234" → 1234); 0 when there is none. */
export const parseGameNumber = (text: string): number => Number(text.match(/[\d.,]+/)?.[0]?.replace(/[.,]/g, '') ?? 0);

export function plainText(html: unknown, opts: { compact?: boolean } = {}): string {
  const text = String(html ?? '')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(
      /<\/(?:p|div|li|tr|h[1-6]|table|thead|tbody|ul|ol|dl|dt|dd|blockquote|section|article|center|pre)\s*>/gi,
      '\n',
    )
    .replace(
      /<(?:p|div|li|tr|h[1-6]|table|thead|tbody|ul|ol|dl|dt|dd|blockquote|section|article|center|pre)(?:\s[^>]*)?>/gi,
      '\n',
    )
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\t+/g, '  ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(opts.compact ? /\n{2,}/g : /\n{3,}/g, opts.compact ? '\n' : '\n\n')
    .trim();
}

function rewardText(jsonValue: JsonObject, itemName?: (id: number) => string): QuestReward {
  const info = obj(jsonValue.info);
  if (jsonValue.isItem) {
    const id = Number(info.text);
    return { item: id, text: itemName ? itemName(id) : `item ${id}` };
  }
  const label = plainText(info.popup_text ?? info.css ?? '').replace(/^reward_/, '');
  return { item: null, text: `${plainText(info.text)} ${label}`.trim() };
}

function parseRequirement(jsonValue: JsonObject): QuestRequirement {
  const req: QuestRequirement = { solved: !!jsonValue.solved, info: plainText(jsonValue.info), kind: 'other' };
  const js = obj(jsonValue.jsInfo);
  if (js.id !== undefined) {
    if (js.type === 'inventory_changed' || js.type === 'wear_changed') {
      req.itemId = Number(js.id);
      req.kind = js.type === 'wear_changed' ? 'wear' : 'item';
    } else if (js.type === 'task-finish-job') {
      req.jobId = Number(js.id);
      req.kind = 'job';
    }
    if (js.count !== undefined) {
      req.count = Number(js.count);
    }
  }
  const bought = req.kind === 'other' ? req.info.match(/^Item '(.+)' bought$/i)?.[1] : undefined;
  if (bought) {
    req.kind = 'bought';
    req.buy = bought;
  }
  const window =
    req.kind === 'other' ? req.info.match(/only available between (\d{1,2}:\d{2}) and (\d{1,2}:\d{2})/i) : null;
  if (window) {
    req.kind = 'window';
    req.window = { from: window[1] ?? '', to: window[2] ?? '' };
  }
  return req;
}

export function parseQuest(jsonValue: JsonObject, itemName?: (id: number) => string): Quest {
  const coords =
    jsonValue.employer_coords && typeof jsonValue.employer_coords === 'object' ? obj(jsonValue.employer_coords) : null;
  return {
    id: Number(jsonValue.id),
    title: plainText(jsonValue.title),
    soloTitle: plainText(jsonValue.soloTitle ?? jsonValue.title),
    groupId: Number(jsonValue.group) || 0,
    group: plainText(jsonValue.groupTitle) || 'Other quests',
    employer: String(jsonValue.employer ?? ''),
    employerName: plainText(jsonValue.employer_name),
    employerAt: coords ? { x: Number(coords.x), y: Number(coords.y) } : null,
    accepted: !!jsonValue.accepted,
    acceptable: jsonValue.acceptable === undefined ? !jsonValue.accepted : !!jsonValue.acceptable,
    finishable: !!jsonValue.finishable,
    requirements: objs(jsonValue.requirements).map(parseRequirement),
    rewards: objs(jsonValue.questRewards)
      .filter((reward) => !reward.hidden)
      .map((reward) => rewardText(reward, itemName)),
    rewardOptions: entries(jsonValue.questRewardsOptions).map(([id, value]) => {
      const optionJson = obj(value);
      return {
        id: Number(optionJson.id ?? id),
        text: plainText(optionJson.title ?? optionJson.text ?? obj(optionJson.info).text ?? `option ${id}`),
      };
    }),
    description: plainText(jsonValue.description),
    hint: plainText(jsonValue.questHint),
    limited: plainText(jsonValue.limited),
  };
}

export interface QuestChain {
  groupId: number;
  title: string;
  quests: Quest[];
  finishable: number;
}

/** Quests grouped by chain, chains sorted by name; quests keep the server's order inside a chain. */
export function groupByChain(quests: Quest[]): QuestChain[] {
  const chains = new Map<string, QuestChain>();
  for (const quest of quests) {
    const key = quest.groupId ? `#${quest.groupId}` : quest.group;
    let entry = chains.get(key);
    if (!entry) {
      entry = { groupId: quest.groupId, title: quest.group, quests: [], finishable: 0 };
      chains.set(key, entry);
    }
    entry.quests.push(quest);
    if (quest.finishable) {
      entry.finishable++;
    }
  }
  return [...chains.values()].sort((first, second) =>
    first.title.localeCompare(second.title, 'en', { sensitivity: 'base' }),
  );
}

export class QuestApi {
  client: GameClient;
  itemName: ((id: number) => string) | undefined;

  constructor(client: GameClient, itemName?: (id: number) => string) {
    this.client = client;
    this.itemName = itemName;
  }

  async openQuests(): Promise<{ quests: Quest[]; capacity: number }> {
    const json = await this.client.remoteCallMode('building_quest', 'get_open_quests');
    if (json.error) {
      throw new Error(plainText(json.msg) || 'Quest log failed');
    }
    return {
      quests: objs(json.quests).map((jsonValue) => parseQuest(jsonValue, this.itemName)),
      capacity: Number(json.capacity) || 0,
    };
  }

  /** Quest givers in the saloon (no map position). */
  async saloon(): Promise<{ key: string; name: string }[]> {
    const json = await this.client.remoteCallMode('building_quest', '');
    if (json.error) {
      throw new Error(plainText(json.msg) || 'Saloon failed');
    }
    return objs(json.questEmployer)
      .filter((jsonValue) => jsonValue.key && jsonValue.key !== 'wallpaper_telekom')
      .map((jsonValue) => ({ key: String(jsonValue.key), name: plainText(jsonValue.name) }));
  }

  async employer(key: string, at?: { x: number; y: number } | null): Promise<QuestEmployer> {
    const json = await this.client.remoteCall('quest_employer', '', { employer: key, x: at?.x, y: at?.y });
    if (json.error) {
      throw new Error(typeof json.error === 'string' ? json.error : plainText(json.msg) || 'Quest giver failed');
    }
    const jsonValue = obj(json.employer);
    return {
      key: String(jsonValue.key ?? key),
      name: plainText(jsonValue.name ?? key),
      x: at?.x ?? null,
      y: at?.y ?? null,
      open: objs(jsonValue.open).map((openQuest) => parseQuest(openQuest, this.itemName)),
    };
  }

  async accept(questId: number): Promise<{ finishable: boolean }> {
    const json = await this.client.remoteCall('quest', 'accept_quest', { quest_id: questId });
    if (json.error) {
      throw new Error(plainText(json.msg) || 'Could not accept the quest');
    }
    return { finishable: !!json.finishable };
  }

  async finish(
    questId: number,
    rewardOption?: number,
  ): Promise<{ msg: string; health?: number | undefined; rewards: string[] }> {
    const json = await this.client.remoteCall('quest', 'finish_quest', {
      quest_id: questId,
      reward_option_id: rewardOption,
    });
    if (json.error) {
      throw new Error(plainText(json.msg) || 'Could not finish the quest');
    }
    const rewards: string[] = [];
    for (const result of vals(json.allRewards)) {
      const textValue = rewardText(obj(result), this.itemName).text;
      if (textValue) {
        rewards.push(textValue);
      }
    }
    return {
      msg: plainText(json.msg ?? ''),
      health: typeof json.health === 'number' ? json.health : undefined,
      rewards,
    };
  }

  async cancel(questId: number): Promise<void> {
    const json = await this.client.remoteCall('quest', 'cancel_quest', { quest_id: questId });
    if (json.error) {
      throw new Error(plainText(json.msg) || 'Could not cancel the quest');
    }
  }
}
