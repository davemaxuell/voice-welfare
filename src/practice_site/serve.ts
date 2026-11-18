import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, get, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CHECKOUT_HEADER = "X-Ieum-Checkout";
const mime = new Map([[".js","text/javascript; charset=utf-8"],[".css","text/css; charset=utf-8"],
  [".html","text/html; charset=utf-8"],[".json","application/json"],[".svg","image/svg+xml"]]);
function hasCode(error: unknown, ...codes: string[]) {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}
function within(root: string, file: string) {
  const suffix = relative(root,file);
  return suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix);
}
async function serve(method: string | undefined, target: string | undefined, res: ServerResponse, root: string, checkout: string) {
  res.setHeader("Cache-Control","no-store");
  res.setHeader(CHECKOUT_HEADER,checkout);
  if (method !== "GET" && method !== "HEAD") { res.writeHead(501).end(); return; }
  try {
    const path = decodeURIComponent(new URL(target ?? "/", "http://localhost").pathname);
    const file = await realpath(resolve(root,"." + (path.endsWith("/") ? path + "index.html" : path)));
    if (!within(root,file) || !(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { "Content-Type": mime.get(extname(file)) ?? "application/octet-stream", "Content-Length": bytes.length });
    res.end(method === "HEAD" ? undefined : bytes);
  } catch { res.writeHead(404).end(); }
}
function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((done,reject) => {
    server.once("error",reject);
    server.listen({ port, host, exclusive:true, ipv6Only:host === "::1" }, () => { server.off("error",reject); done(); });
  });
}
async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((done,reject) => {
    server.close(error => error === undefined ? done() : reject(error));
    server.closeAllConnections();
  });
}
export function createPracticeSite(rootPath: string) {
  async function checkoutId() { return createHash("sha1").update(await realpath(rootPath)).digest("hex").slice(0,12); }
  async function startMockSite(port = 5174) {
    const root = await realpath(rootPath), checkout = await checkoutId();
    const make = () => createServer((req,res) => { void serve(req.method,req.url,res,root,checkout); });
    const ipv4 = make();
    await listen(ipv4,"127.0.0.1",port);
    const addr = ipv4.address();
    if (addr === null || typeof addr === "string") throw Error("모의 사이트 포트를 확인할 수 없습니다.");
    const ipv6 = make();
    try { await listen(ipv6,"::1",addr.port); }
    catch (e) {
      if (!hasCode(e,"EAFNOSUPPORT","EADDRNOTAVAIL","EPROTONOSUPPORT")) { await close(ipv4); throw e; }
    }
    return { port:addr.port, async close() { await Promise.all([close(ipv4), close(ipv6)]); } };
  }
  async function portState(port: number): Promise<"ours" | "other" | "free"> {
    const expected = await checkoutId();
    return new Promise(done => {
      const req = get({ host:"127.0.0.1",port,path:"/",agent:false,timeout:1500 },res => {
        res.resume(); done(res.headers[CHECKOUT_HEADER.toLowerCase()] === expected ? "ours" : "other");
      });
      req.on("timeout", () => req.destroy(Error("timeout")));
      req.on("error", error => done(hasCode(error,"ECONNREFUSED") ? "free" : "other"));
    });
  }
  async function ensureMockSite(port = 5174, waitSeconds = Number(process.env.MOCK_SITE_WAIT_S ?? 120)) {
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw Error("MOCK_SITE_WAIT_S에는 0 이상의 초를 입력하세요.");
    const until = performance.now() + waitSeconds*1000;
    while (true) {
      const state = await portState(port);
      if (state === "ours") return undefined;
      if (state === "free") {
        try { return await startMockSite(port); }
        catch (error) { if (!hasCode(error,"EADDRINUSE","EACCES")) throw error; }
      }
      if (performance.now() >= until) throw Error("포트 " + port + "를 다른 작업 트리가 쓰고 있습니다. MOCK_SITE_WAIT_S로 더 기다리게 하세요.");
      await delay(Math.min(2000, Math.max(1,until-performance.now())));
    }
  }
  return { checkoutId, startMockSite, portState, ensureMockSite };
}
