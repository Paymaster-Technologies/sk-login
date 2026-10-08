// The sheet shared by the sign-in and the data request popups: a <dialog>
// styled like the Secret Keeper app sheets (a bottom sheet on a narrow
// screen, a centered card on a wide one), the QR block with the app button, the TTL
// countdown in the bar, the nested "QR expired / offline" sheet with
// "Refresh", the "app did not open" hint and the final info views. The
// owner (login.ts, request.ts) supplies the flow-specific views, the init
// request and the status polling.
//
// With `container` the same sheet is rendered inline into the given element
// instead of a modal dialog (a second factor page, a sign-in card): no
// backdrop, no close button, no Esc; "Close" on the final views becomes
// "Try again".
//
// The sheet closes in two ways: `close()` (the person or the page) runs
// the owner's `onBeforeClose`, which may keep it open and take over (the
// server is told about the cancel first); `done()` closes after a result
// and bypasses it. `onClose` gets the reason.

import { SK_LOGO } from './logo.js';
import { ensureStyles } from './styles.js';

export type Lang = 'ru' | 'en';

/** Why the sheet closed: the person or the page (`user`), or a result that the owner reports right after (`result`). */
export type CloseReason = 'user' | 'result';

/** Texts common to both popups. */
export interface SheetTexts {
  close: string;
  scan1: string;
  scanLink: string;
  scan2: string;
  scan3: string;
  noapp1: string;
  noappLink: string;
  cancelled: string;
  timeout: string;
  expired: string;
  offline: string;
  refresh: string;
  /** The button on the final views in the inline mode (there is nothing to close). */
  retry: string;
}

export const sheetTexts: Record<Lang, SheetTexts> = {
  ru: {
    close: 'Закрыть',
    scan1: 'Откройте приложение ',
    scanLink: 'Secret Keeper',
    scan2: ' на другом устройстве, нажмите значок ',
    scan3: ' в верхней панели и наведите камеру на QR-код:',
    noapp1: 'Приложение не открылось? Установите ',
    noappLink: 'Secret Keeper',
    cancelled: 'Вы отклонили этот запрос в Secret Keeper.',
    timeout: 'Время ожидания истекло: подтверждение из Secret Keeper не пришло. Попробуйте ещё раз.',
    expired: 'QR-код устарел',
    offline: 'Нет связи с сайтом',
    refresh: 'Обновить',
    retry: 'Попробовать снова',
  },
  en: {
    close: 'Close',
    scan1: 'Open the ',
    scanLink: 'Secret Keeper',
    scan2: ' app on another device, tap the ',
    scan3: ' icon in the top bar and point the camera at the QR code:',
    noapp1: 'The app did not open? Install ',
    noappLink: 'Secret Keeper',
    cancelled: 'You declined this request in Secret Keeper.',
    timeout: 'Time ran out: no confirmation came from Secret Keeper. Try again.',
    expired: 'The QR code has expired',
    offline: 'Could not reach the site',
    refresh: 'Refresh',
    retry: 'Try again',
  },
};

/** Options common to both popups. */
export interface SheetOptions {
  /** Module route prefix, without a trailing slash. Defaults to `/api/sk`. */
  apiBase?: string;
  lang?: Lang;
  onCancelled?: () => void;
  /**
   * The sheet closed. `user`: the close button, Esc, the scrim, "Close" on
   * a final view or the page's `close()`. `result`: the sheet closed itself
   * after a result and `onSuccess` / `onFilled` follows right away.
   */
  onClose?: (reason: CloseReason) => void;
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
  /** Render inline into this element instead of a modal dialog. */
  container?: HTMLElement;
}

/** What `init` returns for the QR block (both flows). */
export interface QrInit {
  sid: string;
  schemeUrl: string;
  ttlMs: number;
  qrSvg?: string;
}

