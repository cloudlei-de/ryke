export const styles = `
:root {
  --bg: #fbfaf8;
  --surface: #ffffff;
  --fg: #1c1b1a;
  --muted: #6b6762;
  --line: #e3dfd8;
  --accent: #d9480f;
}
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
a { color: var(--accent); }
h1 { margin: 0 0 16px; font-size: 28px; }
h2 { margin: 24px 0 8px; font-size: 18px; }
.site-header { display: flex; align-items: center; gap: 24px; padding: 14px 24px; background: var(--surface); border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; font-size: 18px; text-decoration: none; color: var(--fg); }
.nav { display: flex; gap: 16px; }
.page { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
.lead { margin-top: 0; color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.tile { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
.tile-link { display: flex; flex-direction: column; padding: 14px 16px; text-decoration: none; color: var(--fg); }
.tile-link span { color: var(--muted); font-size: 14px; }
.converter { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 24px; }
.converter label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--muted); }
input, select, button { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--fg); }
button { cursor: pointer; }
.table { width: 100%; border-collapse: collapse; background: var(--surface); }
.table td { padding: 10px 12px; border-bottom: 1px solid var(--line); }
.site-footer { padding: 24px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
`;
