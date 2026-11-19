/**
 * Short-lived storage for HTML documents that render_html hands to the capture
 * API as a URL.
 *
 * `HtmlStore` is the seam: the hosted server uses the in-memory implementation
 * (which is why it must run as a single instance); a shared store (Redis, GCS)
 * can implement the same interface later.
 *
 * Abuse limits: a per-caller cap on live documents, a global cap that rejects
 * instead of evicting, a short TTL and a small read count.
 */
import { randomBytes } from "node:crypto";
import { GetScreenshotError } from "./api.js";

export const HTML_TTL_MS = 5 * 60 * 1000;
export const HTML_MAX_READS = 3;
export const HTML_MAX_BYTES = 2 * 1024 * 1024;
export const HTML_MAX_DOCS = 200;
export const HTML_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** Live documents one caller may hold at a time. */
export const HTML_MAX_DOCS_PER_CALLER = 5;
export const HTML_ID_BYTES = 32;
/** base64url of 32 random bytes. */
export const HTML_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface StoredHtmlRef {
  id: string;
  expiresAt: number;
  expiresInSeconds: number;
}

/** Someone a document is charged to, with the number of live documents they may hold. */
export interface HtmlOwner {
  id: string;
  limit: number;
}

export interface HtmlStore {
  /**
   * Stores a document. Rejects with code `html_too_large` when it exceeds the
   * per-document limit, `too_many_documents` when one of the owners is at
   * their limit, and `html_store_full` when the store has no room. A full
   * store never evicts: other callers' documents are not ours to drop.
   */
  put(html: string | Buffer, owners?: readonly HtmlOwner[]): Promise<StoredHtmlRef>;
  /** Returns the document and counts one read, or undefined when unknown, expired or read out. */
  read(id: string): Promise<Buffer | undefined>;
  /** Removes a document. With `ownerId`, only if that owner holds it. Resolves to whether something was removed. */
  delete(id: string, ownerId?: string): Promise<boolean>;
  /** Stops background work. */
  close(): void;
}

export interface MemoryHtmlStoreOptions {
  ttlMs?: number | undefined;
  maxReads?: number | undefined;
  maxBytes?: number | undefined;
  maxDocs?: number | undefined;
  maxTotalBytes?: number | undefined;
  /** Sweep interval; 0 disables the timer (expiry is still enforced on read). */
  sweepIntervalMs?: number | undefined;
  now?: (() => number) | undefined;
}

interface Entry {
  data: Buffer;
  expiresAt: number;
  readsLeft: number;
  owners: readonly string[];
}

export function htmlTooLargeError(maxBytes: number, actualBytes: number): GetScreenshotError {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(2);
  return new GetScreenshotError(
    "html_too_large",
    `The HTML is ${mb(actualBytes)} MB; the limit is ${mb(maxBytes)} MB. ` +
      "Remove inlined images or data URIs, or split the page. Nothing was captured and no quota was used.",
  );
}

export class MemoryHtmlStore implements HtmlStore {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  private readonly ttlMs: number;
  private readonly maxReads: number;
  private readonly maxBytes: number;
  private readonly maxDocs: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: MemoryHtmlStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? HTML_TTL_MS;
    this.maxReads = options.maxReads ?? HTML_MAX_READS;
    this.maxBytes = options.maxBytes ?? HTML_MAX_BYTES;
    this.maxDocs = options.maxDocs ?? HTML_MAX_DOCS;
    this.maxTotalBytes = options.maxTotalBytes ?? HTML_MAX_TOTAL_BYTES;
    this.now = options.now ?? Date.now;
    const interval = options.sweepIntervalMs ?? 30_000;
    if (interval > 0) {
      this.timer = setInterval(() => this.sweep(), interval);
      this.timer.unref();
    }
  }

  /** Number of documents currently held. */
  get size(): number {
    return this.entries.size;
  }

  /** Bytes currently held. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Live documents charged to `ownerId`. */
  countFor(ownerId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.owners.includes(ownerId)) count += 1;
    return count;
  }

  async put(html: string | Buffer, owners: readonly HtmlOwner[] = []): Promise<StoredHtmlRef> {
    const data = typeof html === "string" ? Buffer.from(html, "utf8") : html;
    if (data.byteLength === 0) {
      throw new GetScreenshotError("invalid_input", "The HTML document is empty.");
    }
    if (data.byteLength > this.maxBytes) throw htmlTooLargeError(this.maxBytes, data.byteLength);

    this.sweep();
    for (const owner of owners) {
      if (this.countFor(owner.id) >= owner.limit) {
        throw new GetScreenshotError(
          "too_many_documents",
          `Too many temporary HTML documents are waiting to be captured for this caller (limit ${owner.limit}). ` +
            `Each one is removed when its capture finishes, or after ${Math.round(this.ttlMs / 60_000)} minutes. Wait for the running render_html calls to finish, then try again. No quota was used.`,
        );
      }
    }
    if (this.entries.size >= this.maxDocs || this.totalBytes + data.byteLength > this.maxTotalBytes) {
      throw new GetScreenshotError(
        "html_store_full",
        "The temporary HTML store is full right now. Try again in about a minute. Nothing was captured and no quota was used.",
      );
    }

    const id = randomBytes(HTML_ID_BYTES).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(id, { data, expiresAt, readsLeft: this.maxReads, owners: owners.map((o) => o.id) });
    this.totalBytes += data.byteLength;
    return { id, expiresAt, expiresInSeconds: Math.round(this.ttlMs / 1000) };
  }

  async read(id: string): Promise<Buffer | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(id);
      return undefined;
    }
    entry.readsLeft -= 1;
    if (entry.readsLeft <= 0) this.remove(id);
    return entry.data;
  }

  async delete(id: string, ownerId?: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (ownerId !== undefined && !entry.owners.includes(ownerId)) return false;
    this.remove(id);
    return true;
  }

  /** Drops expired documents. Called on a timer and before every write. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.remove(id);
        removed += 1;
      }
    }
    return removed;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.entries.clear();
    this.totalBytes = 0;
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalBytes -= entry.data.byteLength;
  }
}

export interface HostedHtml {
  url: string;
  expiresInSeconds: number;
  /** Removes the document. Called as soon as the capture that needed it has returned. Never throws. */
  dispose(): Promise<void>;
}

/**
 * What render_html needs from its environment: somewhere to put HTML so the
 * capture API can load it by URL.
 */
export interface HtmlHost {
  publish(html: string, signal?: AbortSignal): Promise<HostedHtml>;
}

export interface LocalHtmlHostOptions {
  /** Who the documents are charged to. */
  owners?: readonly HtmlOwner[] | undefined;
  /** Runs before a document is stored; throws to refuse it (rate limiting). */
  admit?: (() => void) | undefined;
}

/** Hosts HTML in a local store and serves it from this process (hosted HTTP mode). */
export class LocalHtmlHost implements HtmlHost {
  constructor(
    private readonly store: HtmlStore,
    private readonly publicBaseUrl: () => string,
    private readonly options: LocalHtmlHostOptions = {},
  ) {}

  async publish(html: string): Promise<HostedHtml> {
    this.options.admit?.();
    const ref = await this.store.put(html, this.options.owners);
    return {
      url: `${this.publicBaseUrl().replace(/\/+$/, "")}/h/${ref.id}`,
      expiresInSeconds: ref.expiresInSeconds,
      dispose: async () => {
        await this.store.delete(ref.id).catch(() => false);
      },
    };
  }
}
