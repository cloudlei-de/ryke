// A thin client over the public Ryke HTTP API (PLAN.md §6.1). Agents, the swarm, the e2e scripts
// and the CLI all use it, so they exercise exactly what an outside agent would.
export class ApiError extends Error {
  constructor(status, body, path) {
    super(`${path} → ${status}: ${typeof body === "object" ? (body?.error ?? JSON.stringify(body)) : body}`);
    this.status = status;
    this.body = body;
  }
}

export function client(base, token) {
  async function call(method, path, body, { allow = [] } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok && !allow.includes(res.status)) throw new ApiError(res.status, data, `${method} ${path}`);
    return data;
  }
  return {
    call,
    createRepo: (name, seedFrom, fresh = false) => call("POST", "/api/repos", { name, seedFrom, fresh }),
    repo: (repo) => call("GET", `/api/repos/${repo}`),
    begin: (repo, input) => call("POST", `/api/repos/${repo}/txns`, input, { allow: [409] }),
    reads: (txn, paths) => call("POST", `/api/txns/${txn}/reads`, { paths }),
    intendWrite: (txn, path) => call("POST", `/api/txns/${txn}/intend-write`, { path }),
    submit: (txn, body = {}) => call("POST", `/api/txns/${txn}/submit`, body),
    retry: (txn) => call("POST", `/api/txns/${txn}/retry`, {}),
    abort: (txn, reason) => call("POST", `/api/txns/${txn}/abort`, { reason }),
    approve: (txn) => call("POST", `/api/txns/${txn}/approve`, {}),
    reject: (txn) => call("POST", `/api/txns/${txn}/reject`, {}),
    txn: (txn) => call("GET", `/api/txns/${txn}`),
    wait: (txn, seconds = 30) => call("GET", `/api/txns/${txn}/wait?timeout=${seconds}`),
    ops: (repo, after = 0, limit = 500) => call("GET", `/api/repos/${repo}/ops?after=${after}&limit=${limit}`),
    recall: (repo, selector, dryRun) => call("POST", `/api/repos/${repo}/recall`, { selector, dryRun }),
    files: (repo, ref, path) => call("GET", `/api/repos/${repo}/files?${new URLSearchParams({ ...(ref ? { ref } : {}), ...(path ? { path } : {}) })}`),
  };
}

// Long-polls until the transaction leaves the given states (or the deadline passes).
export async function waitWhile(api, txn, states, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const w = await api.wait(txn, 20);
    if (!states.includes(w.txn.state)) return w.txn;
    if (Date.now() > until) throw new Error(`${txn} still ${w.txn.state} after ${timeoutMs} ms`);
  }
}
