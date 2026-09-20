import { afterEach, describe, expect, it, vi } from "vitest";

import { createShutdown } from "../src/shutdown";

/** A promise that never settles: the thing a deadline has to survive. */
function never(): Promise<void> {
  return new Promise<void>(() => undefined);
}

function deps(overrides: Partial<Parameters<typeof createShutdown>[0]> = {}) {
  const order: string[] = [];
  let exited = 0;

  const options = {
    endSession: async () => {
      order.push("endSession");
    },
    close: async () => {
      order.push("close");
    },
    exit: () => {
      exited += 1;
    },
    timeoutMs: 20,
    ...overrides,
  };

  return { options, order, exited: () => exited };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdown", () => {
  it("ends the Crispy session before closing the transport, then exits", async () => {
    const { options, order, exited } = deps();

    await createShutdown(options)();

    expect(order).toEqual(["endSession", "close"]);
    expect(exited()).toBe(1);
  });

  it("exits within the deadline when the transport close never settles", async () => {
    const { options, exited } = deps({ close: never });

    const started = Date.now();
    await createShutdown(options)();

    expect(exited()).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("exits within the deadline when the teardown never settles", async () => {
    const { options, exited } = deps({ endSession: never });

    await createShutdown(options)();

    expect(exited()).toBe(1);
  });

  it("still exits when the teardown throws", async () => {
    const { options, exited } = deps({
      endSession: async () => {
        throw new Error("boom");
      },
    });

    await createShutdown(options)();

    expect(exited()).toBe(1);
  });

  it("still exits when a teardown dependency throws synchronously", async () => {
    // close() is the SDK's, so it can throw before it ever returns a promise.
    // `.catch()` on the call only sees a rejected *return value*.
    const { options, exited } = deps({
      close: () => {
        throw new Error("the sdk threw before returning a promise");
      },
    });

    await expect(createShutdown(options)()).resolves.toBeUndefined();

    expect(exited()).toBe(1);
  });

  it("still exits when the teardown throws synchronously", async () => {
    const { options, exited } = deps({
      endSession: () => {
        throw new Error("boom, synchronously");
      },
    });

    await expect(createShutdown(options)()).resolves.toBeUndefined();

    expect(exited()).toBe(1);
  });

  // A second Ctrl+C must not restart teardown while the first is still in
  // flight, and the deadline timer must not be left behind holding the event
  // loop open.
  it("ignores a repeat signal that overlaps the first", async () => {
    const order: string[] = [];
    let exits = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const shutdown = createShutdown({
      endSession: async () => {
        order.push("endSession");
        await held;
      },
      close: async () => {
        order.push("close");
      },
      exit: () => {
        exits += 1;
      },
      timeoutMs: 5_000,
    });

    const first = shutdown();
    const second = shutdown();
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(["endSession", "close"]);
    expect(exits).toBe(1);
  });

  // Two deadlines of timeoutMs each would let a slow teardown and a slow close
  // run to almost twice the budget, and every other deadline test here makes
  // one of the two stages instantaneous, so it could not tell the difference.
  it("spends one deadline across both stages rather than one each", async () => {
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));
    let closed = false;
    let exits = 0;
    let closedWhenExited: boolean | undefined;

    await createShutdown({
      endSession: () => sleep(80),
      close: async () => {
        await sleep(80);
        closed = true;
      },
      exit: () => {
        exits += 1;
        closedWhenExited = closed;
      },
      timeoutMs: 100,
    })();

    expect(exits).toBe(1);
    // 80 + 80 overruns the 100ms budget, so exit has to come while close is
    // still running. Given close its own 100ms and it would have finished.
    expect(
      closedWhenExited,
      "close finished, so it was given a deadline of its own",
    ).toBe(false);
  });

  it("clears the deadline timer once the handshake is done", async () => {
    vi.useFakeTimers();
    const { options } = deps({ timeoutMs: 5_000 });

    await createShutdown(options)();

    expect(vi.getTimerCount()).toBe(0);
  });
});
