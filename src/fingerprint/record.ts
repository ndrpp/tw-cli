// Sends the fingerprint the way game.php's fp-script does after page load:
//   Ajax.remoteCall('anti_cheat', 'record_fp', { fp, gv: undefined, wd: navigator.webdriver })
// jQuery serialises that as  fp=<hash>&gv=&wd=false  (undefined -> empty string).
import type { GameClient } from '../http/game-client.ts';
import type { FingerprintProfile } from './profile.ts';

export function recordFpPayload(profile: FingerprintProfile) {
  return { fp: profile.fp, gv: undefined, wd: profile.webdriver };
}

/** Call once per fresh game session, right after bootstrap (the browser does it on idle after load). */
export async function recordFingerprint(client: GameClient, profile: FingerprintProfile): Promise<unknown> {
  return client.remoteCall('anti_cheat', 'record_fp', recordFpPayload(profile));
}
