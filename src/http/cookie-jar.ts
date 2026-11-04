// Browser-like cookie jar (ported from tw-market src/lib/market/login.ts): host-only vs domain
// cookies, foreign-domain cookies dropped, deletion via Max-Age<=0 / past Expires. Serialisable so a
// session can be persisted between CLI runs.

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  /** epoch ms; undefined = session cookie */
  expires?: number;
}

export class CookieJar {
  private cookies = new Map<string, Cookie>();

  static fromJSON(list: Cookie[]): CookieJar {
    const jar = new CookieJar();
    for (const c of list) jar.cookies.set(`${c.domain}|${c.name}`, c);
    return jar;
  }

  toJSON(): Cookie[] {
    this.purgeExpired();
    return [...this.cookies.values()];
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, c] of this.cookies) if (c.expires !== undefined && c.expires <= now) this.cookies.delete(id);
  }

  store(url: string, res: Response): void {
    const host = new URL(url).hostname;
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const c: Cookie = {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: host,
        hostOnly: true,
      };
      let expired = false;
      let foreign = false;
      for (const attr of attrs) {
        const i = attr.indexOf('=');
        const k = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? '' : attr.slice(i + 1).trim();
        if (k === 'domain' && v) {
          const d = v.replace(/^\./, '').toLowerCase();
          if (host === d || host.endsWith(`.${d}`)) Object.assign(c, { domain: d, hostOnly: false });
          else foreign = true;
        } else if (k === 'max-age') {
          const secs = Number(v);
          if (secs <= 0) expired = true;
          else if (Number.isFinite(secs)) c.expires = Date.now() + secs * 1000;
        } else if (k === 'expires' && c.expires === undefined) {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) {
            if (t < Date.now()) expired = true;
            else c.expires = t;
          }
        }
      }
      if (foreign) continue;
      const id = `${c.domain}|${c.name}`;
      if (expired) this.cookies.delete(id);
      else this.cookies.set(id, c);
    }
  }

  header(url: string): string {
    this.purgeExpired();
    const host = new URL(url).hostname;
    return [...this.cookies.values()]
      .filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`)))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
}
