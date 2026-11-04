// Mail screen (g r): reports and telegrams. Read, delete, reply, write.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { REPORT_FOLDERS, type Report, type Telegram } from '../game/mail.ts';
import type { ScreenProps } from './character.ts';
import { scrollWindow, truncate } from './format.ts';
import { formKey, formValues, FormView, makeForm, wrap, type FormState } from './form.ts';
import { defined } from '../util/defined.ts';

const h = React.createElement;

type Tab = 'reports' | 'telegrams';
type Opened = { kind: 'report'; report: Report } | { kind: 'telegram'; telegram: Telegram } | null;
type Pending = { kind: 'reply'; id: number } | { kind: 'new' } | null;

export function MailScreen({ state, width, height, onCapture, onExit, active = true }: ScreenProps) {
  const [tab, setTab] = useState<Tab>(state.unread.messages && !state.unread.reports ? 'telegrams' : 'reports');
  const [sel, setSel] = useState(0);
  const [opened, setOpened] = useState<Opened>(null);
  const [scroll, setScroll] = useState(0);
  /** l / Enter: j k scroll the open message instead of moving in the list. */
  const [detail, setDetail] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void (async () => {
      await state.loadReports(1);
      await state.loadTelegrams(1);
    })();
  }, [state]);
  useEffect(() => {
    onCapture(!!form || confirmDelete);
  }, [form, confirmDelete]);

  const reports = state.reports?.reports ?? [];
  const telegrams = state.telegrams?.telegrams ?? [];
  const count = tab === 'reports' ? reports.length : telegrams.length;
  const idx = Math.min(sel, Math.max(0, count - 1));
  const list = tab === 'reports' ? state.reports : state.telegrams;

  const open = async (i: number) => {
    setScroll(0);
    if (tab === 'reports') {
      const row = reports[i];
      if (!row) return;
      const r = await state.openReport(row);
      if (r) setOpened({ kind: 'report', report: r });
    } else {
      const row = telegrams[i];
      if (!row) return;
      const t = await state.openTelegram(row.id);
      if (t) setOpened({ kind: 'telegram', telegram: t });
    }
  };

  const newTelegram = (to = '', subject = '') => {
    setPending({ kind: 'new' });
    setForm(makeForm('New telegram', [
      { key: 'to', label: 'To', value: to, hint: 'names, separated by ;' },
      { key: 'subject', label: 'Subject', value: subject },
      { key: 'text', label: 'Text', value: '', hint: 'at least 3 characters' },
    ]));
  };

  useInput((input, key) => {
    if (form) {
      const r = formKey(form, input, key);
      if (r === 'cancel') return (setForm(null), setPending(null));
      if (r !== 'submit') return setForm(r);
      const v = formValues(form);
      const p = pending;
      setForm(null);
      setPending(null);
      if (p?.kind === 'reply') {
        void state.replyTelegram(p.id, v.text ?? '').then(async (ok) => {
          if (!ok) return;
          const t = await state.openTelegram(p.id);
          if (t) setOpened({ kind: 'telegram', telegram: t });
        });
      } else if (p?.kind === 'new') void state.sendTelegram(v.to ?? '', v.subject ?? '', v.text ?? '');
      return;
    }
    if (confirmDelete) {
      setConfirmDelete(false);
      if (input !== 'y') return;
      if (tab === 'reports' && reports[idx]) void state.deleteReport(reports[idx]!);
      if (tab === 'telegrams' && telegrams[idx]) void state.deleteTelegram(telegrams[idx]!.id);
      setOpened(null);
      return;
    }
    if (detail && input === 'h') return setDetail(false);
    if (key.escape) {
      setDetail(false);
      if (opened) return setOpened(null);
      return onExit();
    }
    if (key.tab || key.leftArrow || key.rightArrow) {
      setSel(0);
      setOpened(null);
      setDetail(false);
      return setTab((t) => (t === 'reports' ? 'telegrams' : 'reports'));
    }
    const step = key.pageUp || key.pageDown ? 10 : 1;
    if (detail) {
      if (key.upArrow || input === 'k' || key.pageUp) return setScroll((s) => Math.max(0, s - step));
      if (key.downArrow || input === 'j' || key.pageDown) return setScroll((s) => s + step);
    }
    if (key.upArrow || input === 'k' || key.pageUp) return (setSel(Math.max(0, idx - step)), setOpened(null));
    if (key.downArrow || input === 'j' || key.pageDown) return (setSel(Math.min(count - 1, idx + step)), setOpened(null));
    if (key.return || input === 'l') {
      if (!count) return;
      setDetail(true);
      if (!opened || key.return) return void open(idx);
      return;
    }
    // Kitty-protocol terminals report Shift+, / Shift+. as the base keys with the shift flag.
    const nextPage = input === '>' || (key.shift && input === '.');
    const prevPage = input === '<' || (key.shift && input === ',');
    if (nextPage || prevPage) {
      const page = (list?.page ?? 1) + (nextPage ? 1 : -1);
      if (page < 1 || page > (list?.pages ?? 1)) return;
      setSel(0);
      setOpened(null);
      setDetail(false);
      return void (tab === 'reports' ? state.loadReports(page) : state.loadTelegrams(page));
    }
    if (input === 'f' && tab === 'reports') {
      const i = REPORT_FOLDERS.findIndex((f) => f.key === state.reportFolder);
      setSel(0);
      setOpened(null);
      return void state.loadReports(1, REPORT_FOLDERS[(i + 1) % REPORT_FOLDERS.length]!.key);
    }
    if (input === 'd' && count) return setConfirmDelete(true);
    if (input === 'n') return newTelegram();
    if (input === 'R' && tab === 'telegrams') {
      const id = opened?.kind === 'telegram' ? opened.telegram.id : telegrams[idx]?.id;
      if (!id) return;
      setPending({ kind: 'reply', id });
      return setForm(makeForm(`Reply: ${opened?.kind === 'telegram' ? opened.telegram.subject : telegrams[idx]?.subject ?? ''}`, [{ key: 'text', label: 'Text', value: '' }]));
    }
  }, { isActive: active });

  const leftW = Math.max(30, Math.floor(width * 0.45));
  const rightW = width - leftW;
  const listRows = Math.max(2, height - 4);
  const [start, end] = scrollWindow(idx, count, listRows);
  const tabs = (['reports', 'telegrams'] as Tab[]).map((t) => {
    const unread = t === 'reports' ? state.unread.reports : state.unread.messages;
    return h(Text, defined({ key: t, inverse: tab === t, bold: tab === t, color: tab === t ? 'cyan' : undefined }), ` ${t === 'reports' ? 'Reports' : 'Telegrams'}${unread ? ' •' : ''} `);
  });
  const folder = REPORT_FOLDERS.find((f) => f.key === state.reportFolder)?.label ?? 'All';
  const sub = tab === 'reports'
    ? `${folder} (f) · page ${list?.page ?? 1}/${list?.pages ?? 1} (< >)`
    : `page ${list?.page ?? 1}/${list?.pages ?? 1} (< >) · n new`;
  const rows = tab === 'reports'
    ? reports.slice(start, end).map((r, i) => h(Text, { key: r.id, inverse: start + i === idx, bold: !r.read, wrap: 'truncate' },
      `${r.read ? ' ' : '•'} ${truncate(r.title, leftW - 19)} `, h(Text, { dimColor: true }, truncate(r.date, 12))))
    : telegrams.slice(start, end).map((t, i) => h(Text, { key: t.id, inverse: start + i === idx, bold: t.unread, wrap: 'truncate' },
      `${t.unread ? '•' : t.answered ? '↩' : ' '} ${truncate(t.subject, leftW - 30)} `,
      h(Text, { color: 'magenta' }, truncate(t.partners.length ? t.partners.join(', ') : 'System', 12)), ' ',
      h(Text, { dimColor: true }, truncate(t.date, 10))));
  const left = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: detail ? 'gray' : 'cyan', width: leftW, height, paddingX: 1 },
    h(Text, { wrap: 'truncate' }, ...tabs, h(Text, { dimColor: true }, ' Tab')),
    h(Text, { dimColor: true, wrap: 'truncate' }, sub),
    ...rows,
    count === 0 ? h(Text, { dimColor: true }, list ? 'Nothing here.' : 'Loading…') : null,
  );

  const dw = Math.max(10, rightW - 4);
  let lines: React.ReactNode[] = [];
  let maxTop = 0;
  if (form) lines = [h(FormView, { key: 'form', form, width: rightW - 2 })];
  else if (opened?.kind === 'report') {
    const r = opened.report;
    const body = wrap(r.text, dw);
    const room = Math.max(1, height - 6);
    maxTop = Math.max(0, body.length - room);
    const top = Math.min(scroll, maxTop);
    lines = [
      h(Text, { key: 't', bold: true, wrap: 'truncate' }, r.title),
      h(Text, { key: 'd', dimColor: true, wrap: 'truncate' }, `${r.date}${r.type ? ` · ${r.type}` : ''}`),
      ...body.slice(top, top + room).map((l, i) => h(Text, { key: i }, l || ' ')),
    ];
  } else if (opened?.kind === 'telegram') {
    const t = opened.telegram;
    const body = t.posts.flatMap((p) => [`▸ ${p.from} · ${p.date}`, ...wrap(p.text, dw), '']);
    const room = Math.max(1, height - 6);
    maxTop = Math.max(0, body.length - room);
    const top = Math.min(scroll, maxTop);
    lines = [
      h(Text, { key: 't', bold: true, wrap: 'truncate' }, t.subject),
      h(Text, { key: 'd', dimColor: true, wrap: 'truncate' }, `${t.posts.length} post(s)${t.pages > 1 ? ` · page ${t.page + 1}/${t.pages}` : ''}`),
      ...body.slice(top, top + room).map((l, i) => h(Text, defined({ key: i, color: l.startsWith('▸ ') ? 'magenta' : undefined }), l || ' ')),
    ];
  } else {
    const cur = tab === 'reports' ? reports[idx] : null;
    lines = [h(Text, { key: 'h', dimColor: true }, count ? 'Enter: read' : '')];
    if (cur?.summary) lines.push(...wrap(cur.summary, dw).slice(0, height - 6).map((l, i) => h(Text, { key: `s${i}`, dimColor: true }, l)));
  }
  // Scrolling past the end would leave j/k with nothing to undo.
  useEffect(() => {
    if (scroll > maxTop) setScroll(maxTop);
  });
  const keys = confirmDelete
    ? h(Text, { color: 'red', wrap: 'truncate' }, `Delete this ${tab === 'reports' ? 'report' : 'telegram'}? y / n`)
    : h(Text, { dimColor: true, wrap: 'truncate' }, `${detail ? 'j k scroll · h list' : 'Enter read'} · d delete${tab === 'telegrams' ? ' · R reply' : ''} · n new telegram · Esc back`);
  const right = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: detail ? 'cyan' : 'gray', width: rightW, height, paddingX: 1 },
    ...lines, h(Box, { flexGrow: 1 }), keys);
  return h(Box, { width, height }, left, right);
}
