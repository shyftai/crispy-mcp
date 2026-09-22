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

  /**
   * Bounded to the deadline, not to "under a second" and not to "it exited at
   * all". Those bounds hold however long the deadline actually is, and its
   * length is the only thing that can be wrong here: the handshake never
   * settles, so the deadline is the sole reason this returns. Pin both sides --
   * still running a tick before it, done on it.
   */
  it("exits on its deadline and not before, when the transport close never settles", async () => {
    vi.useFakeTimers();
    const { options, exited } = deps({ close: never, timeoutMs: 5_000 });

    const done = createShutdown(options)();

    await vi.advanceTimersByTimeAsync(options.timeoutMs - 1);
    expect(exited(), "exited ahead of its deadline").toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(exited(), "still had not exited on its deadline").toBe(1);
  });

  it("exits on its deadline and not before, when the teardown never settles", async () => {
    vi.useFakeTimers();
    const { options, exited } = deps({ endSession: never, timeoutMs: 5_000 });

    const done = createShutdown(options)();

    await vi.advanceTimersByTimeAsync(options.timeoutMs - 1);
    expect(exited(), "exited ahead of its deadline").toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(exited(), "still had not exited on its deadline").toBe(1);
  });

  /**
   * Each of these three asserts on the invocation as well as on the exit. "It
   * exited" alone is not a test of throw-tolerance: a handler that never calls
   * the throwing dependency at all exits just as cleanly, so the assertion
   * held for the one implementation that cannot be wrong here. Pin that the
   * throw happened *and* that the stage after it still ran.
   */
  it("still exits when the teardown throws", async () => {
    const { options, order, exited } = deps({
      endSession: async () => {
        order.push("endSession");
        throw new Error("boom");
      },
    });

    await createShutdown(options)();

    expect(order, "the throwing teardown was never invoked").toEqual([
      "endSession",
      "close",
    ]);
    expect(exited()).toBe(1);
  });

  it("still exits when a teardown dependency throws synchronously", async () => {
    // close() is the SDK's, so it can throw before it ever returns a promise.
    // `.catch()` on the call only sees a rejected *return value*.
    const { options, order, exited } = deps({
      close: () => {
        order.push("close");
        throw new Error("the sdk threw before returning a promise");
      },
    });

    await expect(createShutdown(options)()).resolves.toBeUndefined();

    expect(order, "the throwing dependency was never invoked").toEqual([
      "endSession",
      "close",
    ]);
    expect(exited()).toBe(1);
  });

  it("still exits when the teardown throws synchronously", async () => {
    const { options, order, exited } = deps({
      endSession: () => {
        order.push("endSession");
        throw new Error("boom, synchronously");
      },
    });

    await expect(createShutdown(options)()).resolves.toBeUndefined();

    expect(order, "the throwing teardown was never invoked").toEqual([
      "endSession",
      "close",
    ]);
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
    vi.useFakeTimers();
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));
    let closed = false;
    let exits = 0;
    let closedWhenExited: boolean | undefined;

    // 60 + 60 overruns the budget by 20ms and no more. At 80 + 80 a deadline
    // stretched to 1.5x the budget still cut close() off, so the test could not
    // tell a shared deadline from a slightly generous one; at 60 + 60 anything
    // past 120ms lets close() finish.
    const done = createShutdown({
      endSession: () => sleep(60),
      close: async () => {
        await sleep(60);
        closed = true;
      },
      exit: () => {
        exits += 1;
        closedWhenExited = closed;
      },
      timeoutMs: 100,
    })();

    await vi.advanceTimersByTimeAsync(500);
    await done;

    expect(exits).toBe(1);
    // exit has to come while close is still running. Give close a deadline of
    // its own, or the shared one any slack at all, and it would have finished.
    expect(
      closedWhenExited,
      "close finished, so it had more than the shared budget",
    ).toBe(false);
  });

  it("clears the deadline timer once the handshake is done", async () => {
    vi.useFakeTimers();
    const { options } = deps({ timeoutMs: 5_000 });

    await createShutdown(options)();

    expect(vi.getTimerCount()).toBe(0);
  });
});
