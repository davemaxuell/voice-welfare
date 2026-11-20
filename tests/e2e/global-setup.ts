import { ensureMockSite } from "../../scripts/mock-site.ts";

export default async function setup() {
  const site = await ensureMockSite(5174);
  return async () => { await site?.close(); };
}
