#!/usr/bin/env node
// Entry point. Commands:
//   tw fp import <file>   validate a captured fingerprint profile and install it
//   tw fp set <hash>      save a hash-only fingerprint (copied from the browser console)
//   tw fp ua "<UA>" [langs] set the browser User-Agent (and languages, e.g. en-US,en)
//   tw fp show            show the installed profile summary
//   tw login              log in (prompts for name/password unless TW_LOGIN_NAME/PASSWORD set)
//   tw whoami             show character status (reuses the saved session)
//   tw [play]             full-screen TUI (setup, jobs, task queue, map)
//   tw web                local browser page for fingerprint capture and login
//   tw jobs [filter]      list doable jobs with nearest location and travel time
//   tw queue              show the task queue
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { loadProfile, readProfileRaw, writeProfileFields } from './fingerprint/profile.ts';
import { DEFAULT_WORLD, ensureGame } from './auth/session.ts';
import { PROFILE_FILE } from './auth/session-store.ts';
import type { Credentials } from './auth/login.ts';
import { GameState } from './game/state.ts';
import { formatDuration } from './tui/format.ts';

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      (rl as any)._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function promptCredentials(): Promise<Credentials> {
  const name = await ask('Account name: ');
  const password = await ask('Password: ', true);
  return { name, password };
}

const log = (m: string) => console.error(m);

async function openState(): Promise<GameState> {
  const game = await ensureGame({ credentials: promptCredentials, log });
  return new GameState(game, () => ensureGame({ credentials: promptCredentials }));
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, arg] = argv;
  switch (cmd) {
    case undefined:
    case 'play': {
      // Setup (fingerprint, login) happens inside the TUI when needed.
      const { runRoot } = await import('./tui/root.ts');
      await runRoot();
      return 0;
    }
    case 'web': {
      const { defaultWebAddress, startWebServer } = await import('./web/server.ts');
      const addr = defaultWebAddress();
      const srv = await startWebServer({ ...addr, exitAfterLogin: true, log: (m) => console.log(m) });
      console.log(`Open in your browser:\n  ${srv.url}\n`);
      if (addr.host === '0.0.0.0') {
        console.log(`(In a container: port ${addr.port} must be published to the host, e.g. compose ports "127.0.0.1:${addr.port}:${addr.port}" and run with --service-ports.)`);
      }
      console.log('Waiting for fingerprint and login… Ctrl+C to stop.');
      await srv.done;
      await srv.close();
      return 0;
    }
    case 'jobs': {
      const state = await openState();
      await state.loadJobs();
      for (const e of state.log.filter((l) => l.level === 'error')) console.error(e.msg);
      for (const o of state.jobOptions(sub ?? '')) {
        const pts = o.job.laborPoints;
        console.log(`${String(o.job.id).padStart(4)}  ${o.job.name.padEnd(36)} ${String(pts).padStart(5)} LP  ${o.at ? `${o.at.x},${o.at.y}`.padEnd(12) : '—'.padEnd(12)} ${o.way === null ? '' : formatDuration(o.way)}`);
      }
      return 0;
    }
    case 'queue': {
      const state = await openState();
      const now = state.clock.now();
      if (!state.queue.length) console.log('Task queue is empty.');
      state.queue.forEach((t, i) => console.log(`${i + 1}. [${t.type}] ${t.title} at ${t.coords.x},${t.coords.y}  ends in ${formatDuration(t.end - now)}`));
      return 0;
    }
    case 'fp': {
      if (sub === 'import' && arg) {
        const p = loadProfile(arg); // validates (recomputes hash)
        mkdirSync(dirname(PROFILE_FILE), { recursive: true, mode: 0o700 });
        copyFileSync(arg, PROFILE_FILE);
        chmodSync(PROFILE_FILE, 0o600);
        console.log(`Fingerprint profile OK (fp=${p.fp}, ${p.components.length} components). Installed to ${PROFILE_FILE}`);
        return 0;
      }
      if (sub === 'set' && arg) {
        const p = writeProfileFields(PROFILE_FILE, { fp: arg.trim().toLowerCase() });
        console.log(`Saved fingerprint ${p.fp} (hash-only) to ${PROFILE_FILE}`);
        if (!p.userAgent) console.log('Next: tw fp ua "<navigator.userAgent from the same browser>"');
        return 0;
      }
      if (sub === 'ua' && arg) {
        const langs = argv[3] ? argv[3].split(',').map((l) => l.trim()).filter(Boolean) : undefined;
        writeProfileFields(PROFILE_FILE, { userAgent: arg, ...(langs ? { languages: langs } : {}) });
        console.log(`Saved User-Agent${langs ? ' and languages' : ''} to ${PROFILE_FILE}`);
        return 0;
      }
      if (sub === 'show') {
        const p = readProfileRaw(PROFILE_FILE);
        if (!p) throw new Error(`No fingerprint profile at ${PROFILE_FILE}`);
        const comps = p.components?.length ? p.components.map((c) => c.key).join(',') : '(none: hash-only, not re-verifiable)';
        console.log(`fp=${p.fp}\nsaved=${p.capturedAt}\nuserAgent=${p.userAgent || '(missing)'}\nlanguages=${(p.languages ?? []).join(',')}\ncomponents=${comps}`);
        return 0;
      }
      break;
    }
    case 'login': {
      const game = await ensureGame({ forceLogin: true, credentials: promptCredentials, log });
      console.log(`Logged in to ${DEFAULT_WORLD.url} as ${game.bootstrap.character?.name ?? '?'}`);
      return 0;
    }
    case 'whoami':
    case 'status': {
      const { bootstrap } = await ensureGame({ credentials: promptCredentials, log });
      const c = bootstrap.character ?? {};
      console.log(
        [
          `${c.name} (level ${c.level}, ${c.charClass?.type ?? '?'}) on ${bootstrap.game?.currentWorldName ?? DEFAULT_WORLD.url}`,
          `HP ${c.health}/${c.maxHealth ?? '?'}  Energy ${c.energy}/${c.maxEnergy}  XP ${c.experience}`,
          `$${c.cash} cash, $${c.deposit} bank  Nuggets ${c.nuggets}`,
          `Position ${c.pos?.x},${c.pos?.y}  Tasks queued ${Array.isArray(c.taskQueue) ? c.taskQueue.length : '?'}/${c.taskLimit}`,
        ].join('\n'),
      );
      return 0;
    }
  }
  console.error('usage: tw [play] | tw web | tw jobs [filter] | tw queue | tw login | tw whoami | tw fp import <file> | tw fp set <hash> | tw fp ua "<UA>" [langs] | tw fp show');
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
