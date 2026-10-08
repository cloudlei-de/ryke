// vitest.config.ts runs in Node, but the project has no @types/node (the Worker uses workerd types).
declare module "node:net" {
  export function createServer(): {
    once(event: "error", cb: (e: Error) => void): void;
    listen(port: number, host: string, cb: () => void): void;
    address(): unknown;
    close(cb: () => void): void;
  };
}
