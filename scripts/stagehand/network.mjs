import net from "node:net";
import { createServer } from "node:http";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

export const localHost = host => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
const telemetry = url => /browserbase|stagehand\.dev|telemetry|opentelemetry|sentry|\/v1\/(traces|metrics|logs)(\/|$)|analytics|beacon/i.test(url);

// SDK를 가져오기 전에 건다. 허용하는 TCP 연결은 루프백뿐이다.
export function nodeNetwork() {
  const denied = [], local = new Set(), requests = [];
  function hostAllowed(host) {
    if (!localHost(host)) {
      denied.push(host);
      throw new Error("외부 연결 차단 " + host);
    }
    local.add(host);
  }
  function inspect(value, block = true) {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return;
    if (block) hostAllowed(url.hostname);
    else if (!localHost(url.hostname)) denied.push(url.hostname);
    requests.push({ host: url.hostname, telemetry: telemetry(url.href) });
  }
  const previousFetch = globalThis.fetch, previousSocket = net.Socket.prototype.connect;
  const PreviousWebSocket = globalThis.WebSocket;
  globalThis.fetch = function(input, ...args) {
    inspect(input instanceof Request ? input.url : input);
    return previousFetch.call(this, input, ...args);
  };
  globalThis.WebSocket = class extends PreviousWebSocket {
    constructor(url, ...args) { inspect(url); super(url, ...args); }
  };
  net.Socket.prototype.connect = function(...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const options = values[0];
    if (typeof options === "object" && options.port != null) hostAllowed(String(options.host ?? "localhost"));
    else if (typeof options === "number") hostAllowed(typeof values[1] === "string" ? values[1] : "localhost");
    return previousSocket.apply(this, args);
  };
  // undici와 내장 HTTP를 직접 부르는 SDK도 관찰한다. 소켓에서 실제 외부 연결은 계속 막힌다.
  const undici = msg => inspect(msg.request.origin + msg.request.path, false);
  const http = msg => {
    if (msg.request.socketPath) return;
    const host = msg.request.getHeader("host");
    if (host) inspect(new URL(msg.request.path, msg.request.protocol + "//" + host), false);
  };
  channel("undici:request:create").subscribe(undici);
  channel("http.client.request.start").subscribe(http);
  return { denied, local, requests, close() {
    channel("undici:request:create").unsubscribe(undici);
    channel("http.client.request.start").unsubscribe(http);
    globalThis.fetch = previousFetch;
    globalThis.WebSocket = PreviousWebSocket;
    net.Socket.prototype.connect = previousSocket;
  }};
}

export async function denyProxy() {
  const attempts = new Set();
  const server = createServer((req, res) => {
    attempts.add(new URL(req.url).hostname);
    res.writeHead(403).end();
  });
  server.on("connect", (req, socket) => {
    attempts.add(new URL("https://" + req.url).hostname);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, attempts, async close() {
    await new Promise(resolve => server.close(resolve));
  }};
}

// NetLog는 탭·확장·브라우저 프로세스를 전부 포함한다. 원문 URL은 출력하지 않는다.
export async function chromeAudit(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const events = raw.constants.logEventTypes;
  const urls = raw.events.filter(event => typeof event.params?.url === "string")
    .map(event => event.params.url).filter(value => /^(?:https?|wss?):\/\//i.test(value)).map(value => new URL(value));
  const requests = raw.events.filter(event => event.type === events.URL_REQUEST_START_JOB || event.type === events.WEB_SOCKET_CREATED);
  const extensionSocket = raw.events.some(event => JSON.stringify(event.params ?? {}).includes("chrome-extension://") &&
    /websocket|upgrade/i.test(JSON.stringify(event.params)));
  const external = [...new Set(urls.filter(url => !localHost(url.hostname)).map(url => url.hostname))];
  return { urls: urls.length, requests: requests.length, external,
    telemetry: urls.filter(url => telemetry(url.href)).map(url => url.hostname), extensionSocket };
}
