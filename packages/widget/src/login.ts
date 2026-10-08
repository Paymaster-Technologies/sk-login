// The "Sign in with Secret Keeper" popup: a request via POST init, a QR and
// an app button, status polling, a code field after the scan (if the app
// could not deliver the code), refusal and cancel as an info sheet.
//
//   const login = mountSkLogin({ apiBase: '/api/sk', onSuccess: () => location.reload() });
//   button.addEventListener('click', () => login.open());
//
// Beyond the module's routes: `transport` replaces the built-in fetch calls
// (own routes and response formats), `complete` finishes the sign-in on the
// server after `authenticated` (a second factor that binds the browser and
// issues the session), `manualCode: false` hides the code entry,
// `transport.cancel` tells the server when the person gives up (the sheet
// waits for the answer and stays with an error when it fails),
// `recoveryLink` adds "No access to Secret Keeper?" under every view, and
// `container` renders the sheet inline instead of a modal dialog.

import {
  ERROR_ICON,
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
  /** The waiting view while `complete` runs. */
  completing: string;
  /** `complete` failed and the error has no message of its own. */
  completeFailed: string;
  /** The waiting view while `transport.cancel` runs. */
  cancelling: string;
  /** `transport.cancel` failed and the error has no message of its own. */
  cancelFailed: string;
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
    completing: 'Завершаем вход…',
    completeFailed: 'Не удалось завершить вход. Попробуйте ещё раз.',
    cancelling: 'Отменяем запрос…',
    cancelFailed: 'Не удалось отменить запрос. Попробуйте ещё раз.',
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
    completing: 'Finishing the sign-in…',
    completeFailed: 'Could not finish the sign-in. Please try again.',
    cancelling: 'Cancelling the request…',
    cancelFailed: 'Could not cancel the request. Please try again.',
  },
};

/** The module's `POST init` response. */
export interface InitResponse extends QrInit {
  payloadUrl: string;
}

/** The module's `GET status` response: the state plus whatever `onAuthenticated` merged in. */
export interface StatusResponse {
  state: 'new' | 'challenged' | 'authenticated' | 'denied' | 'cancelled' | 'expired' | (string & {});
  /** For `denied`: the reason from `access`. */
  reason?: string;
  message?: string;
  [extra: string]: unknown;
}

/** What a manual code submission came to. */
export type CodeResult =
  /** Signed in; `extra` is what the server returned alongside (a token, a user). */
  | { kind: 'ok'; extra?: Record<string, unknown> }
  /** The code did not match: the field is emptied, the person tries again. */
  | { kind: 'wrong' }
  /** The address is proven but there is no access. */
  | { kind: 'denied'; reason?: string; message?: string }
  /** The request is unknown, expired or out of attempts: the "QR expired" sheet. */
  | { kind: 'stale' };

/**
 * How the widget talks to the server. The default one calls the module's
 * routes under `apiBase`; a service with its own routes and response
 * formats supplies its own. A rejected promise from `init` or `submitCode`
 * is shown as "could not reach the site"; from `status` it is ignored and
 * the next poll retries.
 */
export interface SkLoginTransport {
  /** A new sign-in request: sid, QR and links. */
  init(): Promise<InitResponse>;
  /** The state of the request. */
  status(sid: string): Promise<StatusResponse>;
  /** The code the app showed to the person. Without it the code entry is not offered. */
  submitCode?(sid: string, code: string): Promise<CodeResult>;
  /** The person closed the widget before the sign-in finished: tell the server.
   *  The sheet waits for it; a rejection keeps the sheet open with the error and "Try again". */
  cancel?(sid: string): Promise<void>;
}

export interface RecoveryLink {
  /** The link text, e.g. "No access to Secret Keeper?". */
  text: string;
  /** Where it leads; with `onClick` only, the link stays on the page. */
  href?: string;
  onClick?: () => void;
}

