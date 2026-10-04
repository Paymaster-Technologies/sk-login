// Store for sign-in requests. A request lives for minutes, hence process
// memory by default. Several replicas behind a balancer without sticky
// sessions need a shared implementation (Redis etc.) of this same
// interface; a record must survive JSON.stringify, including the `user`
// from the admission decision.

import type { RequestContext } from './context.js';

export type PendingState = 'new' | 'challenged' | 'authenticated' | 'denied' | 'cancelled' | 'used';

export interface Pending<User = unknown> {
  sid: string;
  createdAt: number;
  /** Request deadline; a settled one (authenticated/denied/cancelled) lives
   *  one more TTL so the browser has time to pick up the outcome. */
  expiresAt: number;
  state: PendingState;
  /** The browser that received the sid (for challenge v2). */
  ctx?: RequestContext;
  /** Authenticated address of the request sender (after step 3). */
  sender?: string;
  code?: string;
  codeAttempts: number;
  /** Admitted user (state authenticated): for the session. */
  user?: User;
  /** Why access was refused (state denied). */
  denied?: string;
}

/** Store keyed by sid; the same shape serves sign-in requests
 *  (`PendingStore`) and data requests (`DataRequestStore` in request.ts). */
export interface SidStore<Entry extends { sid: string }> {
  get(sid: string): Promise<Entry | undefined>;
  /** `ttlMs` is how long until the record can be dropped (with a margin for polling). */
  set(entry: Entry, ttlMs: number): Promise<void>;
  delete(sid: string): Promise<void>;
}

export type PendingStore<User = unknown> = SidStore<Pending<User>>;

/** Process memory: expired records are swept on every access. */
export class MemorySidStore<Entry extends { sid: string }> implements SidStore<Entry> {
  private readonly map = new Map<string, { entry: Entry; dropAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(sid: string): Promise<Entry | undefined> {
    this.sweep();
    return this.map.get(sid)?.entry;
  }

  async set(entry: Entry, ttlMs: number): Promise<void> {
    this.map.set(entry.sid, { entry, dropAt: this.now() + ttlMs });
  }

  async delete(sid: string): Promise<void> {
    this.map.delete(sid);
  }

  get size(): number {
    this.sweep();
    return this.map.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [sid, { dropAt }] of this.map) if (dropAt <= now) this.map.delete(sid);
  }
}

export class MemoryPendingStore<User = unknown> extends MemorySidStore<Pending<User>> {}
