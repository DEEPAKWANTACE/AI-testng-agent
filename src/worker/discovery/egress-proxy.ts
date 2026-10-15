import http from "node:http";
import net from "node:net";
import { BLOCK_REASON_LABELS, classifyHostname, resolveTarget, type BlockReason } from "@/modules/discovery/network-policy";

/**
 * Filtering forward proxy: the browser's only route to the network.
 *
 * Every connection — page loads, redirect hops, subresources, fetch/XHR, IP literals — is
 * checked here at connect time, and the proxy connects to the exact address it validated,
 * which closes the DNS-rebinding gap of "resolve, check, then let the browser connect".
 * HTTPS is tunnelled (CONNECT) without interception; plain HTTP is forwarded without
 * following redirects, so each redirect hop comes back through this check.
 */

export type EgressScope = {
  /** The authorized origin's host and port: always reachable (subject to the IP policy). */
  target: { hostname: string; port: number };
  /** Also allow public third-party hosts on ports 80/443 (e.g. CDN assets). */
  allowExternal: boolean;
};

export type BlockedRequest = { target: string; reason: BlockReason | "out-of-scope" | "websocket"; detail: string };

export type EgressProxy = {
  port: number;
  blocked: BlockedRequest[];
  close: () => Promise<void>;
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const IDLE_TIMEOUT_MS = 30_000;
const MAX_BLOCKED_RECORDS = 500;

async function decide(scope: EgressScope, hostname: string, port: number) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isTarget = host === scope.target.hostname.toLowerCase() && port === scope.target.port;
  if (!isTarget && !(scope.allowExternal && (port === 80 || port === 443))) {
    const danger = classifyHostname(host);
    const note = danger ? ` (${BLOCK_REASON_LABELS[danger].toLowerCase()})` : "";
    return { ok: false as const, reason: "out-of-scope" as const, detail: `${host}:${port} is outside the authorized URL${note}` };
  }
  return resolveTarget(host, port);
}

export async function startEgressProxy(scope: EgressScope): Promise<EgressProxy> {
  const blocked: BlockedRequest[] = [];
  // Tunnelled sockets are detached from the HTTP server, so track them for shutdown.
  const tunnels = new Set<net.Socket>();
  const record = (entry: BlockedRequest) => {
    if (blocked.length < MAX_BLOCKED_RECORDS) blocked.push(entry);
  };
  const deny = (reason: BlockedRequest["reason"]) =>
    reason === "out-of-scope" || reason === "websocket" ? reason : BLOCK_REASON_LABELS[reason];

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP proxying: the request line carries an absolute URL.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error("not http");
    } catch {
      res.writeHead(400).end("Bad proxy request");
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const decision = await decide(scope, url.hostname, port);
    if (!decision.ok) {
      record({ target: `${url.origin}${url.pathname}`, reason: decision.reason, detail: decision.detail });
      res.writeHead(403, { "content-type": "text/plain", "x-qa-agent-blocked": deny(decision.reason) }).end("Blocked by QA Agent egress policy");
      return;
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
    headers.host = url.host;

    const upstream = http.request(
      { host: decision.address, family: decision.family, port, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false },
      (upstreamRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value;
        // Relay redirects as-is: the browser's next hop comes back through this proxy.
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end("Upstream error");
      else res.destroy();
    });
    req.pipe(upstream);
  });

  // HTTPS (and wss) tunnelling.
  server.on("connect", async (req, clientSocket: net.Socket, head: Buffer) => {
    tunnels.add(clientSocket);
    clientSocket.on("close", () => tunnels.delete(clientSocket));
    clientSocket.on("error", () => clientSocket.destroy());
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(req.url ?? "");
    if (!match) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const [, hostname, portText] = match;
    const port = Number(portText);
    const decision = await decide(scope, hostname, port);
    if (!decision.ok) {
      record({ target: `${hostname}:${port}`, reason: decision.reason, detail: decision.detail });
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nx-qa-agent-blocked: ${deny(decision.reason)}\r\n\r\n`);
      return;
    }
    const upstream = net.connect({ host: decision.address, port, family: decision.family }, () => {
      tunnels.add(upstream);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    clientSocket.setTimeout(IDLE_TIMEOUT_MS, () => clientSocket.destroy());
    upstream.on("error", () => clientSocket.destroy());
    upstream.on("close", () => {
      tunnels.delete(upstream);
      clientSocket.destroy();
    });
  });

  // Plain ws:// upgrades aren't needed for discovery.
  server.on("upgrade", (req, socket: net.Socket) => {
    record({ target: req.url ?? "", reason: "websocket", detail: "WebSocket connections are not allowed during discovery" });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    blocked,
    close: () =>
      new Promise((resolve) => {
        for (const socket of tunnels) socket.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