export interface SheetConfig {
  options: SheetOptions;
  texts: SheetTexts;
  title: string;
  /** Caption of the app button under the QR. */
  action: string;
  /** HTML before the scan hint (the data request intro); has `data-r="intro"`. */
  intro?: string;
  /** HTML under the views, shown with every view except the busy ones (a recovery link). */
  footer?: string;
  /** HTML of the `challenged` view; gets the resolved logo URL. */
  challenged: (logo: string) => string;
  /** Extra views; each a `<section data-view=…>`. A function gets the resolved logo URL. */
  extraViews?: string | ((logo: string) => string);
  /** Views shown as an info sheet (no bar): the common cancelled and timeout plus the owner's. */
  infoViews?: string[];
  /** Views while a server call runs (finishing, cancelling): no countdown, no footer; the owner locks the sheet. */
  busyViews?: string[];
}

export type ExpireReason = 'expired' | 'offline';

/** How long we wait for the system to react to the custom scheme before
 *  deciding there is no app: a blur or a hidden tab means something opened. */
const OPEN_APP_GRACE_MS = 2000;
/** The last seconds of the countdown are highlighted. */
const SOON_MS = 10_000;

export const SCAN_ICON =
  '<svg class="skl-hint-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zm8-12v8h8V3h-8zm6 6h-4V5h4v4zm-6 4h2v2h-2v-2zm2 2h2v2h-2v-2zm-2 2h2v2h-2v-2zm4 0h2v2h-2v-2zm2 2h2v2h-2v-2zm-4 0h2v2h-2v-2zm2-6h2v2h-2v-2zm2 2h2v2h-2v-2z"/></svg>';
export const ICON = (body: string, cls = '') =>
  `<svg class="skl-info-icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const CANCEL_ICON = ICON('<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>');
export const CLOCK_ICON = ICON('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>');
export const ERROR_ICON = ICON('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 15.5v.5"/>', 'danger');

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** The waiting view: the logo in a spinning ring plus a lead. */
export function waitingHtml(logo: string, lead: string, extra = '', leadRef?: string): string {
  return `<span class="skl-logo"><img src="${esc(logo)}" alt="Secret Keeper" width="56" height="56"></span>
      <p class="skl-secondary skl-lead"${leadRef ? ` data-r="${leadRef}"` : ''}>${esc(lead)}</p>${extra}`;
}

/** A final view: an icon, a text and one button. The button is the sheet's
 *  close ("Try again" inline) unless the owner gives it its own ref. */
export function infoViewHtml(name: string, icon: string, text: string, button: string, textRef?: string, buttonRef = 'close'): string {
  return `<section data-view="${name}" class="skl-hidden skl-info">
      ${icon}
      <p class="skl-info-text"${textRef ? ` data-r="${textRef}"` : ''}>${esc(text)}</p>
      <button class="skl-btn outline" type="button" data-r="${buttonRef}">${esc(button)}</button>
    </section>`;
}

export interface Sheet {
  /** The dialog, or the inline root when `container` is set. */
  root: HTMLElement;
  /** Inline mode (`container`). */
  inline: boolean;
  uid: string;
  api: string;
  logo: string;
  pollMs: number;
  el<T extends HTMLElement = HTMLElement>(ref: string): T;
  fetchOpts(init?: RequestInit): RequestInit;
  /** Current view name. */
  current(): string;
  show(view: string): void;
  /** A final view instead of the waiting one: the window closes and opens
   *  again with its own appearance animation, not a swap under the same title.
   *  Inline: a plain view switch. */
  reopen(view: string): void;
  /** New request: the QR slot shows a spinner, the scan view is shown. */
  loading(): void;
  /** The QR arrived: draw it, start the TTL countdown. */
  showQr(init: QrInit): void;
  /** The app scanned: the server restarted the TTL. */
  renew(): void;
  alive(): boolean;
  /** Half the TTL has passed without an answer. */
  late(): boolean;
  isExpired(): boolean;
  isOpen(): boolean;
  /** The code expired or the server is unreachable: the nested sheet with
   *  "Refresh". If the TTL ran out after the scan, the final "timeout" view. */
  expire(reason?: ExpireReason): void;
  /** Stop timers (polling is the owner's; it is stopped via `onStop`). */
  stop(): void;
  open(): void;
  /** Close (dialog) or hide (inline) by the person or the page: runs `onBeforeClose`
   *  first. Ignored while locked; `destroy` is not. */
  close(): void;
  /** Close after a result (`onClose('result')`): no `onBeforeClose`, no lock. */
  done(): void;
  /** While locked the sheet ignores close: the close button, Esc, the scrim and `close()`. */
  lock(on: boolean): void;
  destroy(): void;
  /** The owner's polling loop and request start. */
  onRefresh(cb: () => void): void;
  onStop(cb: () => void): void;
  /** Called by `close()` before the sheet closes; return `false` to keep it open and take over. */
  onBeforeClose(cb: () => boolean | void): void;
}

export function createSheet(cfg: SheetConfig): Sheet {
  const doc = document;
  ensureStyles(doc);
  const { options, texts: t } = cfg;
  const api = (options.apiBase ?? '/api/sk').replace(/\/$/, '');
  const logo = options.logoUrl ?? SK_LOGO;
  const skSite = options.skSiteUrl ?? 'https://secretkeeper.net';
  const pollMs = options.pollMs ?? 2000;
  const uid = `skl${Math.random().toString(36).slice(2, 8)}`;
  const infoViews = new Set(['cancelled', 'timeout', ...(cfg.infoViews ?? [])]);
  const busyViews = new Set(cfg.busyViews ?? []);
  const inline = !!options.container;

  const dialog = inline ? null : doc.createElement('dialog');
  const root: HTMLElement = dialog ?? doc.createElement('div');
  root.className = inline ? 'skl skl-inline skl-hidden' : 'skl';
  if (options.theme) root.dataset.theme = options.theme;
  root.setAttribute('aria-labelledby', `${uid}-title`);
  if (inline) root.setAttribute('role', 'group');
  root.innerHTML = `
