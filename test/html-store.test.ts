import { afterEach, describe, expect, it } from "vitest";
import {
  HTML_ID_PATTERN,
  HTML_MAX_BYTES,
  HTML_MAX_DOCS_PER_CALLER,
  HTML_MAX_READS,
  HTML_TTL_MS,
  LocalHtmlHost,
  MemoryHtmlStore,
} from "../src/html-store.js";

const stores: MemoryHtmlStore[] = [];
function makeStore(options: ConstructorParameters<typeof MemoryHtmlStore>[0] = {}) {
  const store = new MemoryHtmlStore({ sweepIntervalMs: 0, ...options });
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("MemoryHtmlStore", () => {
  it("uses the documented defaults", () => {
    expect(HTML_TTL_MS).toBe(5 * 60 * 1000);
    expect(HTML_MAX_READS).toBe(3);
    expect(HTML_MAX_DOCS_PER_CALLER).toBe(5);
    expect(HTML_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it("hands out unguessable ids: 32 random bytes, base64url", async () => {
    const store = makeStore();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const ref = await store.put(`<p>${i}</p>`);
      expect(ref.id).toMatch(HTML_ID_PATTERN);
      expect(Buffer.from(ref.id, "base64url").byteLength).toBe(32);
      ids.add(ref.id);
    }
    expect(ids.size).toBe(50);
  });

  it("returns the stored bytes and reports the TTL", async () => {
    const store = makeStore();
    const html = "<h1>café ☃</h1>";
    const ref = await store.put(html);
    expect(ref.expiresInSeconds).toBe(300);
    expect((await store.read(ref.id))?.toString("utf8")).toBe(html);
    expect(await store.read("nope")).toBeUndefined();
  });

  it("expires documents after the TTL", async () => {
    let now = 1_000_000;
    const store = makeStore({ now: () => now });
    const ref = await store.put("<p>ttl</p>");
    expect(ref.expiresAt).toBe(now + HTML_TTL_MS);
    now += HTML_TTL_MS - 1;
    expect(await store.read(ref.id)).toBeDefined();
    now += 1;
    expect(await store.read(ref.id)).toBeUndefined();
    expect(store.size).toBe(0);
    expect(store.bytes).toBe(0);
  });

  it("allows 3 reads, then the document is gone", async () => {
    const store = makeStore();
    const ref = await store.put("<p>reads</p>");
    for (let i = 0; i < 3; i++) expect(await store.read(ref.id), `read ${i + 1}`).toBeDefined();
    expect(await store.read(ref.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("rejects documents over 2 MB and empty documents, accepts exactly 2 MB", async () => {
    const store = makeStore();
    await expect(store.put("x".repeat(HTML_MAX_BYTES))).resolves.toBeDefined();
    await expect(store.put("x".repeat(HTML_MAX_BYTES + 1))).rejects.toMatchObject({ code: "html_too_large" });
    // The limit is in bytes, not characters.
    await expect(store.put("é".repeat(HTML_MAX_BYTES / 2 + 1))).rejects.toMatchObject({ code: "html_too_large" });
    await expect(store.put("")).rejects.toMatchObject({ code: "invalid_input" });
    expect(store.size).toBe(1);
  });

  it("when the count cap is reached it rejects the new document and keeps everyone else's", async () => {
    const store = makeStore({ maxDocs: 3 });
    const a = await store.put("a");
    const b = await store.put("b");
    const c = await store.put("c");
    await expect(store.put("d")).rejects.toMatchObject({ code: "html_store_full" });
    await expect(store.put("d")).rejects.toThrow(/full right now.*no quota was used/s);
    expect(store.size).toBe(3);
    // Nothing was evicted: the oldest document is still served.
    for (const ref of [a, b, c]) expect(await store.read(ref.id)).toBeDefined();
  });

  it("when the byte cap would be exceeded it rejects instead of evicting", async () => {
    const store = makeStore({ maxTotalBytes: 100, maxBytes: 60 });
    const a = await store.put("a".repeat(40));
    const b = await store.put("b".repeat(40));
    await expect(store.put("c".repeat(50))).rejects.toMatchObject({ code: "html_store_full" });
    expect(store.bytes).toBe(80);
    await expect(store.put("c".repeat(20))).resolves.toBeDefined(); // exactly 100 fits
    expect(await store.read(a.id)).toBeDefined();
    expect(await store.read(b.id)).toBeDefined();
  });

  it("caps live documents per owner without touching other owners", async () => {
    const store = makeStore();
    const alice = [{ id: "key:alice", limit: 2 }];
    const bob = [{ id: "key:bob", limit: 2 }];
    const first = await store.put("1", alice);
    await store.put("2", alice);
    const refused = await store.put("3", alice).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "too_many_documents" });
    expect((refused as Error).message).toMatch(/limit 2/);
    expect((refused as Error).message).toMatch(/No quota was used/);
    await expect(store.put("b1", bob)).resolves.toBeDefined();
    expect(store.countFor("key:alice")).toBe(2);
    expect(store.countFor("key:bob")).toBe(1);
    // Room opens up as soon as one of the caller's documents goes away.
    expect(await store.delete(first.id)).toBe(true);
    await expect(store.put("3", alice)).resolves.toBeDefined();
  });

  it("charges a document to every owner and refuses when any of them is at its limit", async () => {
    const store = makeStore();
    const address = { id: "ip:203.0.113.7", limit: 3 };
    // Three different keys from one address: each key is under its own limit, the address is not.
    for (const key of ["k1", "k2", "k3"]) await store.put("x", [{ id: `key:${key}`, limit: 5 }, address]);
    await expect(store.put("x", [{ id: "key:k4", limit: 5 }, address])).rejects.toMatchObject({ code: "too_many_documents" });
    await expect(store.put("x", [{ id: "key:k4", limit: 5 }, { id: "ip:198.51.100.1", limit: 3 }])).resolves.toBeDefined();
  });

  it("documents that expire or are read out stop counting against their owner", async () => {
    let now = 0;
    const store = makeStore({ now: () => now, ttlMs: 1000 });
    const owner = [{ id: "key:a", limit: 1 }];
    const ref = await store.put("x", owner);
    await expect(store.put("y", owner)).rejects.toMatchObject({ code: "too_many_documents" });
    for (let i = 0; i < HTML_MAX_READS; i++) await store.read(ref.id);
    await expect(store.put("y", owner)).resolves.toBeDefined();
    now = 2000;
    await expect(store.put("z", owner)).resolves.toBeDefined();
  });

  it("delete removes a document, and with an owner id only that owner's", async () => {
    const store = makeStore();
    const ref = await store.put("<p>mine</p>", [{ id: "key:alice", limit: 5 }]);
    expect(await store.delete(ref.id, "key:mallory")).toBe(false);
    expect(await store.read(ref.id)).toBeDefined();
    expect(await store.delete(ref.id, "key:alice")).toBe(true);
    expect(await store.read(ref.id)).toBeUndefined();
    expect(await store.delete(ref.id)).toBe(false);
    expect(store.size).toBe(0);
    expect(store.bytes).toBe(0);
  });

  it("sweeps expired documents before deciding the store is full", async () => {
    let now = 0;
    const store = makeStore({ now: () => now, maxDocs: 2, ttlMs: 1000 });
    const old = await store.put("old");
    now = 600;
    const live = await store.put("live");
    now = 1100; // `old` has expired, `live` has not
    const fresh = await store.put("fresh");
    expect(store.size).toBe(2);
    expect(await store.read(old.id)).toBeUndefined();
    expect(await store.read(live.id)).toBeDefined();
    expect(await store.read(fresh.id)).toBeDefined();
    now = 5000;
    expect(store.sweep()).toBe(2);
    expect(store.size).toBe(0);
  });

  it("sweeps on a timer", async () => {
    let now = 0;
    const store = makeStore({ now: () => now, ttlMs: 10, sweepIntervalMs: 15 });
    await store.put("x");
    now = 100;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.size).toBe(0);
  });

  it("close drops everything", async () => {
    const store = makeStore();
    const ref = await store.put("x");
    store.close();
    expect(await store.read(ref.id)).toBeUndefined();
    expect(store.bytes).toBe(0);
  });
});

describe("LocalHtmlHost", () => {
  it("builds /h/<id> links on the public base URL", async () => {
    const store = makeStore();
    const host = new LocalHtmlHost(store, () => "https://mcp.getscreenshotapi.com/");
    const hosted = await host.publish("<p>hi</p>");
    expect(hosted.url).toMatch(/^https:\/\/mcp\.getscreenshotapi\.com\/h\/[A-Za-z0-9_-]{43}$/);
    expect(hosted.expiresInSeconds).toBe(300);
    const id = hosted.url.split("/h/")[1] as string;
    expect((await store.read(id))?.toString()).toBe("<p>hi</p>");
  });

  it("dispose removes the document at once; the admit hook can refuse a publish", async () => {
    const store = makeStore();
    let admitted = 0;
    const host = new LocalHtmlHost(store, () => "https://html.example", {
      owners: [{ id: "key:a", limit: 1 }],
      admit: () => {
        admitted += 1;
        if (admitted > 2) throw new Error("rate limited");
      },
    });
    const hosted = await host.publish("<p>one</p>");
    expect(store.size).toBe(1);
    await hosted.dispose();
    await hosted.dispose(); // harmless twice
    expect(store.size).toBe(0);
    await expect(host.publish("<p>two</p>")).resolves.toBeDefined(); // the cap of 1 is free again
    await expect(host.publish("<p>three</p>")).rejects.toThrow("rate limited");
    expect(store.size).toBe(1);
  });
});
