import { createAdaptorServer } from "@hono/node-server";
import { Server } from "node:http";
import type { Hono } from "hono";
import { WebSocketServer } from "ws";

export function createHttpService(app: Pick<Hono, "fetch">) {
  const sockets = new WebSocketServer({ noServer: true });
  const listener = createAdaptorServer({ fetch: app.fetch, websocket: { server: sockets } });
  if (!(listener instanceof Server)) throw new Error("HTTP/1 server required");
  const server = listener;
  function closeServer() {
    for (const client of sockets.clients) client.terminate();
    return new Promise<void>((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }
  return { server, closeServer };
}
