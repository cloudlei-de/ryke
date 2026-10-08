// Per-commit previews (PLAN.md §10.3): the app's src/ at a commit is bundled in memory and run as a
// Dynamic Worker, so every landed transaction and train candidate can be opened without a deploy.
import { createWorker, type Modules } from "@cloudflare/worker-bundler";
import { normalizePath } from "../shared/policy";
import type { Res } from "./ledger/ledger";
import { ledger } from "./service";
import { StoreError, storeFor, type RepoStore } from "./store/store";

// Fork names (`<repo>--t_<id>`) are valid preview repos too, hence the underscore.
const REPO = /^[a-z0-9][a-z0-9_-]{0,80}$/;
const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_MAIN = "src/index.ts";

type Built = { mainModule: string; modules: Modules };

// A commit never changes, so a bundle stays valid for as long as it is kept; the cap only bounds
// memory. Oldest-inserted goes first (a hit does not refresh an entry): previews are opened roughly in
// landing order, so the oldest is the least likely to be asked for again, and the rule stays predictable.
export const MAX_BUNDLES = 32;
const bundles = new Map<string, Built>();
let bundled = 0;

// Counts real bundler runs, so tests can tell a cache hit from a rebuild.
export const bundleCount = (): number => bundled;

class PreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const notFound = (error: string) => Response.json({ error }, { status: 404 });
const text = (status: number, body: string) => new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 800);

// Reads `preview.main` leniently: the ryke.json at an arbitrary commit may be invalid for reasons
// that have nothing to do with previews, and the policy parser would then hide the app.
function previewMain(text: string | null): string {
  try {
    const main = (JSON.parse(text ?? "{}") as { preview?: { main?: unknown } } | null)?.preview?.main;
    if (typeof main === "string") return normalizePath(main);
  } catch {
    // Not JSON, or a path that escapes the repo: fall back to the default entry point.
  }
  return DEFAULT_MAIN;
}

async function build(store: RepoStore, repo: string, sha: string): Promise<Built> {
  // files() fails for an unknown repo or commit; the ryke.json read rides along in parallel.
  const [all, policy] = await Promise.all([store.files(repo, sha), store.readFile(repo, sha, "ryke.json")]);
  const main = previewMain(policy);
  if (!all.includes(main)) throw new PreviewError(404, `no preview entry point ${main} at ${sha}`);
  const wanted = all.filter((p) => p.startsWith("src/") || p === "package.json" || p === main);
  const files: Record<string, string> = {};
  await Promise.all(
    wanted.map(async (p) => {
      const content = await store.readFile(repo, sha, p);
      if (content !== null) files[p] = content;
    }),
  );
  bundled++;
  let out;
  try {
    out = await createWorker({ files, entryPoint: main });
  } catch (e) {
    throw new PreviewError(502, `Preview of ${repo}@${sha.slice(0, 7)} could not be bundled.\n${short(e)}`);
  }
  if (bundles.size >= MAX_BUNDLES) bundles.delete(bundles.keys().next().value!);
  const built = { mainModule: out.mainModule, modules: out.modules };
  bundles.set(`${repo}:${sha}`, built);
  return built;
}

// Absolute paths in the app's HTML would leave the preview, so they get the preview prefix. Links
// built in client-side JS or CSS url() are out of reach of a streaming rewrite and stay as written.
function underPrefix(res: Response, prefix: string): Response {
  const fix = (el: Element) => {
    for (const attr of ["href", "src", "action"]) {
      const v = el.getAttribute(attr);
      if (v !== null && v.startsWith("/") && !v.startsWith("//")) el.setAttribute(attr, prefix + v);
    }
  };
  return new HTMLRewriter().on("[href],[src],[action]", { element: fix }).transform(res);
}

async function run(env: Env, request: Request, url: URL, repo: string, sha: string, rest: string, built: Built): Promise<Response> {
  const stub = env.LOADER.get(`${repo}:${sha}`, async () => ({
    compatibilityDate: "2026-10-01",
    mainModule: built.mainModule,
    modules: built.modules,
    env: {},
    globalOutbound: null,
  }));
  const forwarded = new Request(`${url.origin}${rest}${url.search}`, request);
  // The preview app is agent-written code; it must never see the caller's Ryke credentials.
  forwarded.headers.delete("authorization");
  let res: Response;
  try {
    res = await stub.getEntrypoint().fetch(forwarded);
  } catch (e) {
    throw new PreviewError(502, `Preview of ${repo}@${sha.slice(0, 7)} failed to run.\n${short(e)}`);
  }
  const prefix = `/preview/${repo}/${sha}`;
  // The runtime's responses have immutable headers.
  let out = new Response(res.body, res);
  out.headers.set("x-ryke-preview", `${repo}@${sha}`);
  // Previews run agent-written code on the dashboard's origin. The sandbox gives the page an opaque
  // origin, so its scripts cannot read the admin token the dashboard keeps in localStorage.
  out.headers.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups allow-modals");
  const location = out.headers.get("location");
  if (location?.startsWith("/") && !location.startsWith("//")) out.headers.set("location", prefix + location);
  if (/text\/html/i.test(out.headers.get("content-type") ?? "")) {
    // The rewrite changes the body length.
    out.headers.delete("content-length");
    out = underPrefix(out, prefix);
  }
  return out;
}

// GET /preview/:repo/:sha/* (any method; the app decides what it accepts). `sha` is a 40-hex commit
// or `head`, the Ledger's trunk head. Links in the answer are pinned to the resolved commit so a
// click-through stays on one version even while trunk moves.
export async function previewFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const m = /^\/preview\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const repo = m?.[1];
  const ref = m?.[2];
  const rest = m?.[3];
  if (!repo || !ref || !REPO.test(repo) || !(ref === "head" || SHA.test(ref))) return notFound("preview path must be /preview/<repo>/<40-hex sha | head>/");
  // 302: the bare form is a typing convenience, not a canonical URL for clients to remember.
  if (rest === undefined) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 302);
  try {
    let sha = ref;
    if (ref === "head") {
      // RPC types drop the error branch of Res (its `detail: unknown` is not serialisable), hence the cast.
      const summary = (await ledger(env, repo).summary()) as Res<{ head: string }>;
      if (!summary.ok) return Response.json({ error: summary.error }, { status: summary.status });
      sha = summary.value.head;
    }
    // A cached bundle is content-addressed, so it needs no store round trip.
    const built = bundles.get(`${repo}:${sha}`) ?? (await build(storeFor(env), repo, sha));
    return await run(env, request, url, repo, sha, rest, built);
  } catch (e) {
    if (e instanceof PreviewError) return e.status === 404 ? notFound(e.message) : text(e.status, e.message);
    if (e instanceof StoreError) return Response.json({ error: e.message }, { status: e.code === "NOT_FOUND" ? 404 : 503 });
    return text(502, `Preview of ${repo}@${ref.slice(0, 7)} failed.\n${short(e)}`);
  }
}
