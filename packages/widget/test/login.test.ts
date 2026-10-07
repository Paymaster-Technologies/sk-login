// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CodeResult, type InitResponse, type SkLoginTransport, type StatusResponse, httpTransport, mountSkLogin } from '../src/login.js';

const INIT: InitResponse = {
  sid: 'sid-1',
  payloadUrl: 'https://secretkeeper.net/auth?v=1&sid=sid-1&target=demo',
  schemeUrl: 'sk://auth?v=1&sid=sid-1&target=demo',
  ttlMs: 120_000,
  qrSvg: '<svg viewBox="0 0 1 1"></svg>',
};

/** A scripted server: `status` answers from the queue, the last answer repeats. */
function fakeTransport(states: StatusResponse[], extra: Partial<SkLoginTransport> = {}) {
  const queue = [...states];
  const transport = {
    init: vi.fn(async () => INIT),
    status: vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0]!)),
    ...extra,
  } as SkLoginTransport & { init: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
  return transport;
}

const view = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-view]')).find((v) => !v.classList.contains('skl-hidden'))?.dataset.view;
const hidden = (el: Element) => el.classList.contains('skl-hidden');

let container: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('inline mode', () => {
  it('renders into the container, requests the QR at once, shows the recovery link, hides the close button', async () => {
    const transport = fakeTransport([{ state: 'new' }]);
    const w = mountSkLogin({
      container,
      transport,
      lang: 'en',
      recoveryLink: { text: 'No access to Secret Keeper?', href: '/recover' },
      onSuccess: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(container.contains(w.element)).toBe(true);
    expect(w.element.classList.contains('skl-inline')).toBe(true);
    expect(w.element.tagName).toBe('DIV');
    expect(transport.init).toHaveBeenCalledTimes(1);
    expect(w.element.querySelector('[data-r="qr-link"]')!.classList.contains('loading')).toBe(false);
    expect(w.element.querySelector('[data-r="qr"]')!.innerHTML).toContain('<svg');
    const link = w.element.querySelector<HTMLAnchorElement>('[data-r="recovery"]')!;
    expect(link.textContent).toBe('No access to Secret Keeper?');
    expect(link.getAttribute('href')).toBe('/recover');
    // The final views offer a new attempt instead of "Close".
    expect(w.element.querySelector('[data-view="timeout"] [data-r="close"]')!.textContent).toBe('Try again');
  });

  it('autoStart: false waits for open()', async () => {
    const transport = fakeTransport([{ state: 'new' }]);
    const w = mountSkLogin({ container, transport, autoStart: false, onSuccess: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.init).not.toHaveBeenCalled();
    expect(hidden(w.element)).toBe(true);
    w.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.init).toHaveBeenCalledTimes(1);
    expect(hidden(w.element)).toBe(false);
  });

  it('recovery link with onClick only stays on the page', async () => {
    const onClick = vi.fn();
    const w = mountSkLogin({ container, transport: fakeTransport([{ state: 'new' }]), recoveryLink: { text: 'Help', onClick }, onSuccess: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    const link = w.element.querySelector<HTMLAnchorElement>('[data-r="recovery"]')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('complete', () => {
  it('runs once after authenticated, keeps the sheet open and locked, then onSuccess with the merged extra', async () => {
    const transport = fakeTransport([{ state: 'challenged' }, { state: 'authenticated', token: 't-1' }]);
    let resolve!: (v: Record<string, unknown>) => void;
    const complete = vi.fn(() => new Promise<Record<string, unknown>>((r) => (resolve = r)));
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    const w = mountSkLogin({ container, transport, pollMs: 1000, complete, onSuccess, onClose });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(view(w.element)).toBe('challenged');
    await vi.advanceTimersByTimeAsync(1000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('sid-1', { token: 't-1' });
    expect(view(w.element)).toBe('completing');
    expect(hidden(w.element.querySelector('[data-r="ttl"]')!)).toBe(true);
    // Polling stopped: no second completion even if the server keeps answering.
    await vi.advanceTimersByTimeAsync(3000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(transport.status).toHaveBeenCalledTimes(2);
    // Locked: close() is ignored while complete runs.
    w.close();
    expect(onClose).not.toHaveBeenCalled();
    expect(hidden(w.element)).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
    resolve({ session: 's-9' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledWith({ token: 't-1', session: 's-9' });
    expect(hidden(w.element)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a rejection is shown as an error view with the message, no retry, no onSuccess', async () => {
    const transport = fakeTransport([{ state: 'authenticated' }]);
    const complete = vi.fn(async () => {
      throw new Error('Browser binding failed');
    });
    const onSuccess = vi.fn();
    const onCompleteError = vi.fn();
    const w = mountSkLogin({ container, transport, pollMs: 1000, complete, onSuccess, onCompleteError });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(view(w.element)).toBe('failed');
    expect(w.element.querySelector('[data-r="failed-text"]')!.textContent).toBe('Browser binding failed');
    expect(onCompleteError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('without complete the sign-in finishes as before', async () => {
    const transport = fakeTransport([{ state: 'authenticated', token: 't' }]);
    const onSuccess = vi.fn();
    mountSkLogin({ container, transport, pollMs: 1000, onSuccess });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSuccess).toHaveBeenCalledWith({ token: 't' });
  });
});

describe('manual code', () => {
  const lateChallenged = async (w: { element: HTMLElement }) => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(view(w.element)).toBe('challenged');
    // Past half of the TTL without confirmation.
    await vi.advanceTimersByTimeAsync(70_000);
  };

  it('is offered after half the TTL by default', async () => {
    const transport = fakeTransport([{ state: 'challenged' }], { submitCode: vi.fn(async (): Promise<CodeResult> => ({ kind: 'wrong' })) });
    const w = mountSkLogin({ container, transport, pollMs: 1000, onSuccess: () => {} });
    await lateChallenged(w);
    expect(hidden(w.element.querySelector('[data-r="code-hint"]')!)).toBe(false);
  });

  it('manualCode: false hides the hint and the field', async () => {
    const transport = fakeTransport([{ state: 'challenged' }], { submitCode: vi.fn(async (): Promise<CodeResult> => ({ kind: 'wrong' })) });
    const w = mountSkLogin({ container, transport, pollMs: 1000, manualCode: false, onSuccess: () => {} });
    await lateChallenged(w);
    expect(hidden(w.element.querySelector('[data-r="code-hint"]')!)).toBe(true);
    expect(hidden(w.element.querySelector('[data-r="code-form"]')!)).toBe(true);
  });

  it('a transport without submitCode never offers the code', async () => {
    const w = mountSkLogin({ container, transport: fakeTransport([{ state: 'challenged' }]), pollMs: 1000, onSuccess: () => {} });
    await lateChallenged(w);
    expect(hidden(w.element.querySelector('[data-r="code-hint"]')!)).toBe(true);
  });

  it('submitCode results: wrong keeps the field, denied shows the refusal, ok finishes', async () => {
    const results: CodeResult[] = [{ kind: 'wrong' }, { kind: 'denied', reason: 'blocked', message: 'Not today' }];
    const submitCode = vi.fn(async () => results.shift() ?? ({ kind: 'ok', extra: { token: 'x' } } as CodeResult));
    const onDenied = vi.fn();
    const w = mountSkLogin({ container, transport: fakeTransport([{ state: 'challenged' }], { submitCode }), pollMs: 1000, onSuccess: () => {}, onDenied });
    await lateChallenged(w);
    const input = w.element.querySelector<HTMLInputElement>('[data-r="code"]')!;
    const submit = w.element.querySelector<HTMLButtonElement>('[data-r="code-submit"]')!;
    input.value = '123456';
    submit.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(submitCode).toHaveBeenCalledWith('sid-1', '123456');
    expect(input.value).toBe('');
    expect(input.classList.contains('error')).toBe(true);
    input.value = '654321';
    submit.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(view(w.element)).toBe('denied');
    expect(w.element.querySelector('[data-r="denied-text"]')!.textContent).toBe('Not today');
    expect(onDenied).toHaveBeenCalledWith('blocked', 'Not today');
  });
});

describe('cancel', () => {
  it('close() with a request in flight calls transport.cancel(sid) and ignores late answers', async () => {
    const cancel = vi.fn(async () => {});
    const transport = fakeTransport([{ state: 'new' }], { cancel });
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    const w = mountSkLogin({ container, transport, pollMs: 1000, onSuccess, onClose });
    await vi.advanceTimersByTimeAsync(0);
    w.close();
    expect(cancel).toHaveBeenCalledWith('sid-1');
    expect(onClose).toHaveBeenCalledTimes(1);
    const calls = transport.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(transport.status.mock.calls.length).toBe(calls);
    expect(onSuccess).not.toHaveBeenCalled();
    // A second close does not cancel twice.
    w.close();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('is not sent after authenticated, and its failure goes to onCancelError', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('500');
    });
    const onCancelError = vi.fn();
    let resolve!: (v: void) => void;
    const complete = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const transport = fakeTransport([{ state: 'authenticated' }], { cancel });
    const w = mountSkLogin({ container, transport, pollMs: 1000, complete, onSuccess: () => {}, onCancelError });
    await vi.advanceTimersByTimeAsync(1000);
    expect(view(w.element)).toBe('completing');
    w.close();
    expect(cancel).not.toHaveBeenCalled();
    resolve();
    await vi.advanceTimersByTimeAsync(0);

    // A fresh widget: cancel fails, the error is reported, the sheet is closed anyway.
    const w2 = mountSkLogin({ container, transport: fakeTransport([{ state: 'new' }], { cancel }), pollMs: 1000, onSuccess: () => {}, onCancelError });
    await vi.advanceTimersByTimeAsync(0);
    w2.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onCancelError).toHaveBeenCalledTimes(1);
    expect(hidden(w2.element)).toBe(true);
  });

  it('after the server reported expired there is nothing to cancel', async () => {
    const cancel = vi.fn(async () => {});
    const w = mountSkLogin({ container, transport: fakeTransport([{ state: 'expired' }], { cancel }), pollMs: 1000, onSuccess: () => {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(hidden(w.element.querySelector('[data-r="expired"]')!)).toBe(false);
    w.close();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('dialog mode', () => {
  it('opens a modal dialog on open(), Escape closes it and cancels the request', async () => {
    const cancel = vi.fn(async () => {});
    const w = mountSkLogin({ transport: fakeTransport([{ state: 'new' }], { cancel }), onSuccess: () => {} });
    const dialog = w.element as HTMLDialogElement;
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.open).toBe(false);
    w.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(dialog.open).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.open).toBe(false);
    expect(cancel).toHaveBeenCalledWith('sid-1');
    w.destroy();
    expect(document.body.contains(dialog)).toBe(false);
  });
});

describe('httpTransport', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('calls the module routes and maps the code answers', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const t = httpTransport('/api/sk/', (init = {}) => ({ credentials: 'same-origin', ...init, headers: { 'x-csrf': '1', ...(init.headers as Record<string, string> | undefined) } }));

    fetchMock.mockResolvedValueOnce(json(200, INIT));
    expect(await t.init()).toEqual(INIT);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/sk/init');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');

    fetchMock.mockResolvedValueOnce(json(200, { state: 'challenged' }));
    expect(await t.status('a b')).toEqual({ state: 'challenged' });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/sk/status?sid=a%20b');

    fetchMock.mockResolvedValueOnce(json(200, { ok: true, token: 't' }));
    expect(await t.submitCode!('s', '1')).toEqual({ kind: 'ok', extra: { token: 't' } });
    expect(JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string)).toEqual({ sid: 's', code: '1' });
    expect(((fetchMock.mock.calls[2]![1] as RequestInit).headers as Record<string, string>)['x-csrf']).toBe('1');
    fetchMock.mockResolvedValueOnce(json(400, { error: 'code-invalid' }));
    expect(await t.submitCode!('s', '2')).toEqual({ kind: 'wrong' });
    fetchMock.mockResolvedValueOnce(json(403, { denied: true, reason: 'blocked', message: 'No' }));
    expect(await t.submitCode!('s', '3')).toEqual({ kind: 'denied', reason: 'blocked', message: 'No' });
    fetchMock.mockResolvedValueOnce(json(410, { error: 'code-invalid' }));
    expect(await t.submitCode!('s', '4')).toEqual({ kind: 'stale' });
    expect(t.cancel).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
