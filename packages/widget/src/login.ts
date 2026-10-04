// The "Sign in with Secret Keeper" popup: a request via POST init, a QR and
// an app button, status polling, a code field after the scan (if the app
// could not deliver the code), refusal and cancel as an info sheet.
//
//   const login = mountSkLogin({ apiBase: '/api/sk', onSuccess: () => location.reload() });
//   button.addEventListener('click', () => login.open());

import {
  ICON,
  type Lang,
  type QrInit,
  type SheetOptions,
  type SheetTexts,
  createSheet,
  esc,
  infoViewHtml,
  sheetTexts,
  waitingHtml,
} from './sheet.js';

export interface Texts extends SheetTexts {
  title: string;
  open: string;
  lead1: string;
  lead2: string;
  leadLink: string;
  codeLabel: string;
  submit: string;
  wrong: string;
  denied: string;
}

export const texts: Record<Lang, Texts> = {
  ru: {
    ...sheetTexts.ru,
    title: 'Вход',
    open: 'Войдите через приложение',
    lead1: 'Ожидание подтверждения в Secret Keeper…',
    lead2: 'Если приложение показало код, то ',
    leadLink: 'введите его',
    codeLabel: 'Код из приложения',
    submit: 'Войти',
    wrong: 'Код не подошёл',
    denied: 'Вход подтверждён, доступ пока не открыт. Если вас здесь ждут, следующий вход пройдёт.',
    timeout: 'Время ожидания истекло: подтверждение из Secret Keeper не пришло. Попробуйте войти ещё раз.',
  },
  en: {
    ...sheetTexts.en,
    title: 'Sign in',
    open: 'Sign in with the app',
    lead1: 'Waiting for confirmation in Secret Keeper…',
    lead2: 'If the app showed you a code, ',
    leadLink: 'enter it',
    codeLabel: 'Code from the app',
    submit: 'Sign in',
    wrong: 'That code did not match',
    denied: 'Sign-in confirmed, but access is not open yet. If you are expected here, your next sign-in will go through.',
    timeout: 'Time ran out: no confirmation came from Secret Keeper. Try signing in again.',
  },
};

/** The module's `POST init` response. */
export interface InitResponse extends QrInit {
  payloadUrl: string;
}

export interface SkLoginWidgetOptions extends SheetOptions {
  /** Text overrides. */
  texts?: Partial<Texts>;
  /** Sign-in succeeded: `extra` holds the fields the server's `onAuthenticated` merged into the reply (e.g. token). */
  onSuccess: (extra: Record<string, unknown>) => void;
  /** The address is proven but there is no access. `message` is the server's text, if it sent one. */
  onDenied?: (reason: string | undefined, message: string | undefined) => void;
}

export interface SkLoginWidget {
  open(): void;
  close(): void;
  destroy(): void;
  readonly element: HTMLDialogElement;
}

