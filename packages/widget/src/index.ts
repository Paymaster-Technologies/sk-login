// @paymastech/sk-login-widget: the "Sign in with Secret Keeper" popup
// without a framework. The behavior mirrors the lashin.su popup: a request
// via POST init, a QR and an app button, status polling every 2 seconds, a
// code field after the scan (if the app could not deliver the code), "QR
// expired" with a "Refresh" button, refusal and cancel as an info sheet.
//
//   const login = mountSkLogin({ apiBase: '/api/sk', onSuccess: () => location.reload() });
//   button.addEventListener('click', () => login.open());

import { SK_LOGO } from './logo.js';
import { ensureStyles } from './styles.js';

export type Lang = 'ru' | 'en';

export interface Texts {
  title: string;
  close: string;
  scan1: string;
  scanLink: string;
  scan2: string;
  scan3: string;
  open: string;
  noapp1: string;
  noappLink: string;
  lead1: string;
  lead2: string;
  leadLink: string;
  codeLabel: string;
  submit: string;
  wrong: string;
  denied: string;
  cancelled: string;
  timeout: string;
  expired: string;
  offline: string;
  refresh: string;
}

export const texts: Record<Lang, Texts> = {
  ru: {
    title: 'Вход',
    close: 'Закрыть',
    scan1: 'Откройте приложение ',
    scanLink: 'Secret Keeper',
    scan2: ' на другом устройстве, нажмите значок ',
    scan3: ' в верхней панели и наведите камеру на QR-код:',
    open: 'Войдите через приложение',
    noapp1: 'Приложение не открылось? Установите ',
    noappLink: 'Secret Keeper',
    lead1: 'Ожидание подтверждения в Secret Keeper…',
    lead2: 'Если приложение показало код, то ',
    leadLink: 'введите его',
    codeLabel: 'Код из приложения',
    submit: 'Войти',
    wrong: 'Код не подошёл',
    denied: 'Вход подтверждён, доступ пока не открыт. Если вас здесь ждут, следующий вход пройдёт.',
    cancelled: 'Вы отклонили этот запрос в Secret Keeper.',
    timeout: 'Время ожидания истекло: подтверждение из Secret Keeper не пришло. Попробуйте войти ещё раз.',
    expired: 'QR-код устарел',
    offline: 'Нет связи с сайтом',
    refresh: 'Обновить',
  },
  en: {
    title: 'Sign in',
    close: 'Close',
    scan1: 'Open the ',
    scanLink: 'Secret Keeper',
    scan2: ' app on another device, tap the ',
    scan3: ' icon in the top bar and point the camera at the QR code:',
    open: 'Sign in with the app',
    noapp1: 'The app did not open? Install ',
    noappLink: 'Secret Keeper',
    lead1: 'Waiting for confirmation in Secret Keeper…',
    lead2: 'If the app showed you a code, ',
    leadLink: 'enter it',
    codeLabel: 'Code from the app',
    submit: 'Sign in',
    wrong: 'That code did not match',
    denied: 'Sign-in confirmed, but access is not open yet. If you are expected here, your next sign-in will go through.',
    cancelled: 'You declined this request in Secret Keeper.',
    timeout: 'Time ran out: no confirmation came from Secret Keeper. Try signing in again.',
    expired: 'The QR code has expired',
    offline: 'Could not reach the site',
    refresh: 'Refresh',
  },
};

/** The module's `POST init` response. */
export interface InitResponse {
  sid: string;
  payloadUrl: string;
  schemeUrl: string;
  ttlMs: number;
  qrSvg?: string;
}

export interface SkLoginWidgetOptions {
  /** Module route prefix, without a trailing slash. Defaults to `/api/sk`. */
  apiBase?: string;
  lang?: Lang;
  /** Text overrides. */
  texts?: Partial<Texts>;
  /** Sign-in succeeded: `extra` holds the fields the server's `onAuthenticated` merged into the reply (e.g. token). */
  onSuccess: (extra: Record<string, unknown>) => void;
  /** The address is proven but there is no access. `message` is the server's text, if it sent one. */
  onDenied?: (reason: string | undefined, message: string | undefined) => void;
  onCancelled?: () => void;
  onClose?: () => void;
  /** Logo in the center of the QR and in the waiting view; defaults to the built-in Secret Keeper logo. */
  logoUrl?: string;
  /** The "Secret Keeper" link in the hint. */
  skSiteUrl?: string;
  /** `light` / `dark`; when unset, follows prefers-color-scheme. */
  theme?: 'light' | 'dark';
  /** Extra request headers (e.g. CSRF). */
  headers?: Record<string, string>;
  /** `credentials` for fetch; defaults to `same-origin`. Use `include` for an API on another domain. */
  credentials?: RequestCredentials;
  /** Polling interval, ms. */
  pollMs?: number;
}

