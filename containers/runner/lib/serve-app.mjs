// Serves a Worker-style app (default export `{ fetch }`) on a loopback port so Playwright can
// screenshot it. It runs as its own process, started with `node --experimental-strip-types` so the
// demo's .ts sources load, because the app is candidate code: a crash or a hang must end this
// process, never the verify job. Prints one JSON line `{"port": N}` once it is listening.
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: serve-app.mjs <entry module>");
  process.exit(2);
}

let app;
try {
  app = (await import(pathToFileURL(resolve(entry)).href)).default;
} catch (err) {
  // One short message instead of node's stack: it ends up in the screenshot error, which is cut
  // to the last few hundred characters, and a stack would push the reason out of it.
  console.error(`could not load ${entry}: ${String(err?.message ?? err).split("\n").slice(0, 3).join(" | ")}`);
  process.exit(1);
}
if (typeof app?.fetch !== "function") {
  console.error(`${entry}: the default export must be an object with a fetch(request, env, ctx) method`);
  process.exit(2);
}

// The preview runs with no bindings, and waitUntil work must not take the process down.
const ctx = {
  waitUntil: (promise) => void Promise.resolve(promise).catch(() => {}),
  passThroughOnException() {},
};

async function toRequest(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const chunks = [];
  if (hasBody) for await (const chunk of req) chunks.push(chunk);
  return new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

const server = createServer(async (req, res) => {
  try {
    const response = await app.fetch(await toRequest(req), {}, ctx);
    const headers = {};
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") headers[name] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) headers["set-cookie"] = cookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(err?.stack ?? err));
  }
});

server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
