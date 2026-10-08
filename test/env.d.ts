declare module "vitest" {
  export interface ProvidedContext {
    fixture: { name: string; commits: [string, string] };
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      RYKE_TEST_GIT_URL: string;
      RYKE_STORE_CONTRACT?: string;
    }
  }
}

export {};
