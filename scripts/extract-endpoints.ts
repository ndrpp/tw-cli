// Lists every game.php request the web client can make (Ajax.remoteCall / remoteCallMode / get /
// gameServiceRequest) from tw2game.<locale>.js, with the form fields and the enclosing function.
// Usage: node scripts/extract-endpoints.ts [path/to/tw2game.js] [out.json]
import { readFileSync, writeFileSync } from 'node:fs';

const sourcePath = process.argv[2] ?? '../en32.the_west.net/en32.the-west.net/cache/tw2game.en_DK.js';
const outputPath = process.argv[3] ?? 'docs/endpoints.json';
const source = readFileSync(sourcePath, 'utf8');

interface Site {
  offset: number;
  context: string;
  fields: string[] | null;
}
interface Endpoint {
  kind: string;
  window: string;
  action: string;
  sites: Site[];
}

/** Reads one JS argument starting at `index` (balanced brackets, skips strings); returns [text, next index]. */
function readArgument(index: number): [string, number] {
  let depth = 0;
  const start = index;
  while (index < source.length) {
    const character = source[index] ?? '';
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      index++;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === '\\' ? 2 : 1;
      }
    } else if (character === '(' || character === '{' || character === '[') {
      depth++;
    } else if (character === ')' || character === '}' || character === ']') {
      if (depth === 0) {
        return [source.slice(start, index).trim(), index];
      }
      depth--;
    } else if (character === ',' && depth === 0) {
      return [source.slice(start, index).trim(), index];
    }
    index++;
  }
  return [source.slice(start).trim(), index];
}

const unquote = (argument: string) => /^(['"])(.*)\1$/.exec(argument)?.[2] ?? `<${argument}>`;

/** Top-level keys of an object literal argument. */
function topLevelKeys(argument: string): string[] | null {
  if (!argument.startsWith('{')) {
    return null;
  }
  const body = argument.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;
  let token = '';
  for (let index = 0; index < body.length; index++) {
    const character = body[index] ?? '';
    if (character === '"' || character === "'") {
      const quote = character;
      let close = index + 1;
      while (close < body.length && body[close] !== quote) {
        close += body[close] === '\\' ? 2 : 1;
      }
      if (depth === 0) {
        token += body.slice(index, close + 1);
      }
      index = close;
      continue;
    }
    if ('({['.includes(character)) {
      depth++;
    } else if (')}]'.includes(character)) {
      depth--;
    } else if (depth === 0 && character === ':') {
      const key = token.trim().replace(/^['"]|['"]$/g, '');
      if (key) {
        keys.push(key);
      }
      token = '';
      continue;
    } else if (depth === 0 && character === ',') {
      token = '';
      continue;
    }
    if (depth === 0) {
      token += character;
    }
  }
  return keys;
}

/** Nearest preceding "name:function(" / "name=function(" / "function name(" as a rough location. */
function enclosingName(offset: number): string {
  const before = source.slice(Math.max(0, offset - 4_000), offset);
  const pattern = /([A-Za-z_$][\w$.]*)\s*[:=]\s*function\s*\(|function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let last = '';
  for (let match = pattern.exec(before); match; match = pattern.exec(before)) {
    last = match[1] ?? match[2] ?? last;
  }
  return last;
}

const endpoints = new Map<string, Endpoint>();
const callPattern = /Ajax\.(remoteCall|remoteCallMode|get|gameServiceRequest)\(/g;
for (let match = callPattern.exec(source); match; match = callPattern.exec(source)) {
  const index = match.index + match[0].length;
  const [windowArgument, afterWindow] = readArgument(index);
  let action = '';
  let fields: string[] | null = null;
  if (match[1] === 'gameServiceRequest') {
    action = '';
    const [dataArgument] = readArgument(afterWindow + 1);
    fields = topLevelKeys(dataArgument);
  } else {
    const [actionArgument, afterAction] = readArgument(afterWindow + 1);
    action = unquote(actionArgument);
    const [dataArgument] = source[afterAction] === ',' ? readArgument(afterAction + 1) : [''];
    fields = topLevelKeys(dataArgument);
  }
  const kind = match[1] ?? '';
  const window = unquote(windowArgument);
  const key = `${kind} ${window} ${action}`;
  const endpoint = endpoints.get(key) ?? { kind, window, action, sites: [] };
  endpoint.sites.push({ offset: match.index, context: enclosingName(match.index), fields });
  endpoints.set(key, endpoint);
}
const list = [...endpoints.values()].sort(
  (first, second) => first.window.localeCompare(second.window) || first.action.localeCompare(second.action),
);
writeFileSync(
  outputPath,
  `${JSON.stringify({ source: sourcePath.split('/').pop(), count: list.length, endpoints: list }, null, 1)}\n`,
);
console.log(
  `${list.length} endpoints (${list.reduce((total, endpoint) => total + endpoint.sites.length, 0)} call sites) → ${outputPath}`,
);
