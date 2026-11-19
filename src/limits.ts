/**
 * Resource limits for the hosted server: who a caller is, how often they may
 * call, and how much image work runs at once.
 *
 * Everything here is in-memory and per process. That is enough to stop one
 * caller from exhausting a single instance; it is not a durable quota.
 */
import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { GetScreenshotError } from "./api.js";

// ---------------------------------------------------------------------------
// Caller identity
// ---------------------------------------------------------------------------

/**
 * A stable identifier for an API key that is safe to keep in memory and to
 * compare: a truncated SHA-256. The key itself is never stored.
 */
export function keyId(apiKey: string): string {
  return `key:${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 32)}`;
}

function expandIPv6(address: string): string[] | undefined {
  let text = address;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const parts = (v4[2] as string).split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    const [a, b, c, d] = parts as [number, number, number, number];
    text = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? (halves[0] as string).split(":") : [];
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return groups.map((g) => Number.parseInt(g, 16).toString(16));
}

/**
 * Normalises a client address for rate limiting. IPv4 stays as it is. IPv6 is
 * reduced to its /64, because one subscriber controls a whole /64 and could
 * otherwise use a fresh address for every request. IPv4-mapped IPv6 becomes
 * the IPv4 address.
 */
export function ipId(address: string | undefined): string {
  const raw = (address ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIPv4(raw)) return `ip:${raw}`;
  if (isIPv6(raw)) {
    const groups = expandIPv6(raw);
    if (groups) {
      const mapped = groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff";
      if (mapped) {
        const hi = Number.parseInt(groups[6] as string, 16);
        const lo = Number.parseInt(groups[7] as string, 16);
        return `ip:${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      }
      return `ip:${groups.slice(0, 4).join(":")}::/64`;
    }
  }
  return `ip:${raw || "unknown"}`;
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Fixed one-minute windows per key. The map is cleared at every window change, so it cannot grow without bound. */
export class MinuteLimiter {
  private window = -1;
  private readonly counts = new Map<string, number>();

  constructor(
    readonly limit: number,
    private readonly now: () => number = Date.now,
    private readonly windowMs = 60_000,
  ) {}

  private roll(): void {
    const window = Math.floor(this.now() / this.windowMs);
    if (window !== this.window) {
      this.window = window;
      this.counts.clear();
    }
  }

  /** True when `key` still has room in the current window. Does not count. */
  peek(key: string): LimitResult {
    this.roll();
    if ((this.counts.get(key) ?? 0) < this.limit) return { ok: true };
    const elapsed = this.now() % this.windowMs;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - elapsed) / 1000)) };
  }

  /** Counts one event for `key`, or refuses when the window is full. */
  take(key: string): LimitResult {
    const state = this.peek(key);
    if (state.ok) this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return state;
  }
}

/** Per-address and global counters that reset at 00:00 UTC. Counts attempts, since every API call uses quota. */
export class DailyLimiter {
  private day = "";
  private total = 0;
  private readonly perIp = new Map<string, number>();

  constructor(
    readonly limitPerIp: number,
    readonly limitGlobal: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryConsume(ip: string): { ok: true } | { ok: false; scope: "ip" | "global" } {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.total = 0;
      this.perIp.clear();
    }
    if (this.total >= this.limitGlobal) return { ok: false, scope: "global" };
    const used = this.perIp.get(ip) ?? 0;
    if (used >= this.limitPerIp) return { ok: false, scope: "ip" };
    this.perIp.set(ip, used + 1);
    this.total += 1;
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Image work gate
// ---------------------------------------------------------------------------

export const DEFAULT_IMAGE_CONCURRENCY = 3;
export const DEFAULT_IMAGE_QUEUE = 24;
export const DEFAULT_IMAGE_WAIT_MS = 20_000;

export interface ImageGateOptions {
  /** Jobs that may run at once. */
  concurrency?: number | undefined;
  /** Jobs that may wait for a slot. Beyond this, new jobs are refused at once. */
  maxQueue?: number | undefined;
  /** Longest a job may wait for a slot before it is refused. */
  maxWaitMs?: number | undefined;
}

export function serverBusyError(detail: string): GetScreenshotError {
  return new GetScreenshotError(
    "server_busy",
    `The server is busy processing other images (${detail}). Retry in a few seconds.`,
  );
}

interface Waiter {
  start: () => void;
  cancel: (err: Error) => void;
}

/**
 * A semaphore with a bounded queue around the memory- and CPU-heavy work:
 * downloading a capture, decoding and resizing it, and diffing two images.
 * Without it, a burst of calls would each hold tens of megabytes at once.
 */
export class ImageGate {
  readonly concurrency: number;
  readonly maxQueue: number;
  readonly maxWaitMs: number;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(options: ImageGateOptions = {}) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_IMAGE_CONCURRENCY));
    this.maxQueue = Math.max(0, Math.trunc(options.maxQueue ?? DEFAULT_IMAGE_QUEUE));
    this.maxWaitMs = Math.max(0, options.maxWaitMs ?? DEFAULT_IMAGE_WAIT_MS);
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** True when a new job would be refused immediately. */
  get saturated(): boolean {
    return this.active >= this.concurrency && this.queue.length >= this.maxQueue;
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new GetScreenshotError("cancelled", "The request was cancelled."));
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(serverBusyError("too many requests are already waiting"));
    }
    return new Promise<void>((resolve, reject) => {
      const remove = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        start: () => {
          remove();
          resolve();
        },
        cancel: (err) => {
          remove();
          reject(err);
        },
      };
      const timer = setTimeout(
        () => waiter.cancel(serverBusyError(`no slot became free within ${Math.round(this.maxWaitMs / 1000)} s`)),
        this.maxWaitMs,
      );
      const onAbort = () => waiter.cancel(new GetScreenshotError("cancelled", "The request was cancelled."));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue[0];
    if (next) {
      // The slot passes straight to the next waiter; `active` stays the same.
      next.start();
    } else {
      this.active -= 1;
    }
  }

  /** Runs `job` once a slot is free. Rejects with code `server_busy` when the queue is full or the wait is too long. */
  async run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await job();
    } finally {
      this.release();
      collectGarbage();
    }
  }
}

/**
 * An image job leaves tens of megabytes of pixel buffers behind. V8 frees them
 * only at its next major collection, so under load several jobs' worth of dead
 * buffers pile up. When Node was started with --expose-gc (the Dockerfile does
 * this) a collection is requested after each job, which keeps the process
 * close to what is actually in use. Without the flag this does nothing.
 */
function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
}

function envInt(name: string, fallback: number, min: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

let sharedGate: ImageGate | undefined;

/** The process-wide gate, sized from IMAGE_CONCURRENCY / IMAGE_QUEUE_MAX / IMAGE_QUEUE_WAIT_MS. */
export function defaultImageGate(): ImageGate {
  sharedGate ??= new ImageGate({
    concurrency: envInt("IMAGE_CONCURRENCY", DEFAULT_IMAGE_CONCURRENCY, 1),
    maxQueue: envInt("IMAGE_QUEUE_MAX", DEFAULT_IMAGE_QUEUE, 0),
    maxWaitMs: envInt("IMAGE_QUEUE_WAIT_MS", DEFAULT_IMAGE_WAIT_MS, 0),
  });
  return sharedGate;
}