export interface SkLoginWidget {
  open(): void;
  close(): void;
  destroy(): void;
  readonly element: HTMLDialogElement;
}

type View = 'scan' | 'challenged' | 'denied' | 'cancelled' | 'timeout';

const OPEN_APP_GRACE_MS = 2000;
const SOON_MS = 10_000;

const SCAN_ICON =
  '<svg class="skl-hint-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zm8-12v8h8V3h-8zm6 6h-4V5h4v4zm-6 4h2v2h-2v-2zm2 2h2v2h-2v-2zm-2 2h2v2h-2v-2zm4 0h2v2h-2v-2zm2 2h2v2h-2v-2zm-4 0h2v2h-2v-2zm2-6h2v2h-2v-2zm2 2h2v2h-2v-2z"/></svg>';
const ICON = (body: string, cls = '') =>
  `<svg class="skl-info-icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function mountSkLogin(options: SkLoginWidgetOptions): SkLoginWidget {
  const doc = document;
  ensureStyles(doc);
  const t: Texts = { ...texts[options.lang ?? 'ru'], ...options.texts };
  const api = (options.apiBase ?? '/api/sk').replace(/\/$/, '');
  const logo = options.logoUrl ?? SK_LOGO;
  const skSite = options.skSiteUrl ?? 'https://secretkeeper.net';
  const pollMs = options.pollMs ?? 2000;
  const uid = `skl${Math.random().toString(36).slice(2, 8)}`;

  const dialog = doc.createElement('dialog');
  dialog.className = 'skl';
  if (options.theme) dialog.dataset.theme = options.theme;
  dialog.setAttribute('aria-labelledby', `${uid}-title`);
  dialog.innerHTML = `
<div class="skl-inner">
  <div class="skl-bar">
    <button class="skl-close" type="button" aria-label="${esc(t.close)}" title="${esc(t.close)}" data-r="close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <h2 class="skl-title" id="${uid}-title">${esc(t.title)}</h2>
    <span class="skl-spacer"><span class="skl-ttl skl-hidden" data-r="ttl"></span></span>
  </div>
  <div class="skl-body">
    <section data-view="scan">
      <p class="skl-secondary skl-hint">${esc(t.scan1)}<a href="${esc(skSite)}" target="_blank" rel="noopener">${esc(t.scanLink)}</a>${esc(t.scan2)}${SCAN_ICON}${esc(t.scan3)}</p>
      <a class="skl-qr loading" href="#" data-r="qr-link" aria-label="QR">
        <span data-r="qr"></span>
        <img class="skl-qr-logo" src="${esc(logo)}" alt="" width="44" height="44">
        <span class="skl-qr-spinner" aria-hidden="true"></span>
      </a>
      <a class="skl-btn" href="#" data-r="open">${esc(t.open)}</a>
      <p class="skl-secondary skl-noapp skl-hidden" data-r="noapp">${esc(t.noapp1)}<a href="${esc(skSite)}" target="_blank" rel="noopener">${esc(t.noappLink)}</a></p>
    </section>
    <section data-view="challenged" class="skl-hidden">
      <span class="skl-logo"><img src="${esc(logo)}" alt="Secret Keeper" width="56" height="56"></span>
      <p class="skl-secondary skl-lead">${esc(t.lead1)}</p>
      <p class="skl-secondary skl-lead skl-hidden" data-r="code-hint">${esc(t.lead2)}<button class="skl-link-btn" type="button" data-r="code-open">${esc(t.leadLink)}</button></p>
      <div class="skl-code-form skl-hidden" data-r="code-form">
        <label class="skl-secondary skl-code-label" for="${uid}-code">${esc(t.codeLabel)}</label>
        <input class="skl-field" id="${uid}-code" data-r="code" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="one-time-code" enterkeyhint="go">
        <button class="skl-btn" type="button" data-r="code-submit">${esc(t.submit)}</button>
      </div>
    </section>
    <section data-view="denied" class="skl-hidden skl-info">
      ${ICON('<rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none"/>', 'danger')}
      <p class="skl-info-text" data-r="denied-text">${esc(t.denied)}</p>
      <button class="skl-btn outline" type="button" data-r="close">${esc(t.close)}</button>
    </section>
    <section data-view="cancelled" class="skl-hidden skl-info">
      ${ICON('<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>')}
      <p class="skl-info-text">${esc(t.cancelled)}</p>
      <button class="skl-btn outline" type="button" data-r="close">${esc(t.close)}</button>
    </section>
    <section data-view="timeout" class="skl-hidden skl-info">
      ${ICON('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>')}
      <p class="skl-info-text">${esc(t.timeout)}</p>
      <button class="skl-btn outline" type="button" data-r="close">${esc(t.close)}</button>
    </section>
  </div>
  <div class="skl-expired skl-hidden" role="alertdialog" data-r="expired">
    <div class="skl-expired-card">
      <svg class="skl-expired-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>
      <p class="skl-expired-title" data-r="expired-title"></p>
      <button class="skl-btn" type="button" data-r="refresh">${esc(t.refresh)}</button>
    </div>
  </div>
