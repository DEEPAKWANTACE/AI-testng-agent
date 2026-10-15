import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCanary } from "../../demo/target-app";
import { startEgressProxy, type EgressProxy } from "@/worker/discovery/egress-proxy";

/** Sends a plain-HTTP proxy request (absolute URL in the request line). */
function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: target.host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Sends a CONNECT request and returns the proxy's status line. */
function connect(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.once("data", (data) => {
      resolve(data.toString().split("\r\n")[0]);
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

describe("egress proxy", () => {
  let target: Awaited<ReturnType<typeof startCanary>>;
  let canary: Awaited<ReturnType<typeof startCanary>>;
  let proxy: EgressProxy;

  beforeAll(async () => {
    target = await startCanary(); // stands in for the authorized app
    canary = await startCanary(); // must never be reached
    process.env.DISCOVERY_PRIVATE_ALLOWLIST = `127.0.0.1:${target.port}`;
    proxy = await startEgressProxy({ target: { hostname: "127.0.0.1", port: target.port }, allowExternal: false });
  });

  afterAll(async () => {
    delete process.env.DISCOVERY_PRIVATE_ALLOWLIST;
    await proxy.close();
    await target.close();
    await canary.close();
  });

  it("forwards requests to the authorized target", async () => {
    const res = await viaProxy(proxy.port, `http://127.0.0.1:${target.port}/hello?x=1`);
    expect(res).toMatchObject({ status: 200, body: "canary" });
    expect(target.requests).toContain("GET /hello?x=1");
  });

  it.each([
    (port: number) => `http://127.0.0.1:${port}/secret`,
    (port: number) => `http://localhost:${port}/secret`,
    (port: number) => `http://[::1]:${port}/secret`,
  ])("refuses other local ports (%#)", async (url) => {
    const res = await viaProxy(proxy.port, url(canary.port));
    expect(res.status).toBe(403);
    expect(res.headers["x-qa-agent-blocked"]).toBeDefined();
  });

  it("refuses metadata endpoints over HTTP and CONNECT", async () => {
    expect((await viaProxy(proxy.port, "http://169.254.169.254/latest/meta-data/")).status).toBe(403);
    expect(await connect(proxy.port, "169.254.169.254:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connect(proxy.port, `127.0.0.1:${canary.port}`)).toBe("HTTP/1.1 403 Forbidden");
  });

  it("tunnels CONNECT to the authorized target", async () => {
    expect(await connect(proxy.port, `127.0.0.1:${target.port}`)).toBe("HTTP/1.1 200 Connection Established");
  });

  it("refuses WebSocket upgrades", async () => {
    const res = await new Promise<number>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: `http://127.0.0.1:${target.port}/ws`,
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      req.on("response", (r) => resolve(r.statusCode ?? 0));
      req.on("upgrade", (r) => resolve(r.statusCode ?? 0));
      req.on("error", () => resolve(-1));
      req.end();
    });
    expect([403, -1]).toContain(res);
  });

  it("records blocked requests and never reached the canary", () => {
    expect(proxy.blocked.length).toBeGreaterThanOrEqual(5);
    expect(proxy.blocked.some((b) => b.detail.includes("metadata"))).toBe(true);
    expect(canary.requests).toEqual([]);
  });

  it("blocks public hosts in strict mode", async () => {
    expect(await connect(proxy.port, "example.com:443")).toBe("HTTP/1.1 403 Forbidden");
  });
});
