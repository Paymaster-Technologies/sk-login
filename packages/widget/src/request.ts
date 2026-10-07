// The "Fill from Secret Keeper" popup (data request, protocol § 4.6): a
// request via POST request/init for a record kind, a QR and an app button,
// status polling, waiting for the record, cancel and timeout as an info
// sheet. When the record arrives, `onFilled` gets the values and the popup
// closes: the page fills its own fields.
//
//   const fill = mountSkRequest({ apiBase: '/api/sk', onFilled: ({ values }) => form.fill(values) });
//   button.addEventListener('click', () => fill.open('card-details'));

import {
  type Lang,
  type QrInit,
  type SheetOptions,
  type SheetTexts,
  createSheet,
  esc,
  sheetTexts,
  waitingHtml,
} from './sheet.js';

export interface RequestTexts extends SheetTexts {
  title: string;
  /** For someone who sees Secret Keeper for the first time: what it is and
   *  what happens now, in one sentence. Shown until the first scan from this browser. */
  intro: string;
  introLink: string;
  send: string;
  waiting: string;
}

export const requestTexts: Record<Lang, RequestTexts> = {
  ru: {
    ...sheetTexts.ru,
    title: 'Заполнить форму',
    intro:
      'Secret Keeper - зашифрованный сейф для паролей, карт и документов на ваших устройствах. Подтвердите запрос в приложении: поля заполнятся сами. ',
    introLink: 'Подробнее',
    send: 'Отправьте из приложения',
    waiting: 'Ожидание подтверждения в Secret Keeper…',
    timeout: 'Время ожидания истекло: запись из Secret Keeper не пришла. Попробуйте ещё раз.',
  },
  en: {
    ...sheetTexts.en,
    title: 'Fill the form',
    intro:
      'Secret Keeper is an encrypted vault for passwords, cards and documents on your own devices. Confirm the request in the app: the fields fill in on their own. ',
    introLink: 'Learn more',
    send: 'Send from the app',
    waiting: 'Waiting for confirmation in Secret Keeper…',
    timeout: 'Time ran out: no record came from Secret Keeper. Try again.',
  },
};

/** The module's `POST request/init` response. */
export interface RequestInitResponse extends QrInit {
  kind: string;
  payloadUrl: string;
}

export interface SkFilled {
  kind: string;
  values: Record<string, string>;
  /** sk1… address of the app that sent the record. */
  sender: string;
  filledAt: number;
}

export interface SkRequestWidgetOptions extends SheetOptions {
  texts?: Partial<RequestTexts>;
  /** The record arrived; the popup is already closed. */
  onFilled: (filled: SkFilled) => void;
  /** The page session is gone (`request/init` or `request/status` answered 401). Defaults to a reload. */
  onUnauthorized?: () => void;
}

export interface SkRequestWidget {
  /** Open the popup for a record kind (`login-password`, `card-details`, `personal-data`). */
  open(kind: string): void;
  close(): void;
  destroy(): void;
  /** The dialog, or the inline root when `container` is set. */
  readonly element: HTMLElement;
}

type Poll =
  | { state: 'new' | 'challenged' | 'cancelled' | 'expired' }
  | { state: 'filled'; values: Record<string, string>; sender: string; filledAt: number };

/** The intro is shown until the first scan from this browser: a scan proves
 *  the person has the app, however the request ends. */
const INTRO_DONE = 'sk-intro-done';
const introDone = () => {
  try {
    return localStorage.getItem(INTRO_DONE) === '1';
  } catch {
    return false;
  }
};
const markIntroDone = () => {
  try {
    localStorage.setItem(INTRO_DONE, '1');
  } catch {
    // Private mode without storage: the text is shown once more.
  }
};

export function mountSkRequest(options: SkRequestWidgetOptions): SkRequestWidget {
  const t: RequestTexts = { ...requestTexts[options.lang ?? 'ru'], ...options.texts };
  const skSite = options.skSiteUrl ?? 'https://secretkeeper.net';
  const sheet = createSheet({
    options,
    texts: t,
    title: t.title,
    action: t.send,
    intro: `<p class="skl-intro" data-r="intro">${esc(t.intro)}<a href="${esc(skSite)}" target="_blank" rel="noopener">${esc(t.introLink)}</a></p>`,
    // The app scanned: confirmation happens there. No manual code in sk-data, only waiting.
    challenged: (logo) => waitingHtml(logo, t.waiting),
  });
  const intro = sheet.el('intro');

  let kind = '';
  let sid = '';
  let pollTimer: number | undefined;
  let generation = 0;

  const stopPoll = () => {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = undefined;
  };
  sheet.onStop(stopPoll);

  const unauthorized = () => {
    sheet.stop();
    sheet.close();
    if (options.onUnauthorized) options.onUnauthorized();
    else window.location.reload();
  };

  // The record arrived: hand it to the page, the popup closes.
  const fill = (values: Record<string, string>, sender: string, filledAt: number) => {
    sheet.stop();
    sheet.close();
    // A confirmation between two polls skips the `challenged` state.
    markIntroDone();
    options.onFilled({ kind, values, sender, filledAt });
  };

  const cancelled = () => {
    sheet.stop();
    sheet.reopen('cancelled');
    options.onCancelled?.();
  };

  const tick = async () => {
    if (!sheet.alive()) return sheet.expire();
    try {
      const r = await fetch(`${sheet.api}/request/status?sid=${encodeURIComponent(sid)}`, sheet.fetchOpts());
      if (r.status === 401) return unauthorized();
      const poll = (await r.json()) as Poll;
      if (!pollTimer) return;
      if (poll.state === 'filled') return fill(poll.values, poll.sender, poll.filledAt);
      if (poll.state === 'expired') return sheet.expire();
      if (poll.state === 'cancelled') return cancelled();
      // The app scanned: the server restarted the TTL.
      if (poll.state === 'challenged' && sheet.current() !== 'challenged') {
        sheet.renew();
        markIntroDone();
        sheet.show('challenged');
      }
    } catch {
      // The network blinked: the next tick will retry.
    }
  };

  // A new request for the current kind: sid and QR from the server, polling every pollMs.
  const start = async () => {
    sheet.stop();
    const mine = ++generation;
    intro.classList.toggle('skl-hidden', introDone());
    sheet.loading();
    try {
      const r = await fetch(
        `${sheet.api}/request/init`,
        sheet.fetchOpts({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind }),
        }),
      );
      if (r.status === 401) return unauthorized();
      if (!r.ok) throw new Error(String(r.status));
      const init = (await r.json()) as RequestInitResponse;
      if (mine !== generation || !sheet.isOpen()) return;
      sid = init.sid;
      sheet.showQr(init);
      pollTimer = window.setInterval(tick, sheet.pollMs);
    } catch {
      if (mine === generation && sheet.isOpen()) sheet.expire('offline');
    }
  };
  sheet.onRefresh(start);

  return {
    open(next: string) {
      if (sheet.isOpen()) return;
      kind = next;
      sheet.open();
    },
    close: sheet.close,
    destroy: sheet.destroy,
    element: sheet.root,
  };
}
