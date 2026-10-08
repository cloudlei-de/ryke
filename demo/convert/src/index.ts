import { formatValue } from "./format.ts";
import * as registry from "./registry.ts";
import type { Category } from "./types.ts";
import { escapeHtml } from "./ui/html.ts";
import { layout } from "./ui/layout.ts";

// The registry stays one export line per category, so concurrent additions merge as a union. Deriving
// the list here means adding a category never edits this file.
const categories: Category[] = Object.values(registry).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function page(title: string, body: string, status = 200): Response {
  return new Response(layout({ title, body }), { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function renderHome(): string {
  const tiles = categories.map(
    (c) => `<div class="tile" data-id="${c.id}">
  <a class="tile-link" href="/c/${c.id}">
    <strong>${escapeHtml(c.name)}</strong>
    <span>${c.units.length} units</span>
  </a>
</div>`,
  );
  return `<p class="lead">Pick a category to convert between its units.</p>
<div class="tiles">
${tiles.join("\n")}
</div>`;
}

function renderConverter(category: Category): string {
  const options = (selected: number) =>
    category.units
      .map((u, i) => `<option value="${u.id}"${i === selected ? " selected" : ""}>${escapeHtml(u.name)} (${escapeHtml(u.symbol)})</option>`)
      .join("");
  const first = category.units[0]!;
  const rows = category.units
    .slice(1)
    .map((u) => `<tr><td>${escapeHtml(u.name)}</td><td>${formatValue(u.fromBase(first.toBase(1)))} ${escapeHtml(u.symbol)}</td></tr>`)
    .join("\n");
  return `<form class="converter" action="/api/convert" method="get">
  <input type="hidden" name="c" value="${category.id}">
  <label>Value <input name="v" type="number" step="any" value="1"></label>
  <label>From <select name="from">${options(0)}</select></label>
  <label>To <select name="to">${options(1)}</select></label>
  <button type="submit">Convert</button>
</form>
<h2>1 ${escapeHtml(first.name)} equals</h2>
<table class="table">
  <tbody>
${rows}
  </tbody>
</table>`;
}

function convertApi(params: URLSearchParams): Response {
  const category = categories.find((c) => c.id === params.get("c"));
  if (!category) return json({ error: `unknown category: ${params.get("c")}` }, 404);
  const from = category.units.find((u) => u.id === params.get("from"));
  const to = category.units.find((u) => u.id === params.get("to"));
  if (!from || !to) return json({ error: `unknown unit for category ${category.id}` }, 404);
  const raw = params.get("v");
  // Number("") is 0, which would turn a missing value into a plausible answer.
  const value = raw === null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value)) return json({ error: "v must be a number" }, 400);
  const result = to.fromBase(from.toBase(value));
  return json({ category: category.id, from: from.id, to: to.id, value, result, display: formatValue(result) });
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/") return page("Categories", renderHome());
    if (url.pathname === "/api/convert") return convertApi(url.searchParams);
    const match = /^\/c\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const category = categories.find((c) => c.id === match[1]);
      if (category) return page(category.name, renderConverter(category));
      return page("Not found", `<p>There is no category called ${escapeHtml(match[1]!)}.</p>`, 404);
    }
    return page("Not found", "<p>That page does not exist.</p>", 404);
  },
};
