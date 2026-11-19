import { describe, expect, it } from "vitest";
import { GetScreenshotError } from "../src/api.js";
import { DailyLimiter, ImageGate, MinuteLimiter, ipId, keyId } from "../src/limits.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A job that finishes when told to. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("caller identity", () => {
  it("keyId is a stable hash that does not contain the key", () => {
    const key = "my-secret-api-key-123456";
    expect(keyId(key)).toBe(keyId(key));
    expect(keyId(key)).toMatch(/^key:[0-9a-f]{32}$/);
    expect(keyId(key)).not.toContain(key);
    expect(keyId(key)).not.toBe(keyId(`${key}x`));
  });

  it("ipId keeps IPv4 addresses and reduces IPv6 to the /64", () => {
    expect(ipId("203.0.113.7")).toBe("ip:203.0.113.7");
    expect(ipId(" 203.0.113.7 ")).toBe("ip:203.0.113.7");
    // Every address a subscriber can pick inside their /64 is the same caller.
    const inSameSubnet = ["2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:0DB8:0001:0002:aaaa::9", "[2001:db8:1:2::5]"];
    expect(new Set(inSameSubnet.map(ipId))).toEqual(new Set(["ip:2001:db8:1:2::/64"]));
    expect(ipId("2001:db8:1:3::1")).toBe("ip:2001:db8:1:3::/64");
    expect(ipId("::1")).toBe("ip:0:0:0:0::/64");
    expect(ipId("fe80::1%en0")).toBe("ip:fe80:0:0:0::/64");
    // IPv4-mapped IPv6 is the IPv4 caller.
    expect(ipId("::ffff:203.0.113.7")).toBe("ip:203.0.113.7");
    expect(ipId("::ffff:cb00:7107")).toBe("ip:203.0.113.7");
    expect(ipId(undefined)).toBe("ip:unknown");
    expect(ipId("not an address")).toBe("ip:not an address");
  });
});

describe("MinuteLimiter", () => {
  it("allows `limit` events per key per minute and says when to retry", () => {
    let now = 60_000 * 100 + 15_000;
    const limiter = new MinuteLimiter(3, () => now);
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.peek("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 45 });
    expect(limiter.peek("a")).toEqual({ ok: false, retryAfterSeconds: 45 });
    // Another key is unaffected.
    expect(limiter.take("b")).toEqual({ ok: true });
    now += 45_000;
    expect(limiter.take("a")).toEqual({ ok: true });
  });

  it("peek does not count", () => {
    const limiter = new MinuteLimiter(1, () => 0);
    for (let i = 0; i < 5; i++) expect(limiter.peek("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });
});

describe("DailyLimiter", () => {
  it("limits per address and globally, and resets at the next UTC day", () => {
    let now = Date.UTC(2026, 10, 18, 23, 59, 0);
    const limiter = new DailyLimiter(1, 2, () => now);
    expect(limiter.tryConsume("a")).toEqual({ ok: true });
    expect(limiter.tryConsume("a")).toEqual({ ok: false, scope: "ip" });
    expect(limiter.tryConsume("b")).toEqual({ ok: true });
    expect(limiter.tryConsume("c")).toEqual({ ok: false, scope: "global" });
    now = Date.UTC(2026, 10, 19, 0, 0, 1);
    expect(limiter.tryConsume("a")).toEqual({ ok: true });
    expect(limiter.tryConsume("c")).toEqual({ ok: true });
  });
});

describe("ImageGate", () => {
  it("runs at most `concurrency` jobs at once and hands slots to waiters in order", async () => {
    const gate = new ImageGate({ concurrency: 2, maxQueue: 10, maxWaitMs: 5000 });
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const jobs = Array.from({ length: 8 }, (_, i) =>
      gate.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(i);
        await sleep(15);
        running -= 1;
        return i;
      }),
    );
    expect(gate.running).toBe(2);
    expect(gate.waiting).toBe(6);
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(gate.running).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it("refuses at once when the queue is full", async () => {
    const gate = new ImageGate({ concurrency: 1, maxQueue: 1, maxWaitMs: 5000 });
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const second = gate.run(async () => "second");
    expect(gate.saturated).toBe(true);
    const third = await gate.run(async () => "third").catch((e: unknown) => e);
    expect(third).toBeInstanceOf(GetScreenshotError);
    expect((third as GetScreenshotError).code).toBe("server_busy");
    expect((third as GetScreenshotError).message).toMatch(/busy.*Retry in a few seconds/);
    hold.resolve();
    await first;
    expect(await second).toBe("second");
    expect(gate.saturated).toBe(false);
  });

  it("refuses a job that waits longer than maxWaitMs, without losing the slot", async () => {
    const gate = new ImageGate({ concurrency: 1, maxQueue: 5, maxWaitMs: 40 });
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const started = Date.now();
    const waited = await gate.run(async () => "never").catch((e: unknown) => e);
    expect((waited as GetScreenshotError).code).toBe("server_busy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(gate.waiting).toBe(0);
    hold.resolve();
    await first;
    expect(await gate.run(async () => "after")).toBe("after");
    expect(gate.running).toBe(0);
  });

  it("releases the slot when a job throws", async () => {
    const gate = new ImageGate({ concurrency: 1, maxQueue: 0 });
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(gate.running).toBe(0);
    expect(await gate.run(async () => 1)).toBe(1);
  });

  it("drops a waiter whose request was aborted", async () => {
    const gate = new ImageGate({ concurrency: 1, maxQueue: 5, maxWaitMs: 5000 });
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const controller = new AbortController();
    const waiting = gate.run(async () => "x", controller.signal).catch((e: unknown) => e);
    expect(gate.waiting).toBe(1);
    controller.abort();
    expect(((await waiting) as GetScreenshotError).code).toBe("cancelled");
    expect(gate.waiting).toBe(0);
    hold.resolve();
    await first;
    const already = new AbortController();
    already.abort();
    await expect(gate.run(async () => 1, already.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(gate.running).toBe(0);
  });

  it("clamps nonsense options", () => {
    const gate = new ImageGate({ concurrency: 0, maxQueue: -3, maxWaitMs: -1 });
    expect([gate.concurrency, gate.maxQueue, gate.maxWaitMs]).toEqual([1, 0, 0]);
    expect(new ImageGate().concurrency).toBe(3);
  });
});
