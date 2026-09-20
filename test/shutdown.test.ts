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

  // A second Ctrl+C must not restart teardown, and the deadline timer must not
  // be left behind holding the event loop open.
  it("ignores a repeat signal", async () => {
    const { options, order, exited } = deps();
    const shutdown = createShutdown(options);

    await shutdown();
    await shutdown();

    expect(order).toEqual(["endSession", "close"]);
    expect(exited()).toBe(1);
  });

  it("clears the deadline timer once the handshake is done", async () => {
    vi.useFakeTimers();
    const { options } = deps({ timeoutMs: 5_000 });

    await createShutdown(options)();

    expect(vi.getTimerCount()).toBe(0);
  });
});
