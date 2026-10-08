// `npm run dev:all`: the whole local platform in one process; Ctrl-C stops everything.
import { startStack } from "./stack.mjs";

const stack = await startStack({ fresh: process.argv.includes("--fresh") });
console.log(`ryke dev stack ready: ${stack.apiUrl} (state ${stack.stateDir})`);
const stop = async () => {
  await stack.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
