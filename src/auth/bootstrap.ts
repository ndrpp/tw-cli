import { isObj, type JsonObject } from '../util/json.ts';
// Parses the initial state game.php embeds as inline calls, e.g.
//   Game.init({...});  Player.init({"h":"688885",...});  Character.init({"playerId":...});
// (game.php @4198, @90170, @105241). Arguments are JSON object literals; we find the call, then scan
// to the matching closing brace while respecting string literals, and JSON.parse the slice.

/** The parsed argument, or null when the call is missing or its argument is not JSON. */
export function extractInitArg(html: string, call: string): unknown {
  const at = html.indexOf(call + '(');
  if (at < 0) return null;
  let i = at + call.length + 1;
  while (i < html.length && /\s/.test(html[i]!)) i++;
  if (html[i] !== '{' && html[i] !== '[') return null;
  const start = i;
  let depth = 0;
  let inStr: string | null = null;
  for (; i < html.length; i++) {
    const ch = html[i]!;
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface Bootstrap {
  h: string;
  game: JsonObject | null;
  player: JsonObject;
  character: JsonObject | null;
  premium: JsonObject | null;
  /** Bag.init({bag, wear, setItems, itemCooldown, itemLifetime}) */
  bag: JsonObject | null;
}

export class BootstrapError extends Error {}

export function parseBootstrap(html: string): Bootstrap {
  const init = (call: string) => {
    const v = extractInitArg(html, call);
    return isObj(v) ? v : null;
  };
  const player = init('Player.init');
  const h = typeof player?.h === 'string' ? player.h : null;
  if (!player || !h || !/^[0-9a-f]{4,32}$/i.test(h)) {
    throw new BootstrapError('game.php did not contain Player.init({h:…}); not logged in or the page format changed');
  }
  return {
    h,
    player,
    game: init('Game.init'),
    character: init('Character.init'),
    premium: init('Premium.init'),
    bag: init('Bag.init'),
  };
}