export function mountSkLogin(options: SkLoginWidgetOptions): SkLoginWidget {
  const t: Texts = { ...texts[options.lang ?? 'ru'], ...options.texts };
  const sheet = createSheet({
    options,
    texts: t,
    title: t.title,
    action: t.open,
    // The code field opens from a link in the text: it is needed only when
    // the app showed the code to the person (its POST failed), a rare case,
    // so the hint appears only after half the TTL without confirmation.
    // Not a <form>: password managers take "field + button in a form" for
    // a password sign-in and offer autofill. Submit is on the button and Enter.
    challenged: (logo) =>
      waitingHtml(
        logo,
        t.lead1,
        `
      <p class="skl-secondary skl-lead skl-hidden" data-r="code-hint">${esc(t.lead2)}<button class="skl-link-btn" type="button" data-r="code-open">${esc(t.leadLink)}</button></p>
      <div class="skl-code-form skl-hidden" data-r="code-form">
        <label class="skl-secondary skl-code-label" data-r="code-label">${esc(t.codeLabel)}</label>
        <input class="skl-field" data-r="code" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="one-time-code" enterkeyhint="go">
        <button class="skl-btn" type="button" data-r="code-submit">${esc(t.submit)}</button>
      </div>`,
      ),
    extraViews: infoViewHtml(
      'denied',
      ICON(
        '<rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none"/>',
        'danger',
      ),
      t.denied,
      t.close,
      'denied-text',
    ),
    infoViews: ['denied'],
  });
  const codeInput = sheet.el<HTMLInputElement>('code');
  const codeForm = sheet.el('code-form');
  const codeHint = sheet.el('code-hint');
  const deniedText = sheet.el('denied-text');
  codeInput.id = `${sheet.uid}-code`;
  sheet.el('code-label').setAttribute('for', codeInput.id);

  let sid = '';
  let pollTimer: number | undefined;
  let generation = 0;

  const stopPoll = () => {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = undefined;
  };
  sheet.onStop(stopPoll);

  const finish = (extra: Record<string, unknown>) => {
    sheet.stop();
    sheet.close();
    options.onSuccess(extra);
  };
  // The address is proven but there is no access: one text, the reason stays in the protocol.
  const deny = (reason?: string, message?: string) => {
    sheet.stop();
    deniedText.textContent = message || t.denied;
    sheet.show('denied');
    options.onDenied?.(reason, message);
  };
  // "Cancel" in the app: the server received sk-login-cancel.
  const cancelled = () => {
    sheet.stop();
    sheet.reopen('cancelled');
    options.onCancelled?.();
  };

  const tick = async () => {
    if (!sheet.alive()) return sheet.expire();
    try {
      const r = await fetch(`${sheet.api}/status?sid=${encodeURIComponent(sid)}`, sheet.fetchOpts());
      const body = (await r.json()) as { state: string; reason?: string } & Record<string, unknown>;
      // While we waited, polling may have been stopped (code entry, close,
      // a new request): the answer is about a stale sid, leave the screen alone.
      if (!pollTimer) return;
      const { state, reason, ...extra } = body;
      if (state === 'authenticated') return finish(extra);
      if (state === 'denied') return deny(reason);
      if (state === 'expired') return sheet.expire();
      if (state === 'cancelled') return cancelled();
      // The code field only after the first envelope from the app: before that nobody has a code.
      if (state === 'challenged') {
        if (sheet.current() !== 'challenged') {
          // The server restarted the TTL: the person is in the app's dialog.
          sheet.renew();
          codeHint.classList.add('skl-hidden');
          sheet.show('challenged');
        } else if (sheet.late()) {
          // Half a minute without confirmation: something went wrong, offer manual code entry.
          codeHint.classList.remove('skl-hidden');
        }
      }
    } catch {
      // The network blinked: the next tick will retry.
    }
  };

  // "Code did not match" lives in the placeholder of the emptied field until typing resumes.
  const clearCodeError = () => {
    codeInput.placeholder = '';
    codeInput.classList.remove('error');
  };

  // A new request: sid and QR from the server, polling every pollMs. A new
  // request is made only on open and on "Refresh": we do not breed sessions.
  const start = async () => {
    sheet.stop();
    const mine = ++generation;
    codeInput.value = '';
    clearCodeError();
    codeForm.classList.add('skl-hidden');
    sheet.loading();
    try {
      const r = await fetch(`${sheet.api}/init`, sheet.fetchOpts({ method: 'POST' }));
      if (!r.ok) throw new Error(String(r.status));
      const init = (await r.json()) as InitResponse;
      // While we waited, the popup was closed or a new request was made.
      if (mine !== generation || !sheet.dialog.open) return;
      sid = init.sid;
      sheet.showQr(init);
      pollTimer = window.setInterval(tick, sheet.pollMs);
    } catch {
      if (mine === generation && sheet.dialog.open) sheet.expire('offline');
    }
  };
  sheet.onRefresh(start);

  const submitCode = async () => {
    const code = codeInput.value.trim();
    if (!code) return codeInput.focus();
    let r: Response;
    try {
      r = await fetch(
        `${sheet.api}/code`,
        sheet.fetchOpts({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sid, code }),
        }),
      );
    } catch {
      return sheet.expire('offline');
    }
    if (r.ok) {
      const { ok: _ok, ...extra } = (await r.json()) as Record<string, unknown>;
      return finish(extra);
    }
    if (r.status === 403) {
      const body = (await r.json().catch(() => ({}))) as { reason?: string; message?: string };
      return deny(body.reason, body.message);
    }
    if (r.status === 400) {
      codeInput.value = '';
      codeInput.placeholder = t.wrong;
      codeInput.classList.add('error');
      codeInput.focus();
      return;
    }
    // 404/409/410: the request is stale or the attempts are exhausted.
    sheet.expire();
  };

  // The field opens from the link; polling goes on: the app may confirm by itself.
  sheet.el('code-open').addEventListener('click', () => {
    codeForm.classList.remove('skl-hidden');
    codeInput.focus();
  });
  sheet.el('code-submit').addEventListener('click', submitCode);
  codeInput.addEventListener('input', clearCodeError);
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCode();
    }
  });

  return {
    open: sheet.open,
    close: sheet.close,
    destroy: sheet.destroy,
    element: sheet.dialog,
  };
}
