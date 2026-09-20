/**
 * The shutdown handler, kept out of main() so its deadline can be tested
 * without spawning a process and waiting five real seconds for it.
 */

export interface ShutdownOptions {
  /** Tells Crispy the session is over. */
  endSession: () => Promise<void>;
  /** Closes the local transport. */
  close: () => Promise<void>;
  /** Ends the process. Not expected to return. */
  exit: () => void;
  /** Upper bound on the whole handler. */
  timeoutMs: number;
}

export function createShutdown(options: ShutdownOptions): () => Promise<void> {
  let shuttingDown = false;

  return async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // One deadline over the whole handshake. Bounding only the teardown left
    // close() unbounded, and a close() that never settles wedged the process
    // for good: `shuttingDown` is already true, so a second Ctrl+C returns
    // immediately and the user has no way out.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.timeoutMs);
    });

    // Both stages are best effort, and `.catch()` on the call is not enough to
    // make them so: it only sees a rejected return value. close() comes from
    // the SDK, so it can just as well throw before it returns anything at all,
    // and that would reject the handshake, reject the race, and skip the exit
    // this handler exists to guarantee.
    const attempt = async (step: () => Promise<void>): Promise<void> => {
      try {
        await step();
      } catch {
        // Nobody to tell: the process is on its way out either way.
      }
    };

    const handshake = (async () => {
      await attempt(() => options.endSession());
      await attempt(() => options.close());
    })();

    try {
      await Promise.race([handshake, deadline]);
    } finally {
      clearTimeout(timer);
      options.exit();
    }
  };
}
