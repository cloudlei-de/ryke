// The marks every view draws with, taken from the railway sheet the dashboard imitates: a band for an attempt
// (outlined while working, hatched while queued, filled while verifying, striped like a lowered barrier while a
// human decides, dotted while it waits for a lease), a notch where it went stale, a cross where it failed, a buffer
// stop where it was turned away, a double bar where it gave up, a switch where it joined trunk, a strike where it
// was recalled, and the signal lamp. There is no icon set (PLAN.md §0.7, DECISIONS 2026-10-08): these are the only
// glyphs, and each state has its own form, so a state is never told by colour alone.
import { useEffect, useState } from "react";
import type { Signal } from "./views/txn/format";

export type MarkName =
  | "working"
  | "retry"
  | "queued"
  | "verifying"
  | "landed"
  | "stale"
  | "failed"
  | "rejected"
  | "aborted"
  | "human"
  | "lease"
  | "recalled"
  | "warning"
  | "train"
  | "trunk"
  | "alert"
  | "policy";

const STATE_MARK: Record<string, MarkName> = {
  open: "working",
  submitted: "queued",
  ready: "queued",
  verifying: "verifying",
  landed: "landed",
  stale: "stale",
  failed: "failed",
  rejected: "rejected",
  needs_human: "human",
  lease_wait: "lease",
  aborted: "aborted",
  recalled: "recalled",
};

export function stateMark(state: string): MarkName {
  return STATE_MARK[state] ?? "working";
}

// ------------------------------------------------------------------ end marks

export type EndKind = "landed" | "stale" | "failed" | "rejected" | "aborted";

// How far right of the band's end its mark reaches, so a hit area can include it.
export function endReach(kind: EndKind, h: number): number {
  if (kind === "landed") return Math.min(10, h * 0.75) + 1;
  if (kind === "failed") return 2 * crossArm(h) + 3;
  if (kind === "stale") return 1.5;
  if (kind === "aborted") return 3;
  return 4;
}

const crossArm = (h: number) => Math.max(2.4, Math.min(5, h * 0.32));

// The mark at the end of a band whose right edge is `x`, top `y` and height `h`. `recalled` puts the switch back in
// ink: the change joined trunk once, and the strike over it says it no longer does.
export function EndMark({ kind, x, y, h, recalled = false }: { kind: EndKind; x: number; y: number; h: number; recalled?: boolean }) {
  if (kind === "stale") return <rect className="m-stale" x={x - 1.25} y={y - 3} width={2.5} height={h + 6} />;
  if (kind === "landed") {
    const dx = Math.min(10, h * 0.75);
    return <path className={recalled ? "m-switch recalled" : "m-switch"} d={`M${x - 0.5} ${y + h}L${x + dx} ${y - 2.5}`} />;
  }
  if (kind === "failed") {
    const k = crossArm(h);
    const cx = x + k + 2;
    const cy = y + h / 2;
    return <path className="m-cross" d={`M${cx - k} ${cy - k}L${cx + k} ${cy + k}M${cx + k} ${cy - k}L${cx - k} ${cy + k}`} />;
  }
  // Turned away is a buffer stop, the track ending in a bar braced back along it; giving up is the double bar a
  // timetable prints where a line ends, in ink because no signal stopped it.
  if (kind === "aborted") return <path className="m-end" d={`M${x + 0.5} ${y - 3}V${y + h + 3}M${x + 3} ${y - 3}V${y + h + 3}`} />;
  const bx = x + 1.75;
  return <path className="m-buffer" d={`M${bx - 3.5} ${y - 3}H${bx}V${y + h + 3}H${bx - 3.5}`} />;
}

// ------------------------------------------------------------------ swatches

const BAND: Partial<Record<MarkName, string>> = { working: "s-open", queued: "s-queued", verifying: "s-verify", human: "s-human", lease: "s-lease" };
const W = 24;
const H = 10;