export interface SkLoginWidgetOptions extends SheetOptions {
  /** Text overrides. */
  texts?: Partial<Texts>;
  /** Sign-in succeeded: `extra` holds the fields the server's `onAuthenticated` merged into the reply (e.g. token),
   *  plus what `complete` returned, if it is set. */
  onSuccess: (extra: Record<string, unknown>) => void;
  /** The address is proven but there is no access. `message` is the server's text, if it sent one. */
  onDenied?: (reason: string | undefined, message: string | undefined) => void;
  /** Own server calls instead of the module's routes under `apiBase`. */
  transport?: SkLoginTransport;
  /**
   * Finish the sign-in on the server once the request is `authenticated`
   * (check the browser binding, issue the session). The widget shows a
   * waiting view meanwhile, does not close and does not call it twice;
   * `onSuccess` fires only after it resolves. A rejection is shown as an
   * error view with the error's message (`completeFailed` when it has none)
   * and is not retried.
   */
  complete?: (sid: string, extra: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  /** `complete` rejected; the error is already on the screen. */
  onCompleteError?: (error: unknown) => void;
  /** `transport.cancel` rejected; the error is already on the screen with "Try again". */
  onCancelError?: (error: unknown) => void;
  /** Offer the manual code entry after the scan. Default `true`; forced off without `transport.submitCode`. */
  manualCode?: boolean;
  /** A link under every view (the QR, the waiting, the errors), e.g. "No access to Secret Keeper?". */
  recoveryLink?: RecoveryLink;
  /** Inline mode (`container`): request the QR right away on mount. Default `true`. */
  autoStart?: boolean;
}

export interface SkLoginWidget {
  open(): void;
  /** As the close button: with a request in flight the server is told first (`transport.cancel`). */
  close(): void;
  /** Remove the sheet; answers that arrive later are dropped, no callbacks fire. */
  destroy(): void;
  /** The dialog, or the inline root when `container` is set. */
  readonly element: HTMLElement;
}

/** The module's routes under `apiBase` (`init`, `status`, `code`); the widget's default transport. */
export function httpTransport(apiBase: string, fetchOpts: (init?: RequestInit) => RequestInit): SkLoginTransport {
  const api = apiBase.replace(/\/$/, '');
  return {
    async init() {
      const r = await fetch(`${api}/init`, fetchOpts({ method: 'POST' }));
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as InitResponse;
    },
    async status(sid) {
      const r = await fetch(`${api}/status?sid=${encodeURIComponent(sid)}`, fetchOpts());
      return (await r.json()) as StatusResponse;
    },
    async submitCode(sid, code) {
      const r = await fetch(
        `${api}/code`,
        fetchOpts({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sid, code }),
        }),
      );
      if (r.ok) {
        const { ok: _ok, ...extra } = (await r.json()) as Record<string, unknown>;
        return { kind: 'ok', extra };
      }
      if (r.status === 403) {
        const body = (await r.json().catch(() => ({}))) as { reason?: string; message?: string };
        return { kind: 'denied', reason: body.reason, message: body.message };
      }
      if (r.status === 400) return { kind: 'wrong' };
      // 404/409/410: the request is stale or the attempts are exhausted.
      return { kind: 'stale' };
    },
  };
}

