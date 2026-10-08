import { RunnerError, type JobKind, type JobStatus, type Runner } from "./runner";

// Client for dev/runner, which runs containers/runner/bin/<kind>.sh as host processes (PLAN.md §3.3).
export class ProcessRunner implements Runner {
  constructor(private readonly base: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new RunnerError(`runner unreachable at ${this.base}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new RunnerError(`runner answered ${res.status} for ${method} ${path}: ${await res.text()}`);
    return res;
  }

  async start(kind: JobKind, args: Record<string, string>, env: Record<string, string>): Promise<string> {
    const r = (await (await this.call("POST", "/v1/jobs", { kind, args, env })).json()) as { id: string };
    return r.id;
  }

  async status(id: string): Promise<JobStatus> {
    const r = (await (await this.call("GET", `/v1/jobs/${id}`)).json()) as JobStatus;
    return { state: r.state, exitCode: r.exitCode, result: r.result };
  }

  async log(id: string, offset: number): Promise<{ text: string; next: number }> {
    const res = await this.call("GET", `/v1/jobs/${id}/log?offset=${offset}`);
    const text = await res.text();
    return { text, next: Number(res.headers.get("x-ryke-next-offset") ?? offset + text.length) };
  }

  async cancel(id: string): Promise<void> {
    await this.call("DELETE", `/v1/jobs/${id}`);
  }
}
