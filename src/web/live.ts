// One WebSocket per repo (PLAN.md §12): ops accumulate in arrival order and every view derives
// its state from them with the shared reducers. A closed socket resumes from the last seq, unless the repo
// was reset (stream.ts decides); no polling.
import { useEffect, useRef, useState } from "react";
import type { LineState } from "../shared/reducers";
import type { Op } from "../shared/types";
import { closed, newFeed, openSocket, receive, type Feed } from "./stream";

// `epoch` changes whenever the log was thrown away (swarm --fresh, a repo delete), so a view that fetched
// its own copy of the history knows that copy is of a run that no longer exists.
export type Live = { ops: Op[]; state: LineState; connected: boolean; version: number; epoch: number };

export function useLive(repo: string, enabled = true): Live {
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const held = useRef<{ feed: Feed; repo: string }>({ feed: newFeed(), repo });
  if (held.current.repo !== repo) held.current = { feed: newFeed(), repo };
  const feed = held.current.feed;

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    // Coalesce bursts into one render per animation frame.
    const render = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        setVersion((v) => v + 1);
      });
    };
    const connect = () => {
      const after = openSocket(feed);
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}/api/repos/${encodeURIComponent(repo)}/stream?after=${after}`);
      ws = sock;
      sock.onopen = () => setConnected(true);
      sock.onmessage = (e) => {
        if (typeof e.data !== "string" || e.data === "pong") return;
        const frame = JSON.parse(e.data) as { ops: Op[] };
        if (receive(feed, frame.ops) === "reset") {
          // The log started over while this socket was away: what it delivers is only the tail of the new run,
          // so drop it and ask again from 0 instead of waiting out a backoff (nothing went wrong).
          sock.onmessage = null;
          sock.onclose = null;
          sock.close();
          render();
          connect();
          return;
        }
        render();
      };
      sock.onclose = (e) => {
        setConnected(false);
        if (stopped) return;
        const wait = closed(feed, e.code);
        render();
        retry = setTimeout(connect, wait);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      // Closing a socket that is still connecting logs a browser warning (StrictMode mounts twice).
      if (ws?.readyState === WebSocket.CONNECTING) {
        const connecting = ws;
        connecting.onmessage = null;
        connecting.onclose = null;
        connecting.onopen = () => connecting.close();
      } else ws?.close();
    };
  }, [repo, enabled, feed]);

  return { ops: feed.ops, state: feed.state, connected, version, epoch: feed.epoch };
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