<div class="skl-inner">
  <div class="skl-handle" aria-hidden="true"></div>
  <div class="skl-bar">
    <button class="skl-close" type="button" aria-label="${esc(t.close)}" title="${esc(t.close)}" data-r="close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <h2 class="skl-title" id="${uid}-title">${esc(cfg.title)}</h2>
    <span class="skl-spacer"><span class="skl-ttl skl-hidden" data-r="ttl" aria-live="off"></span></span>
  </div>
  <div class="skl-body">
    <section data-view="scan">
      ${cfg.intro ?? ''}
      <p class="skl-secondary skl-hint">${esc(t.scan1)}<a href="${esc(skSite)}" target="_blank" rel="noopener">${esc(t.scanLink)}</a>${esc(t.scan2)}${SCAN_ICON}${esc(t.scan3)}</p>
      <a class="skl-qr loading" href="#" data-r="qr-link" aria-label="QR">
        <span data-r="qr"></span>
        <img class="skl-qr-logo" src="${esc(logo)}" alt="" width="44" height="44">
        <span class="skl-qr-spinner" aria-hidden="true"></span>
      </a>
      <a class="skl-btn skl-action" href="#" data-r="open">${esc(cfg.action)}</a>
      <p class="skl-secondary skl-noapp skl-hidden" data-r="noapp">${esc(t.noapp1)}<a href="${esc(skSite)}" target="_blank" rel="noopener">${esc(t.noappLink)}</a></p>
    </section>
    <section data-view="challenged" class="skl-hidden">
      ${cfg.challenged(logo)}
    </section>
    ${typeof cfg.extraViews === 'function' ? cfg.extraViews(logo) : (cfg.extraViews ?? '')}
    ${infoViewHtml('cancelled', CANCEL_ICON, t.cancelled, t.close)}
    ${infoViewHtml('timeout', CLOCK_ICON, t.timeout, t.close)}
    ${cfg.footer ? `<div class="skl-footer" data-r="footer">${cfg.footer}</div>` : ''}
  </div>
  <div class="skl-expired skl-hidden" role="alertdialog" aria-labelledby="${uid}-expired" data-r="expired">
    <div class="skl-expired-card">
      <svg class="skl-expired-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>
      <p class="skl-expired-title" id="${uid}-expired" data-r="expired-title"></p>
      <button class="skl-btn skl-action" type="button" data-r="refresh">${esc(t.refresh)}</button>
    </div>
  </div>
