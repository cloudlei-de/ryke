import { escapeHtml } from "./html.ts";
import { styles } from "./styles.ts";

export type Page = { title: string; body: string };

// Hot by design: every change to the shell (search, theme, favourites) reads this file. The header
// and the footer are kept apart so edits to them merge in any order.
export function layout({ title, body }: Page): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Convert</title>
<style>${styles}</style>
</head>
<body>
<header class="site-header">
  <a class="brand" href="/">Convert</a>
  <nav class="nav">
    <a href="/">Categories</a>
    <a href="/api/convert?c=length&amp;from=km&amp;to=m&amp;v=1">API</a>
  </nav>
</header>
<main class="page">
  <h1>${escapeHtml(title)}</h1>
${body}
</main>
<footer class="site-footer">
  <p>Convert is the demo app for Ryke.</p>
</footer>
</body>
</html>
`;
}
