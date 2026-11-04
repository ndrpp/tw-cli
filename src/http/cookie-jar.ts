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

  static fromJSON(cookies: Cookie[]): CookieJar {
    const jar = new CookieJar();
    for (const cookie of cookies) {
      jar.cookies.set(`${cookie.domain}|${cookie.name}`, cookie);
    }
    return jar;
  }

  toJSON(): Cookie[] {
    this.purgeExpired();
    return [...this.cookies.values()];
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, cookie] of this.cookies) {
      if (cookie.expires !== undefined && cookie.expires <= now) {
        this.cookies.delete(id);
      }
    }
  }

  store(url: string, res: Response): void {
    const host = new URL(url).hostname;
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const cookie: Cookie = {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        domain: host,
        hostOnly: true,
      };
      let expired = false;
      let foreign = false;
      for (const attribute of attrs) {
        const separator = attribute.indexOf('=');
        const attributeName = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
        const attributeValue = separator < 0 ? '' : attribute.slice(separator + 1).trim();
        if (attributeName === 'domain' && attributeValue) {
          const domain = attributeValue.replace(/^\./, '').toLowerCase();
          if (host === domain || host.endsWith(`.${domain}`)) {
            Object.assign(cookie, { domain, hostOnly: false });
          } else {
            foreign = true;
          }
        } else if (attributeName === 'max-age') {
          const seconds = Number(attributeValue);
          if (seconds <= 0) {
            expired = true;
          } else if (Number.isFinite(seconds)) {
            cookie.expires = Date.now() + seconds * 1000;
          }
        } else if (attributeName === 'expires' && cookie.expires === undefined) {
          const expiresAt = Date.parse(attributeValue);
          if (!Number.isNaN(expiresAt)) {
            if (expiresAt < Date.now()) {
              expired = true;
            } else {
              cookie.expires = expiresAt;
            }
          }
        }
      }
      if (foreign) {
        continue;
      }
      const id = `${cookie.domain}|${cookie.name}`;
      if (expired) {
        this.cookies.delete(id);
      } else {
        this.cookies.set(id, cookie);
      }
    }
  }

  header(url: string): string {
    this.purgeExpired();
    const host = new URL(url).hostname;
    return [...this.cookies.values()]
      .filter((cookie) =>
        cookie.hostOnly ? host === cookie.domain : host === cookie.domain || host.endsWith(`.${cookie.domain}`),
      )
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }
}
