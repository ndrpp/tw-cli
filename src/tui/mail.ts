// Mail screen (g r): reports and telegrams. Read, delete, reply, write.

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import { REPORT_FOLDERS, type Report, type Telegram } from '../game/mail.ts';
import { defined } from '../util/defined.ts';
import type { ScreenProps } from './character.ts';
import { type FormState, FormView, formKey, formValues, makeForm, wrap } from './form.ts';
import { scrollWindow, truncate } from './format.ts';

const createElement = React.createElement;

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

  const open = async (index: number) => {
    setScroll(0);
    if (tab === 'reports') {
      const row = reports[index];
      if (!row) {
        return;
      }
      const reportInfo = await state.openReport(row);
      if (reportInfo) {
        setOpened({ kind: 'report', report: reportInfo });
      }
    } else {
      const row = telegrams[index];
      if (!row) {
        return;
      }
      const openedTelegram = await state.openTelegram(row.id);
      if (openedTelegram) {
        setOpened({ kind: 'telegram', telegram: openedTelegram });
      }
    }
  };

  const newTelegram = (to = '', subject = '') => {
    setPending({ kind: 'new' });
    setForm(
      makeForm('New telegram', [
        { key: 'to', label: 'To', value: to, hint: 'names, separated by ;' },
        { key: 'subject', label: 'Subject', value: subject },
        { key: 'text', label: 'Text', value: '', hint: 'at least 3 characters' },
      ]),
    );
  };

  useInput(
    (input, key) => {
      if (form) {
        const otherForm = formKey(form, input, key);
        if (otherForm === 'cancel') {
          setForm(null);
          return setPending(null);
        }
        if (otherForm !== 'submit') {
          return setForm(otherForm);
        }
        const value = formValues(form);
        const pick = pending;
        setForm(null);
        setPending(null);
        if (pick?.kind === 'reply') {
          void state.replyTelegram(pick.id, value.text ?? '').then(async (ok) => {
            if (!ok) {
              return;
            }
            const openedTelegram = await state.openTelegram(pick.id);
            if (openedTelegram) {
              setOpened({ kind: 'telegram', telegram: openedTelegram });
            }
          });
        } else if (pick?.kind === 'new') {
          void state.sendTelegram(value.to ?? '', value.subject ?? '', value.text ?? '');
        }
        return;
      }
      if (confirmDelete) {
        setConfirmDelete(false);
        if (input !== 'y') {
          return;
        }
        const report = reports[idx];
        if (tab === 'reports' && report) {
          void state.deleteReport(report);
        }
        const telegram = telegrams[idx];
        if (tab === 'telegrams' && telegram) {
          void state.deleteTelegram(telegram.id);
        }
        setOpened(null);
        return;
      }
      if (detail && input === 'h') {
        return setDetail(false);
      }
      if (key.escape) {
        setDetail(false);
        if (opened) {
          return setOpened(null);
        }
        return onExit();
      }
      if (key.tab || key.leftArrow || key.rightArrow) {
        setSel(0);
        setOpened(null);
        setDetail(false);
        return setTab((target) => (target === 'reports' ? 'telegrams' : 'reports'));
      }
      const step = key.pageUp || key.pageDown ? 10 : 1;
      if (detail) {
        if (key.upArrow || input === 'k' || key.pageUp) {
          return setScroll((value) => Math.max(0, value - step));
        }
        if (key.downArrow || input === 'j' || key.pageDown) {
          return setScroll((value) => value + step);
        }
      }
      if (key.upArrow || input === 'k' || key.pageUp) {
        setSel(Math.max(0, idx - step));
        return setOpened(null);
      }
      if (key.downArrow || input === 'j' || key.pageDown) {
        setSel(Math.min(count - 1, idx + step));
        return setOpened(null);
      }
      if (key.return || input === 'l') {
        if (!count) {
          return;
        }
        setDetail(true);
        if (!opened || key.return) {
          return void open(idx);
        }
        return;
      }
      // Kitty-protocol terminals report Shift+, / Shift+. as the base keys with the shift flag.
      const nextPage = input === '>' || (key.shift && input === '.');
      const prevPage = input === '<' || (key.shift && input === ',');
      if (nextPage || prevPage) {
        const page = (list?.page ?? 1) + (nextPage ? 1 : -1);
        if (page < 1 || page > (list?.pages ?? 1)) {
          return;
        }
        setSel(0);
        setOpened(null);
        setDetail(false);
        return void (tab === 'reports' ? state.loadReports(page) : state.loadTelegrams(page));
      }
      if (input === 'f' && tab === 'reports') {
        const index = REPORT_FOLDERS.findIndex((value) => value.key === state.reportFolder);
        setSel(0);
        setOpened(null);
        return void state.loadReports(1, REPORT_FOLDERS[(index + 1) % REPORT_FOLDERS.length]?.key);
      }
      if (input === 'd' && count) {
        return setConfirmDelete(true);
      }
      if (input === 'n') {
        return newTelegram();
      }
      if (input === 'R' && tab === 'telegrams') {
        const id = opened?.kind === 'telegram' ? opened.telegram.id : telegrams[idx]?.id;
        if (!id) {
          return;
        }
        setPending({ kind: 'reply', id });
        return setForm(
          makeForm(
            `Reply: ${opened?.kind === 'telegram' ? opened.telegram.subject : (telegrams[idx]?.subject ?? '')}`,
            [{ key: 'text', label: 'Text', value: '' }],
          ),
        );
      }
    },
    { isActive: active },
  );

  const leftW = Math.max(30, Math.floor(width * 0.45));
  const rightW = width - leftW;
  const listRows = Math.max(2, height - 4);
  const [start, end] = scrollWindow(idx, count, listRows);
  const tabs = (['reports', 'telegrams'] as Tab[]).map((target) => {
    const unread = target === 'reports' ? state.unread.reports : state.unread.messages;
    return createElement(
      Text,
      defined({
        key: target,
        inverse: tab === target,
        bold: tab === target,
        color: tab === target ? 'cyan' : undefined,
      }),
      ` ${target === 'reports' ? 'Reports' : 'Telegrams'}${unread ? ' •' : ''} `,
    );
  });
  const folder = REPORT_FOLDERS.find((value) => value.key === state.reportFolder)?.label ?? 'All';
  const sub =
    tab === 'reports'
      ? `${folder} (f) · page ${list?.page ?? 1}/${list?.pages ?? 1} (< >)`
      : `page ${list?.page ?? 1}/${list?.pages ?? 1} (< >) · n new`;
  const rows =
    tab === 'reports'
      ? reports
          .slice(start, end)
          .map((reportInfo, index) =>
            createElement(
              Text,
              { key: reportInfo.id, inverse: start + index === idx, bold: !reportInfo.read, wrap: 'truncate' },
              `${reportInfo.read ? ' ' : '•'} ${truncate(reportInfo.title, leftW - 19)} `,
              createElement(Text, { dimColor: true }, truncate(reportInfo.date, 12)),
            ),
          )
      : telegrams
          .slice(start, end)
          .map((target, index) =>
            createElement(
              Text,
              { key: target.id, inverse: start + index === idx, bold: target.unread, wrap: 'truncate' },
              `${target.unread ? '•' : target.answered ? '↩' : ' '} ${truncate(target.subject, leftW - 30)} `,
              createElement(
                Text,
                { color: 'magenta' },
                truncate(target.partners.length ? target.partners.join(', ') : 'System', 12),
              ),
              ' ',
              createElement(Text, { dimColor: true }, truncate(target.date, 10)),
            ),
          );
  const left = createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: detail ? 'gray' : 'cyan',
      width: leftW,
      height,
      paddingX: 1,
    },
    createElement(Text, { wrap: 'truncate' }, ...tabs, createElement(Text, { dimColor: true }, ' Tab')),
    createElement(Text, { dimColor: true, wrap: 'truncate' }, sub),
    ...rows,
    count === 0 ? createElement(Text, { dimColor: true }, list ? 'Nothing here.' : 'Loading…') : null,
  );

  const dw = Math.max(10, rightW - 4);
  let lines: React.ReactNode[] = [];
  let maxTop = 0;
  if (form) {
    lines = [createElement(FormView, { key: 'form', form, width: rightW - 2 })];
  } else if (opened?.kind === 'report') {
    const reportInfo = opened.report;
    const body = wrap(reportInfo.text, dw);
    const room = Math.max(1, height - 6);
    maxTop = Math.max(0, body.length - room);
    const top = Math.min(scroll, maxTop);
    lines = [
      createElement(Text, { key: 't', bold: true, wrap: 'truncate' }, reportInfo.title),
      createElement(
        Text,
        { key: 'd', dimColor: true, wrap: 'truncate' },
        `${reportInfo.date}${reportInfo.type ? ` · ${reportInfo.type}` : ''}`,
      ),
      ...body.slice(top, top + room).map((text, index) => createElement(Text, { key: index }, text || ' ')),
    ];
  } else if (opened?.kind === 'telegram') {
    const openedTelegram = opened.telegram;
    const body = openedTelegram.posts.flatMap((pick) => [`▸ ${pick.from} · ${pick.date}`, ...wrap(pick.text, dw), '']);
    const room = Math.max(1, height - 6);
    maxTop = Math.max(0, body.length - room);
    const top = Math.min(scroll, maxTop);
    lines = [
      createElement(Text, { key: 't', bold: true, wrap: 'truncate' }, openedTelegram.subject),
      createElement(
        Text,
        { key: 'd', dimColor: true, wrap: 'truncate' },
        `${openedTelegram.posts.length} post(s)${openedTelegram.pages > 1 ? ` · page ${openedTelegram.page + 1}/${openedTelegram.pages}` : ''}`,
      ),
      ...body
        .slice(top, top + room)
        .map((text, index) =>
          createElement(
            Text,
            defined({ key: index, color: text.startsWith('▸ ') ? 'magenta' : undefined }),
            text || ' ',
          ),
        ),
    ];
  } else {
    const cur = tab === 'reports' ? reports[idx] : null;
    lines = [createElement(Text, { key: 'h', dimColor: true }, count ? 'Enter: read' : '')];
    if (cur?.summary) {
      lines.push(
        ...wrap(cur.summary, dw)
          .slice(0, height - 6)
          .map((text, index) => createElement(Text, { key: `s${index}`, dimColor: true }, text)),
      );
    }
  }
  // Scrolling past the end would leave j/k with nothing to undo.
  useEffect(() => {
    if (scroll > maxTop) {
      setScroll(maxTop);
    }
  });
  const keys = confirmDelete
    ? createElement(
        Text,
        { color: 'red', wrap: 'truncate' },
        `Delete this ${tab === 'reports' ? 'report' : 'telegram'}? y / n`,
      )
    : createElement(
        Text,
        { dimColor: true, wrap: 'truncate' },
        `${detail ? 'j k scroll · h list' : 'Enter read'} · d delete${tab === 'telegrams' ? ' · R reply' : ''} · n new telegram · Esc back`,
      );
  const right = createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: detail ? 'cyan' : 'gray',
      width: rightW,
      height,
      paddingX: 1,
    },
    ...lines,
    createElement(Box, { flexGrow: 1 }),
    keys,
  );
  return createElement(Box, { width, height }, left, right);
}
