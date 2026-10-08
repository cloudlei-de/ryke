import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// Live mode runs on a ticking wall clock so open bars grow and heat decays between ops; replay is driven
// by the scrubber's `now`. `stateNow` (the newest op time) guards against a client clock that runs behind.
export function useNow(mode: "live" | "replay", prop: number | undefined, stateNow: number): number {
  const [wall, setWall] = useState(() => Date.now());
  useEffect(() => {
    if (mode !== "live") return;
    setWall(Date.now());
    const id = setInterval(() => setWall(Date.now()), 250);
    return () => clearInterval(id);
  }, [mode]);
  return mode === "live" ? Math.max(wall, stateNow) : (prop ?? stateNow);
}

// The panel's drawable size. SVG text must not be stretched, so geometry is computed in real pixels.
export function useSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 1000, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = { width: Math.round(el.clientWidth), height: Math.round(el.clientHeight) };
      setSize((s) => (s.width === next.width && s.height === next.height ? s : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

type Files = { files: string[] | null; error: string | null; key: string };

// The repo's file list for the heat map. The list always comes from the current head; `when` only decides
// when to ask again (live: the head sha, so once per head change; replay: constant, since scrubbing does
// not change the repo). A short delay coalesces a burst of landings into one request.
export function useFiles(repo: string, when: string | null): { files: string[] | null; error: string | null } {
  const [state, setState] = useState<Files>({ files: null, error: null, key: "" });
  useEffect(() => {
    if (!when) return;
    const key = `${repo}@${when}`;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(repo)}/files`, { signal: ctl.signal });
        if (!res.ok) {
          setState((s) => ({ ...s, error: `HTTP ${res.status}` }));
          return;
        }
        const body = (await res.json()) as { files?: unknown };
        const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string") : [];
        setState({ files, error: null, key });
      } catch {
        if (!ctl.signal.aborted) setState((s) => ({ ...s, error: "network error" }));
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [repo, when]);
  const mine = state.key.startsWith(`${repo}@`);
  return { files: mine ? state.files : null, error: state.error };
}
