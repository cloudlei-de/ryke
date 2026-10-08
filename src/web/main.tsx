import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useLive } from "./live";
import "./styles.css";
import { BenchView } from "./views/bench";
import { LineView } from "./views/line";
import { ReplayView } from "./views/replay";
import { TxnView } from "./views/txn";

type Route = { name: "line" } | { name: "txn"; id: string } | { name: "bench" } | { name: "replay" };

function parse(hash: string): Route {
  const h = hash.replace(/^#/, "") || "/";
  const t = /^\/t\/([^/?]+)/.exec(h);
  if (t) return { name: "txn", id: decodeURIComponent(t[1]!) };
  if (h.startsWith("/bench")) return { name: "bench" };
  if (h.startsWith("/replay")) return { name: "replay" };
  return { name: "line" };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function repoName(): string {
  return new URLSearchParams(location.search).get("repo") ?? "convert";
}

function App() {
  const route = useRoute();
  const repo = repoName();
  const live = useLive(repo, route.name !== "bench");
  const link = (href: string, label: string, active: boolean) => (
    <a href={href} aria-current={active ? "page" : undefined}>
      {label}
    </a>
  );
  return (
    <div className="shell">
      <header className="masthead">
        <span className="brand">Ryke</span>
        <span className="mono muted">{repo}</span>
        <nav>
          {link("#/", "Line", route.name === "line")}
          {link("#/replay", "Replay", route.name === "replay")}
          {link("#/bench", "Bench", route.name === "bench")}
        </nav>
        <span className="spacer" />
        {route.name !== "bench" && (
          <span className="muted">
            <span className="status-dot" data-live={String(live.connected)} />
            {live.connected ? "live" : "offline"}
          </span>
        )}
      </header>
      <main className="view">
        {route.name === "line" && <LineView repo={repo} state={live.state} ops={live.ops} mode="live" />}
        {route.name === "txn" && <TxnView repo={repo} id={route.id} live={live} />}
        {route.name === "bench" && <BenchView />}
        {route.name === "replay" && <ReplayView repo={repo} live={live} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
