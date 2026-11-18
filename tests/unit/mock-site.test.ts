import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { CHECKOUT_HEADER } from "../../src/practice_site/serve.ts";
import { checkoutId, ensureMockSite, portState, startMockSite } from "../../scripts/mock-site.ts";

async function foreign() {
  const s = createServer((_req,res) => res.end("other"));
  await new Promise<void>(done => s.listen(0,"127.0.0.1",done));
  const addr = s.address();
  if (addr === null || typeof addr === "string") throw Error("port");
  return { port:addr.port, close: () => new Promise<void>(done => { s.close(() => done()); s.closeAllConnections(); }) };
}
it("test_starts_its_own_site_then_reuses_it", async () => {
  const site = await startMockSite(0);
  try {
    expect(await portState(site.port)).toBe("ours");
    expect(await ensureMockSite(site.port,0)).toBeUndefined();
    for (const host of ["localhost","127.0.0.1"]) {
      const r = await fetch("http://" + host + ":" + site.port + "/src/apply.js");
      expect(r.status).toBe(200);
      expect(r.headers.get(CHECKOUT_HEADER)).toBe(await checkoutId());
      expect(r.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      await r.arrayBuffer();
    }
  } finally { await site.close(); }
  expect(await portState(site.port)).toBe("free");
});
it("test_does_not_reuse_another_checkouts_server", async () => {
  const site = await foreign();
  try { await expect(ensureMockSite(site.port,0)).rejects.toThrow(String(site.port)); }
  finally { await site.close(); }
});
it("test_cannot_share_a_port_another_server_holds", async () => {
  const site = await foreign();
  try { await expect(startMockSite(site.port)).rejects.toMatchObject({code: expect.stringMatching(/EADDRINUSE|EACCES/u)}); }
  finally { await site.close(); }
});
it("test_takes_the_port_once_the_other_server_stops", async () => {
  const site = await foreign(), worker = ensureMockSite(site.port,4);
  await delay(60); await site.close();
  const own = await worker;
  try { expect(own?.port).toBe(site.port); } finally { await own?.close(); }
});
