// Links in chat messages. The browser turns "[item=<id>]" (instance id, base · 1000 + upgrade) and
// "[quest=<id>]" into clickable names; we replace them with the name and a colour. The quest tag form
// is unverified (no bundle to check against); unknown tags are left as they are.
/** A run of text with its own colour (Ink colour name). */
export interface Segment {
  text: string;
  color?: string | undefined;
}

export interface ChatLinkNames {
  item: (id: number) => { name: string; set?: boolean };
  /** Title of a quest we know (log, open employer); undefined when we don't. */
  quest: (id: number) => string | undefined;
}

export function chatSegments(text: string, names: ChatLinkNames, color?: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const match of text.matchAll(/\[(item|quest)=(\d+)\]/g)) {
    if (match.index > at) out.push({ text: text.slice(at, match.index), color });
    const id = Number(match[2]);
    if (match[1] === 'item') {
      const it = names.item(id);
      out.push({ text: `[${it.name}]`, color: it.set ? 'greenBright' : 'yellow' });
    } else out.push({ text: `[${names.quest(id) ?? `quest ${id}`}]`, color: 'magentaBright' });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), color });
  return out;
}
