// How the Ryke agent reads the platform's answers: which attempt outcome a transaction state means,
// and the long-poll that waits for a submitted change to leave the lander's hands.
export const IN_PROGRESS = ["submitted", "ready", "verifying"];

// An attempt that ran out of tries goes straight to aborted and keeps only notes about why it failed.
export function inferCause(detail, paths) {
  if (detail?.conflicts?.length > 0) return "text_conflict";
  if (detail?.stale?.length > 0 || paths?.length > 0) return "stale_read";
  if (detail?.failures !== undefined && detail?.failures !== null) return "failed_verify";
  return "max_attempts";
}

// state, reason, detail and paths come from submit or wait. `retry: false` ends the transaction.
export function outcomeFromState({ state, reason = null, detail = {}, paths = [] }) {
  switch (state) {
    case "landed":
      return { landed: true };
    case "stale":
      return { landed: false, cause: reason === "text_conflict" ? "text_conflict" : "stale_read", retry: true, paths };
    case "failed":
      return { landed: false, cause: reason === "tests" || reason === null ? "failed_verify" : reason, retry: true };
    case "aborted":
      if (reason === "max_attempts") return { landed: false, cause: inferCause(detail, paths), retry: false, maxAttempts: true };
      return { landed: false, cause: `aborted:${reason ?? "unknown"}`, retry: false };
    case "rejected":
      return { landed: false, cause: `rejected:${reason ?? "unknown"}`, retry: false };
    case "needs_human":
      return { landed: false, cause: "needs_human", retry: false };
    default:
      throw new Error(`unexpected transaction state ${state}`);
  }
}

const aborted = (signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve("abort"), { once: true }));

// `first` is the submit response. While the change is with the lander, long-poll until it is not.
export async function waitWhileSettling(api, id, first, signal, { pollSeconds = 20 } = {}) {
  let { state, reason, paths } = first;
  let detail = {};
  const gone = aborted(signal);
  while (IN_PROGRESS.includes(state)) {
    if (signal?.aborted) return { abandoned: true };
    const polled = await Promise.race([api.wait(id, pollSeconds), gone]);
    if (polled === "abort") return { abandoned: true };
    ({ state, reason } = polled.txn);
    detail = polled.detail ?? {};
    paths = [];
  }
  return outcomeFromState({ state, reason, detail, paths });
}
