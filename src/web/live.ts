// One WebSocket per repo (PLAN.md §12): ops accumulate in arrival order and every view derives
// its state from them with the shared reducers. Reconnects resume from the last seq; no polling.
import { useEffect, useRef, useState } from "react";
import { apply, initial, type LineState } from "../shared/reducers";
import type { Op } from "../shared/types";

export type Live = { ops: Op[]; state: LineState; connected: boolean; version: number };

export function useLive(repo: string, enabled = true): Live {
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const store = useRef<{ ops: Op[]; state: LineState; repo: string }>({ ops: [], state: initial(), repo });
  if (store.current.repo !== repo) store.current = { ops: [], state: initial(), repo };

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const connect = () => {
      const after = store.current.ops.at(-1)?.seq ?? 0;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/repos/${encodeURIComponent(repo)}/stream?after=${after}`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        if (typeof e.data !== "string" || e.data === "pong") return;
        const frame = JSON.parse(e.data) as { ops: Op[] };
        for (const op of frame.ops) {
          if (op.seq <= (store.current.ops.at(-1)?.seq ?? 0)) continue;
          store.current.ops.push(op);
          apply(store.current.state, op);
        }
        // Coalesce bursts into one render per animation frame.
        if (!pending) {
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            setVersion((v) => v + 1);
          });
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      // Closing a socket that is still connecting logs a browser warning (StrictMode mounts twice).
      if (ws?.readyState === WebSocket.CONNECTING) {
        const pending = ws;
        pending.onmessage = null;
        pending.onclose = null;
        pending.onopen = () => pending.close();
      } else ws?.close();
    };
  }, [repo, enabled]);

  return { ops: store.current.ops, state: store.current.state, connected, version };
}

export function adminToken(): string | null {
  try {
    return localStorage.getItem("ryke.token");
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null): void {
  try {
    if (token) localStorage.setItem("ryke.token", token);
    else localStorage.removeItem("ryke.token");
  } catch {
    // storage blocked: the token lives only for this page view
  }
}

export async function adminFetch(path: string, body: unknown): Promise<Response> {
  const token = adminToken();
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}