// One mark at the size of the Line's key, 24 by 10, so the margin, the log book and the key all print the same
// drawing; `width` scales it.
export function Swatch({ mark, width = W }: { mark: MarkName; width?: number }) {
  const height = (width * H) / W;
  const band = (cls: string, x0: number, x1: number, y = 1.5, h = 7) => <rect className={`band ${cls}`} x={x0 + 0.5} y={y} width={Math.max(1, x1 - x0 - 1)} height={h} />;
  let body: React.ReactNode;
  switch (mark) {
    case "landed":
      body = (
        <>
          {band("s-landed", 0, 16)}
          <EndMark kind="landed" x={15.5} y={1.5} h={7} />
        </>
      );
      break;
    case "stale":
      body = (
        <>
          {band("s-open", 0, 11)}
          <EndMark kind="stale" x={11.25} y={1.5} h={7} />
          {band("s-open", 13, W)}
        </>
      );
      break;
    case "retry":
      body = (
        <>
          <rect className="f-stop" x={1} y={-1.5} width={2.5} height={13} />
          {band("s-open", 6, W)}
        </>
      );
      break;
    case "failed":
      body = (
        <>
          {band("s-open", 0, 14)}
          <EndMark kind="failed" x={13.5} y={1.5} h={7} />
        </>
      );
      break;
    case "rejected":
      body = (
        <>
          {band("s-open", 0, 19)}
          <EndMark kind="rejected" x={18.5} y={1.5} h={7} />
        </>
      );
      break;
    case "aborted":
      body = (
        <>
          {band("s-open", 0, 19)}
          <EndMark kind="aborted" x={19.5} y={1.5} h={7} />
        </>
      );
      break;
    case "recalled":
      body = (
        <>
          {band("s-open", 1, W - 1)}
          <line className="strike" x1={-0.5} x2={W + 0.5} y1={5} y2={5} />
        </>
      );
      break;
    case "warning":
      body = (
        <>
          {band("s-open", 0, W, 3, 6.5)}
          <path className="warn" d="M8.5 -1.5h7l-3.5 4z" />
        </>
      );
      break;
    case "train":
      body = (
        <>
          <line className="k-ink" x1={0} x2={W} y1={6.5} y2={6.5} strokeWidth={2} />
          {[7, 12, 17].map((x) => (
            <line key={x} className="k-ink" x1={x} x2={x} y1={3.5} y2={9.5} strokeWidth={1.5} />
          ))}
          <path className="k-ink" fill="none" d="M4.5 2.5V0.5H19.5V2.5" />
        </>
      );
      break;
    case "trunk":
      body = (
        <>
          <line className="k-ink" x1={4} x2={W} y1={5} y2={5} strokeWidth={2} />
          <path className="k-ink" fill="none" strokeWidth={2} d="M5 1H2V9H5" />
        </>
      );
      break;
    case "alert":
    case "policy":
      body = <circle className={mark === "alert" ? "f-stop k-ink" : "f-paper k-ink"} cx={W / 2} cy={5} r={3.75} strokeWidth={1.5} />;
      break;
    default:
      body = band(BAND[mark] ?? "s-open", 0, W);
  }
  return (
    <svg className="swatch" width={width} height={height} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {body}
    </svg>
  );
}

// A state named in words with its mark: the word for the reader, the mark to find it again on the Line.
export function StateMark({ state, label, large }: { state: string; label: string; large?: boolean }) {
  return (
    <span className={large ? "state state-lg" : "state"}>
      <Swatch mark={stateMark(state)} width={large ? 34 : 22} />
      {label}
    </span>
  );
}

// The sheet's signal lamp beside a word: lit in a signal colour, or an unlit ring.
export function Lamp({ tone, title, live, children }: { tone: Signal | null; title?: string; live?: boolean; children: React.ReactNode }) {
  const lit = tone && tone !== "none" && tone !== "recall" ? tone : undefined;
  return (
    <span className={live === undefined ? "lamp" : "lamp status-dot"} data-tone={lit} data-live={live === undefined ? undefined : String(live)} title={title}>
      <i className="dot" data-tone={lit} />
      {children}
    </span>
  );
}

// Ryke's mark: the main line, and a siding joining it through a switch that is lit, as a landing is.
export function Logo() {
  return (
    <svg className="logo" width="28" height="18" viewBox="0 0 28 18" aria-hidden="true">
      <path d="M1 4.5H27" className="k-ink" strokeWidth="2.5" fill="none" />
      <path d="M1 14H9" className="k-ink" strokeWidth="2.5" fill="none" />
      <path d="M8 14L16.5 4.5" className="k-go" strokeWidth="2.5" fill="none" />
    </svg>
  );
}

// The fills the bands use, defined once per page because SVG patterns are found by document-wide id.
export function Patterns() {
  return (
    <svg className="defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="ryke-queue" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect className="queue-bg" width="4" height="4" />
          <line className="queue-line" x1="0.5" y1="0" x2="0.5" y2="4" />
        </pattern>
        <pattern id="ryke-lease" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect className="lease-bg" width="4" height="4" />
          <circle className="lease-dot" cx="2" cy="2" r="1.1" />
        </pattern>
        <pattern id="ryke-human" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect className="human-bg" width="6" height="6" />
          <line className="human-line" x1="1" y1="0" x2="1" y2="6" />
        </pattern>
      </defs>
    </svg>
  );
}

// A path with its directory in the second ink, so the file name is what the eye finds in a list.
export function PathName({ path, className }: { path: string; className: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <code className={className} title={path}>
      {cut > 0 && <span className="path-dir">{path.slice(0, cut)}</span>}
      <span className="path-base">{path.slice(cut)}</span>
    </code>
  );
}

// "needs human" reads "Needs human" as a label: sentence case, not title case.
export const sentence = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// ------------------------------------------------------------------ theme

export type Theme = "system" | "light" | "dark";
const THEMES: Theme[] = ["system", "light", "dark"];
const THEME_KEY = "ryke.theme";

export function nextTheme(t: Theme): Theme {
  return THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]!;
}

function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

// `data-theme` on <html> is what styles.css switches on; "system" removes it so the media query decides.
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage blocked: the choice lasts for this page view
    }
  }, [theme]);
  return [theme, () => setTheme(nextTheme)];
}

// The masthead's Print cell: the day sheet, its night print, or whichever the system asks for.
export const THEME_TEXT: Record<Theme, string> = { system: "Auto", light: "Day", dark: "Night" };
