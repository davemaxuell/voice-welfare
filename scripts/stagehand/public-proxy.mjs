import { createServer } from "node:http";
import net from "node:net";
import { once } from "node:events";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const publicHosts = ["www.bokjiro.go.kr", "developer.mozilla.org"];

export const mdnSample = host => /^[a-f\d-]{32,40}\.mdnplay\.dev$/i.test(host);
export const publicHost = host => publicHosts.includes(host) || mdnSample(host);

export async function startPublicProxy() {
  const child = fork(fileURLToPath(import.meta.url), ["--serve"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const [ready] = await once(child, "message");
  return { port: ready.port, async close() {
    const result = once(child, "message");
    child.send("close");
    const [report] = await result;
    return report;
  }};
}

if (process.argv.includes("--serve")) {
  const blocked = new Set(), allowed = new Set(), sockets = new Set();
  const proxy = createServer((req, res) => res.writeHead(403).end());
  proxy.on("connect", (req, browser, head) => {
    const [host, port] = req.url.split(":");
    if (port !== "443" || !publicHost(host)) {
      blocked.add(host);
      browser.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    allowed.add(host);
    const server = net.connect({ host, port: 443 });
    sockets.add(server);
    server.on("connect", () => {
      browser.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) server.write(head);
      browser.pipe(server).pipe(browser);
    });
    server.on("error", () => browser.destroy());
    browser.on("error", () => server.destroy());
    browser.on("close", () => server.destroy());
    server.on("close", () => { sockets.delete(server); browser.destroy(); });
  });
  proxy.listen(0, "127.0.0.1", () => process.send({ port: proxy.address().port }));
  process.on("message", () => {
    for (const socket of sockets) socket.destroy();
    proxy.close(() => process.send({ allowed: [...allowed], blocked: [...blocked] }, () => process.disconnect()));
  });
}