</div>`;
  doc.body.appendChild(dialog);

  const el = <T extends HTMLElement>(r: string) => dialog.querySelector<T>(`[data-r="${r}"]`)!;
  const views = Array.from(dialog.querySelectorAll<HTMLElement>('[data-view]'));
  const qr = el('qr');
  const qrLink = el<HTMLAnchorElement>('qr-link');
  const openApp = el<HTMLAnchorElement>('open');
  const noApp = el('noapp');
  const ttl = el('ttl');
  const codeInput = el<HTMLInputElement>('code');
  const codeForm = el('code-form');
  const codeHint = el('code-hint');
  const deniedText = el('denied-text');
  const expired = el('expired');
  const expiredTitle = el('expired-title');

  let sid = '';
  let current: View = 'scan';
  let pollTimer: number | undefined;
  let ttlTimer: number | undefined;
  let openTimer: number | undefined;
  let startedAt = 0;
  let ttlMs = 0;
  let generation = 0;
  let pendingOpen = false;

  const fetchOpts = (init: RequestInit = {}): RequestInit => ({
    cache: 'no-store',
    credentials: options.credentials ?? 'same-origin',
    ...init,
    headers: { ...options.headers, ...(init.headers as Record<string, string> | undefined) },
  });

  const loading = () => qrLink.classList.contains('loading');
  const isExpired = () => !expired.classList.contains('skl-hidden');
  const alive = () => Date.now() - startedAt <= ttlMs;
  const late = () => Date.now() - startedAt >= ttlMs / 2;

  const syncTtl = () => {
    const info = current !== 'scan' && current !== 'challenged';
    ttl.classList.toggle('skl-hidden', info || loading() || isExpired());
  };
  const drawTtl = () => {
    const left = Math.max(0, ttlMs - (Date.now() - startedAt));
    const sec = Math.ceil(left / 1000);
    ttl.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    ttl.classList.toggle('soon', left <= SOON_MS);
  };
  const renew = () => {
    startedAt = Date.now();
    if (ttlTimer) window.clearInterval(ttlTimer);
    drawTtl();
    ttlTimer = window.setInterval(drawTtl, 1000);
  };

  const show = (name: View) => {
    current = name;
    for (const v of views) v.classList.toggle('skl-hidden', v.dataset.view !== name);
    const info = name === 'denied' || name === 'cancelled' || name === 'timeout';
    dialog.classList.toggle('info', info);
    syncTtl();
    if (info) (doc.activeElement as HTMLElement | null)?.blur();
  };

  const cancelWatchOpen = () => {
    if (openTimer) window.clearTimeout(openTimer);
    openTimer = undefined;
    window.removeEventListener('blur', onLeft);
    doc.removeEventListener('visibilitychange', onLeft);
  };
  const onLeft = () => {
    if (doc.visibilityState === 'hidden' || !doc.hasFocus()) cancelWatchOpen();
  };
  // Click on the app button: if the window has not lost focus within
  // OPEN_APP_GRACE_MS, nobody handled the scheme (no app installed), so
  // show the hint with the link.
  const watchOpen = () => {
    cancelWatchOpen();
    noApp.classList.add('skl-hidden');
    window.addEventListener('blur', onLeft);
    doc.addEventListener('visibilitychange', onLeft);
    openTimer = window.setTimeout(() => {
      cancelWatchOpen();
      noApp.classList.remove('skl-hidden');
    }, OPEN_APP_GRACE_MS);
  };

  const stop = () => {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = undefined;
    if (ttlTimer) window.clearInterval(ttlTimer);
    ttlTimer = undefined;
    cancelWatchOpen();
  };

  const reopen = (name: View) => {
    if (dialog.open) dialog.close();
    show(name);
    dialog.showModal();
  };

  const expire = (reason: 'expired' | 'offline' = 'expired') => {
    stop();
    if (reason === 'expired' && current === 'challenged') return reopen('timeout');
    expiredTitle.textContent = reason === 'offline' ? t.offline : t.expired;
    expired.classList.remove('skl-hidden');
    syncTtl();
    el('refresh').focus();
  };

  const finish = (extra: Record<string, unknown>) => {
    stop();
    dialog.close();
    options.onSuccess(extra);
  };
  const deny = (reason?: string, message?: string) => {
    stop();
    deniedText.textContent = message || t.denied;
    show('denied');
    options.onDenied?.(reason, message);
  };
  const cancelled = () => {
    stop();
    reopen('cancelled');
    options.onCancelled?.();
  };

  const tick = async () => {
    if (!alive()) return expire();
    try {
      const r = await fetch(`${api}/status?sid=${encodeURIComponent(sid)}`, fetchOpts());
      const body = (await r.json()) as { state: string; reason?: string } & Record<string, unknown>;
      if (!pollTimer) return;
      const { state, reason, ...extra } = body;
      if (state === 'authenticated') return finish(extra);
      if (state === 'denied') return deny(reason);
      if (state === 'expired') return expire();
      if (state === 'cancelled') return cancelled();
      if (state === 'challenged') {
        if (current !== 'challenged') {
          renew();
          codeHint.classList.add('skl-hidden');
          show('challenged');
        } else if (late()) {
          codeHint.classList.remove('skl-hidden');
        }
      }
    } catch {
      // The network blinked: the next tick will retry.
    }
  };

  const clearCodeError = () => {
    codeInput.placeholder = '';
    codeInput.classList.remove('error');
  };

  const start = async () => {
    stop();
    const mine = ++generation;
    pendingOpen = false;
    codeInput.value = '';
    clearCodeError();
    codeForm.classList.add('skl-hidden');
    expired.classList.add('skl-hidden');
    noApp.classList.add('skl-hidden');
    qrLink.classList.add('loading');
    show('scan');
    try {
      const r = await fetch(`${api}/init`, fetchOpts({ method: 'POST' }));
      if (!r.ok) throw new Error(String(r.status));
      const init = (await r.json()) as InitResponse;
      if (mine !== generation || !dialog.open) return;
      sid = init.sid;
      ttlMs = init.ttlMs;
      qr.innerHTML = init.qrSvg ?? '';
      qrLink.href = init.schemeUrl;
      openApp.href = init.schemeUrl;
      qrLink.classList.remove('loading');
      renew();
      syncTtl();
      pollTimer = window.setInterval(tick, pollMs);
      if (pendingOpen) {
        pendingOpen = false;
        openApp.click();
      }
    } catch {
      if (mine === generation && dialog.open) expire('offline');
    }
  };

  const submitCode = async () => {
    const code = codeInput.value.trim();
    if (!code) return codeInput.focus();
    let r: Response;
    try {
      r = await fetch(
        `${api}/code`,
        fetchOpts({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, code }) }),
      );
    } catch {
      return expire('offline');
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
    expire();
  };

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    start();
  };
  const close = () => dialog.close();

  openApp.addEventListener('click', (e) => {
    if (loading()) {
      e.preventDefault();
      pendingOpen = true;
      return;
    }
    watchOpen();
  });
  qrLink.addEventListener('click', (e) => {
    if (loading()) e.preventDefault();
  });
  for (const b of dialog.querySelectorAll<HTMLElement>('[data-r="close"]')) b.addEventListener('click', close);
  el('code-open').addEventListener('click', () => {
    codeForm.classList.remove('skl-hidden');
    codeInput.focus();
  });
  el('code-submit').addEventListener('click', submitCode);
  el('refresh').addEventListener('click', start);
  codeInput.addEventListener('input', clearCodeError);
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCode();
    }
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    stop();
    (doc.activeElement as HTMLElement | null)?.blur();
    options.onClose?.();
  });
  const onKey = (e: KeyboardEvent) => {
    if (!dialog.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    // Enter in the scan view = the app button; the field and buttons handle Enter themselves.
    if (e.key === 'Enter' && current === 'scan' && !isExpired()) {
      const tgt = e.target as HTMLElement;
      if (dialog.contains(tgt) && tgt.closest('button, input, a')) return;
      e.preventDefault();
      openApp.click();
    }
  };
  doc.addEventListener('keydown', onKey);

  return {
    open,
    close,
    destroy() {
      stop();
      doc.removeEventListener('keydown', onKey);
      if (dialog.open) dialog.close();
      dialog.remove();
    },
    element: dialog,
  };
}

export { SK_LOGO } from './logo.js';
