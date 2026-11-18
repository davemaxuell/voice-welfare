import { parseArgs } from "node:util";
import { practiceSite } from "../src/core/assets.ts";
import { createPracticeSite } from "../src/practice_site/serve.ts";

export const { checkoutId, startMockSite, portState, ensureMockSite } = createPracticeSite(practiceSite);

if (import.meta.main) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "5174" } } });
  const site = await startMockSite(Number(values.port));
  process.stdout.write("[mock] http://localhost:" + site.port + "\n");
  for (const signal of ["SIGINT","SIGTERM"] as const) process.once(signal, () => { void site.close(); });
}