</div>`;
  (options.container ?? doc.body).appendChild(root);

  const el = <T extends HTMLElement = HTMLElement>(r: string) => root.querySelector<T>(`[data-r="${r}"]`)!;
  const views = Array.from(root.querySelectorAll<HTMLElement>('[data-view]'));
  const qr = el('qr');
  const qrLink = el<HTMLAnchorElement>('qr-link');
  const openApp = el<HTMLAnchorElement>('open');
  const noApp = el('noapp');
  const ttl = el('ttl');
  const expired = el('expired');
  const expiredTitle = el('expired-title');
  const footer = root.querySelector<HTMLElement>('[data-r="footer"]');
  // Inline: the final views offer a new attempt instead of closing.
  if (inline) for (const b of root.querySelectorAll<HTMLElement>('.skl-info [data-r="close"]')) b.textContent = t.retry;

  let current = 'scan';
  let ttlTimer: number | undefined;
  let openTimer: number | undefined;
  let startedAt = 0;
  let ttlMs = 0;
  let pendingOpen = false;
  let inlineOpen = false;
  let locked = false;
  /** Set by `close()` / `done()` right before the dialog closes; `reopen` and `destroy` leave it unset. */
  let closeReason: CloseReason | null = null;
  let refresh: () => void = () => {};
  let stopOwner: () => void = () => {};
  let beforeClose: () => boolean | void = () => {};

  const isOpen = () => (dialog ? dialog.open : inlineOpen);
  const loading = () => qrLink.classList.contains('loading');
  const isExpired = () => !expired.classList.contains('skl-hidden');
  const alive = () => Date.now() - startedAt <= ttlMs;
  const late = () => Date.now() - startedAt >= ttlMs / 2;

  const syncTtl = () => {
    ttl.classList.toggle('skl-hidden', infoViews.has(current) || busyViews.has(current) || loading() || isExpired());
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

  const show = (name: string) => {
    current = name;
    for (const v of views) v.classList.toggle('skl-hidden', v.dataset.view !== name);
    // Final views are an info sheet: no bar (title, close, countdown), only
    // an icon, a text and "Close". The button is not focused: Chrome draws
    // a ring on it, and Esc and the scrim close the window anyway.
    const info = infoViews.has(name);
    root.classList.toggle('info', info);
    footer?.classList.toggle('skl-hidden', busyViews.has(name));
    syncTtl();
    if (info && !inline) (doc.activeElement as HTMLElement | null)?.blur();
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
    stopOwner();
    if (ttlTimer) window.clearInterval(ttlTimer);
    ttlTimer = undefined;
    cancelWatchOpen();
  };

  // The dialog's close event is queued, so it also arrives after `reopen`
  // (close + showModal) and `destroy`: those leave `closeReason` unset and
  // the page is not told.
  const closed = () => {
    const reason = closeReason;
    closeReason = null;
    if (!reason) return;
    stop();
    // The browser returns focus to the opener and after Esc draws a ring on it.
    if (!inline) (doc.activeElement as HTMLElement | null)?.blur();
    options.onClose?.(reason);
  };

  const reopen = (name: string) => {
    if (dialog) {
      if (dialog.open) dialog.close();
      show(name);
      dialog.showModal();
    } else {
      show(name);
    }
  };

  const expire = (reason: ExpireReason = 'expired') => {
    stop();
    if (reason === 'expired' && current === 'challenged') return reopen('timeout');
    expiredTitle.textContent = reason === 'offline' ? t.offline : t.expired;
    expired.classList.remove('skl-hidden');
    syncTtl();
    el('refresh').focus();
  };

  const loadingView = () => {
    pendingOpen = false;
    expired.classList.add('skl-hidden');
    noApp.classList.add('skl-hidden');
    qrLink.classList.add('loading');
    show('scan');
  };

  const showQr = (init: QrInit) => {
    ttlMs = init.ttlMs;
    qr.innerHTML = init.qrSvg ?? '';
    qrLink.href = init.schemeUrl;
    openApp.href = init.schemeUrl;
    qrLink.classList.remove('loading');
    renew();
    syncTtl();
    if (pendingOpen) {
      pendingOpen = false;
      openApp.click();
    }
  };

  const open = () => {
    if (isOpen()) return;
    if (dialog) dialog.showModal();
    else {
      inlineOpen = true;
      root.classList.remove('skl-hidden');
    }
    refresh();
  };
  const hide = (reason: CloseReason) => {
    closeReason = reason;
    if (dialog) {
      // The dialog's close event calls closed().
      dialog.close();
    } else {
      inlineOpen = false;
      root.classList.add('skl-hidden');
      closed();
    }
  };
  const close = () => {
    if (locked || !isOpen()) return;
    if (beforeClose() === false) return;
    hide('user');
  };
  const done = () => {
    if (!isOpen()) return;
    hide('result');
  };
  // Inline: "Try again" on a final view is a new request, not a close.
  const infoButton = () => (inline ? refresh() : close());

  openApp.addEventListener('click', (e) => {
    if (loading()) {
      // The QR has not arrived yet: remember the click, follow the link when it does.
      e.preventDefault();
      pendingOpen = true;
      return;
    }
    watchOpen();
  });
  qrLink.addEventListener('click', (e) => {
    if (loading()) e.preventDefault();
  });
  el('close').addEventListener('click', close);
  for (const b of root.querySelectorAll<HTMLElement>('.skl-info [data-r="close"]')) b.addEventListener('click', infoButton);
  el('refresh').addEventListener('click', () => refresh());
  if (dialog) {
    // Click on the scrim: inside .skl-inner the target is a descendant, outside it is the dialog itself.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) close();
    });
    // Esc in browsers that fire cancel before our keydown handler: route it through close() (the lock).
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close();
    });
    dialog.addEventListener('close', closed);
  }
  const onKey = (e: KeyboardEvent) => {
    if (!isOpen()) return;
    // Esc closes natively too (the cancel event), but not in every browser wrapper.
    if (e.key === 'Escape' && !inline) {
      e.preventDefault();
      close();
      return;
    }
    // Enter in the scan view = the app button. Without this showModal
    // focuses the close button and Enter closed the window. The field,
    // links and other buttons (e.g. "Refresh") handle Enter themselves.
    if (e.key === 'Enter' && current === 'scan' && !isExpired()) {
      const tgt = e.target as HTMLElement;
      if (inline && !root.contains(tgt)) return;
      if (root.contains(tgt) && tgt !== el('close') && tgt.closest('button, input, textarea, a')) return;
      e.preventDefault();
      openApp.click();
    }
  };
  doc.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', stop);

  return {
    root,
    inline,
    uid,
    api,
    logo,
    pollMs,
    el,
    fetchOpts: (init: RequestInit = {}): RequestInit => ({
      cache: 'no-store',
      credentials: options.credentials ?? 'same-origin',
      ...init,
      headers: { ...options.headers, ...(init.headers as Record<string, string> | undefined) },
    }),
    current: () => current,
    show,
    reopen,
    loading: loadingView,
    showQr,
    renew,
    alive,
    late,
    isExpired,
    isOpen,
    expire,
    stop,
    open,
    close,
    done,
    lock: (on) => {
      locked = on;
    },
    destroy() {
      stop();
      doc.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', stop);
      closeReason = null;
      if (dialog?.open) dialog.close();
      root.remove();
    },
    onRefresh: (cb) => {
      refresh = cb;
    },
    onStop: (cb) => {
      stopOwner = cb;
    },
    onBeforeClose: (cb) => {
      beforeClose = cb;
    },
  };
}