export function mountSkLogin(options: SkLoginWidgetOptions): SkLoginWidget {
  const t: Texts = { ...texts[options.lang ?? 'ru'], ...options.texts };
  const recovery = options.recoveryLink;
  const sheet = createSheet({
    options,
    texts: t,
    title: t.title,
    action: t.open,
    footer: recovery
      ? `<p class="skl-secondary skl-recovery"><a data-r="recovery" href="${esc(recovery.href ?? '#')}">${esc(recovery.text)}</a></p>`
      : '',
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
    extraViews: (logo) =>
      `<section data-view="completing" class="skl-hidden">${waitingHtml(logo, t.completing)}</section>` +
      infoViewHtml(
        'denied',
        ICON(
          '<rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none"/>',
          'danger',
        ),
        t.denied,
        t.close,
        'denied-text',
      ) +
      infoViewHtml('failed', ERROR_ICON, t.completeFailed, t.close, 'failed-text') +
      `<section data-view="cancelling" class="skl-hidden">${waitingHtml(logo, t.cancelling)}</section>` +
      infoViewHtml('cancelFailed', ERROR_ICON, t.cancelFailed, t.retry, 'cancel-failed-text', 'cancel-retry'),
    infoViews: ['denied', 'failed', 'cancelFailed'],
    busyViews: ['completing', 'cancelling'],
  });
  const transport = options.transport ?? httpTransport(sheet.api, sheet.fetchOpts);
  const manualCode = options.manualCode !== false && typeof transport.submitCode === 'function';
  const codeInput = sheet.el<HTMLInputElement>('code');
  const codeForm = sheet.el('code-form');
  const codeHint = sheet.el('code-hint');
  const deniedText = sheet.el('denied-text');
  const failedText = sheet.el('failed-text');
  const cancelFailedText = sheet.el('cancel-failed-text');
  codeInput.id = `${sheet.uid}-code`;
  sheet.el('code-label').setAttribute('for', codeInput.id);

  let sid = '';
  let pollTimer: number | undefined;
  /** Bumped by every new request, by a cancel and by `destroy`: an async
   *  continuation that sees another generation belongs to the past and stops. */
  let generation = 0;
  /** The request reached `authenticated`: no cancel, no second completion. */
  let finishing = false;

  const stopPoll = () => {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = undefined;
  };
  sheet.onStop(stopPoll);

  const finish = async (extra: Record<string, unknown>) => {
    if (finishing) return;
    finishing = true;
    stopPoll();
    if (!options.complete) {
      sheet.stop();
      sheet.done();
      options.onSuccess(extra);
      return;
    }
    // The server finishes the sign-in (binding, session): wait on the
    // screen, do not let the sheet close meanwhile.
    sheet.lock(true);
    sheet.stop();
    sheet.show('completing');
    const mine = generation;
    try {
      const more = await options.complete(sid, extra);
      sheet.lock(false);
      if (mine !== generation) return;
      sheet.stop();
      sheet.done();
      options.onSuccess({ ...extra, ...(more ?? {}) });
    } catch (e) {
      sheet.lock(false);
      if (mine !== generation) return;
      sheet.stop();
      failedText.textContent = (e instanceof Error && e.message) || t.completeFailed;
      sheet.reopen('failed');
      options.onCompleteError?.(e);
    }
  };
  // The address is proven but there is no access: one text, the reason stays in the protocol.
  const deny = (reason?: string, message?: string) => {
    finishing = true;
    sheet.stop();
    deniedText.textContent = message || t.denied;
    sheet.show('denied');
    options.onDenied?.(reason, message);
  };
  // "Cancel" in the app: the server received sk-login-cancel.
  const cancelled = () => {
    sid = '';
    sheet.stop();
    sheet.reopen('cancelled');
    options.onCancelled?.();
  };

  const tick = async () => {
    if (!sheet.alive()) return sheet.expire();
    const mine = generation;
    try {
      const body = await transport.status(sid);
      // While we waited, polling may have been stopped (code entry, close,
      // a new request): the answer is about a stale sid, leave the screen alone.
      if (!pollTimer || mine !== generation) return;
      const { state, reason, message, ...extra } = body;
      if (state === 'authenticated') return finish(extra);
      if (state === 'denied') return deny(reason, message);
      if (state === 'expired') {
        // The server already forgot the request: nothing to cancel on close.
        sid = '';
        return sheet.expire();
      }
      if (state === 'cancelled') return cancelled();
      // The code field only after the first envelope from the app: before that nobody has a code.
      if (state === 'challenged') {
        if (sheet.current() !== 'challenged') {
          // The server restarted the TTL: the person is in the app's dialog.
          sheet.renew();
          codeHint.classList.add('skl-hidden');
          sheet.show('challenged');
        } else if (manualCode && sheet.late()) {
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
    sid = '';
    finishing = false;
    codeInput.value = '';
    clearCodeError();
    codeForm.classList.add('skl-hidden');
    sheet.loading();
    try {
      const init = await transport.init();
      // While we waited, the popup was closed or a new request was made.
      if (mine !== generation || !sheet.isOpen()) return;
      sid = init.sid;
      sheet.showQr(init);
      pollTimer = window.setInterval(tick, sheet.pollMs);
    } catch {
      if (mine === generation && sheet.isOpen()) sheet.expire('offline');
    }
  };
  sheet.onRefresh(start);

  // The person closed the sheet with a request in flight: the late answers
  // are ignored and, when the transport knows how, the server is told first.
  // The sheet waits for that answer and closes after it; a failure stays on
  // the screen with "Try again", which runs the cancel again. After
  // `authenticated` nothing is cancelled: the sign-in already happened.
  const cancelOnServer = async (current: string) => {
    const mine = generation;
    sheet.stop();
    sheet.lock(true);
    sheet.show('cancelling');
    try {
      await transport.cancel!(current);
      sheet.lock(false);
      if (mine !== generation) return;
      sid = '';
      sheet.close();
    } catch (e) {
      sheet.lock(false);
      if (mine !== generation) return;
      cancelFailedText.textContent = (e instanceof Error && e.message) || t.cancelFailed;
      sheet.reopen('cancelFailed');
      options.onCancelError?.(e);
    }
  };
  sheet.onBeforeClose(() => {
    const current = sid;
    if (!current || finishing) {
      sid = '';
      return;
    }
    generation++;
    stopPoll();
    if (!transport.cancel) {
      sid = '';
      return;
    }
    void cancelOnServer(current);
    return false;
  });
  sheet.el('cancel-retry').addEventListener('click', () => sheet.close());

  const submitCode = async () => {
    const code = codeInput.value.trim();
    if (!code) return codeInput.focus();
    const mine = generation;
    let result: CodeResult;
    try {
      result = await transport.submitCode!(sid, code);
    } catch {
      return sheet.expire('offline');
    }
    if (mine !== generation) return;
    switch (result.kind) {
      case 'ok':
        return finish(result.extra ?? {});
      case 'denied':
        return deny(result.reason, result.message);
      case 'wrong':
        codeInput.value = '';
        codeInput.placeholder = t.wrong;
        codeInput.classList.add('error');
        codeInput.focus();
        return;
      default:
        sheet.expire();
    }
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
  if (recovery?.onClick) {
    const link = sheet.el<HTMLAnchorElement>('recovery');
    link.addEventListener('click', (e) => {
      if (!recovery.href) e.preventDefault();
      recovery.onClick!();
    });
  }

  if (sheet.inline && options.autoStart !== false) sheet.open();

  return {
    open: sheet.open,
    close: sheet.close,
    destroy() {
      generation++;
      sheet.destroy();
    },
    element: sheet.root,
  };
}
