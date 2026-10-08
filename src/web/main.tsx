import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useLive } from "./live";
import "./styles.css";
import { Icon, Logo, THEME_ICON, useTheme, type IconName } from "./ui";
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

const THEME_LABEL = { system: "Theme: follows the system", light: "Theme: light", dark: "Theme: dark" };

function App() {
  const route = useRoute();
  const repo = repoName();
  const live = useLive(repo, route.name !== "bench");
  const [theme, cycleTheme] = useTheme();
  // A transaction is opened from the Line, so the Line tab stays current under it.
  const current = route.name === "txn" ? "line" : route.name;
  const tab = (href: string, name: Route["name"], label: string, icon: IconName) => (
    <a href={href} aria-current={current === name ? (route.name === "txn" ? "location" : "page") : undefined}>
      <Icon name={icon} size={15} className="tab-icon" />
      {label}
    </a>
  );
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Ryke, the Line">
          <Logo />
          <span className="brand-name">Ryke</span>
        </a>
        <span className="crumb">
          <span className="slash">/</span>
          <Icon name="repo" size={15} />
          <span>{repo}</span>
        </span>
        <nav className="tabs" aria-label="Views">
          {tab("#/", "line", "Line", "git")}
          {tab("#/replay", "replay", "Replay", "clock")}
          {tab("#/bench", "bench", "Bench", "pulse")}
        </nav>
        <span className="spacer" />
        {route.name !== "bench" && (
          <span className="conn" title={live.connected ? "Receiving the op stream" : "Not connected to the op stream; retrying"}>
            <span className="status-dot" data-live={String(live.connected)} />
            <span className="conn-text">{live.connected ? "Live" : "Reconnecting"}</span>
          </span>
        )}
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={cycleTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
          <Icon name={THEME_ICON[theme]} size={16} />
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
