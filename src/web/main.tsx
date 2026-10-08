import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./fonts/fonts.css";
import { useLive } from "./live";
import "./styles.css";
import { Lamp, Logo, Patterns, THEME_TEXT, useTheme } from "./ui";
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

const THEME_TITLE = { system: "Print follows the system's light or dark setting", light: "Day print", dark: "Night print" };

function App() {
  const route = useRoute();
  const repo = repoName();
  const live = useLive(repo, route.name !== "bench");
  const [theme, cycleTheme] = useTheme();
  // A transaction is opened from the Line, so the Line's sheet stays current under it.
  const current = route.name === "txn" ? "line" : route.name;
  const tab = (href: string, name: Route["name"], no: number, label: string) => (
    <a href={href} aria-current={current === name ? (route.name === "txn" ? "location" : "page") : undefined}>
      <span className="tab-no">{no}</span>
      <span className="tab-name">{label}</span>
    </a>
  );
  return (
    <div className="app">
      <Patterns />
      <header className="masthead">
        <a className="mh-cell brand" href="#/" aria-label="Ryke, the Line">
          <Logo />
          <span>
            <span className="brand-name">Ryke</span>
            <span className="brand-sub">Git with transactions</span>
          </span>
        </a>
        <div className="mh-cell mh-sheet">
          <span className="mh-label">Sheet</span>
          <nav className="tabs mh-value" aria-label="Views">
            {tab("#/", "line", 1, "Line")}
            {tab("#/replay", "replay", 2, "Replay")}
            {tab("#/bench", "bench", 3, "Bench")}
          </nav>
        </div>
        <div className="mh-cell mh-repo-cell">
          <span className="mh-label">Repo</span>
          <span className="mh-value mh-repo">{repo}</span>
        </div>
        <span className="mh-fill" />
        {/* The Line says on its own sheet whether it is live; a transaction's page and the Replay, which keeps adding
            what the stream brings, say it here. The Bench opens no stream. */}
        {(route.name === "txn" || route.name === "replay") && (
          <div className="mh-cell mh-stream">
            <span className="mh-label">Stream</span>
            <span className="mh-value">
              <Lamp tone={live.connected ? "go" : "stop"} live={live.connected} title={live.connected ? "Receiving the op stream" : "Not connected to the op stream; retrying"}>
                {live.connected ? "Live" : "Reconnecting"}
              </Lamp>
            </span>
          </div>
        )}
        <button type="button" className="mh-cell theme-btn" onClick={cycleTheme} title={`${THEME_TITLE[theme]}. Press for the next.`} aria-label={`Colour scheme: ${THEME_TITLE[theme]}`}>
          <span className="mh-label">Print</span>
          <span className="mh-value">{THEME_TEXT[theme]}</span>
        </button>
      </header>
      <main className="view" data-route={route.name}>
        {route.name === "line" && <LineView repo={repo} state={live.state} ops={live.ops} mode="live" connected={live.connected} />}
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
