// Server clock, mirroring Game.syncTime (tw2game @611263):
//   drift = now - serverTime - responseTime + 1000;  ServerDate = now - drift
// Initialised from Game.init.sincepoch (page generation time), then refined with POST /ntp.php
// which returns the server's epoch in ms (e.g. "1793696397817.7").
import type { GameClient } from '../http/game-client.ts';
import { send } from '../http/game-client.ts';

export class ServerClock {
  driftMs = 0;

  constructor(sincepochSec?: number) {
    if (sincepochSec) {
      this.driftMs = Date.now() - sincepochSec * 1000;
    }
  }

  /** Server time in ms. */
  nowMs(): number {
    return Date.now() - this.driftMs;
  }

  /** Server time in seconds (Game.getServerTime). */
  now(): number {
    return this.nowMs() / 1000;
  }

  async sync(client: GameClient): Promise<void> {
    const start = Date.now();
    const res = await send(
      client.jar,
      client.identity,
      `${client.worldUrl}/ntp.php`,
      {
        method: 'POST',
        body: '',
        ajax: true,
        referer: `${client.worldUrl}/game.php`,
        origin: client.worldUrl,
      },
      client.policy,
    );
    const serverMs = Number((await res.text()).trim());
    if (!Number.isFinite(serverMs)) {
      return;
    }
    const rtt = Date.now() - start;
    this.driftMs = Date.now() - serverMs - rtt + 1000;
  }
}
