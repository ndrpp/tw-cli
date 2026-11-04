// Lists every game.php request the web client can make (Ajax.remoteCall / remoteCallMode / get /
// gameServiceRequest) from tw2game.<locale>.js, with the form fields and the enclosing function.
// Usage: node scripts/extract-endpoints.ts [path/to/tw2game.js] [out.json]
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2] ?? '../en32.the_west.net/en32.the-west.net/cache/tw2game.en_DK.js';
const out = process.argv[3] ?? 'docs/endpoints.json';
const s = readFileSync(src, 'utf8');

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

/** Reads one JS argument starting at i (balanced brackets, skips strings); returns [text, next index]. */
function readArg(i: number): [string, number] {
  let depth = 0;
  const start = i;
  while (i < s.length) {
    const c = s[i] ?? '';
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) i += s[i] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) return [s.slice(start, i).trim(), i];
      depth--;
    } else if (c === ',' && depth === 0) return [s.slice(start, i).trim(), i];
    i++;
  }
  return [s.slice(start).trim(), i];
}

const str = (a: string) => /^(['"])(.*)\1$/.exec(a)?.[2] ?? `<${a}>`;

/** Top-level keys of an object literal argument. */
function keys(a: string): string[] | null {
  if (!a.startsWith('{')) return null;
  const body = a.slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let tok = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? '';
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < body.length && body[j] !== q) j += body[j] === '\\' ? 2 : 1;
      if (depth === 0) tok += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if (depth === 0 && c === ':') {
      const k = tok.trim().replace(/^['"]|['"]$/g, '');
      if (k) out.push(k);
      tok = '';
      continue;
    } else if (depth === 0 && c === ',') {
      tok = '';
      continue;
    }
    if (depth === 0) tok += c;
  }
  return out;
}

/** Nearest preceding "name:function(" / "name=function(" / "function name(" as a rough location. */
function context(offset: number): string {
  const back = s.slice(Math.max(0, offset - 4000), offset);
  const re = /([A-Za-z_$][\w$.]*)\s*[:=]\s*function\s*\(|function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let last = '';
  for (let m = re.exec(back); m; m = re.exec(back)) last = m[1] ?? m[2] ?? last;
  return last;
}

const endpoints = new Map<string, Endpoint>();
const re = /Ajax\.(remoteCall|remoteCallMode|get|gameServiceRequest)\(/g;
for (let m = re.exec(s); m; m = re.exec(s)) {
  const i = m.index + m[0].length;
  const [w, i1] = readArg(i);
  let action = '';
  let fields: string[] | null = null;
  if (m[1] === 'gameServiceRequest') {
    action = '';
    const [d] = readArg(i1 + 1);
    fields = keys(d);
  } else {
    const [a, i2] = readArg(i1 + 1);
    action = str(a);
    const [d] = s[i2] === ',' ? readArg(i2 + 1) : [''];
    fields = keys(d);
  }
  const kind = m[1] ?? '';
  const key = `${kind} ${str(w)} ${action}`;
  const e = endpoints.get(key) ?? { kind, window: str(w), action, sites: [] };
  e.sites.push({ offset: m.index, context: context(m.index), fields });
  endpoints.set(key, e);
}
const list = [...endpoints.values()].sort(
  (a, b) => a.window.localeCompare(b.window) || a.action.localeCompare(b.action),
);
writeFileSync(
  out,
  `${JSON.stringify({ source: src.split('/').pop(), count: list.length, endpoints: list }, null, 1)}\n`,
);
console.log(`${list.length} endpoints (${list.reduce((n, e) => n + e.sites.length, 0)} call sites) → ${out}`);
