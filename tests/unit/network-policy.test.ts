import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyAddress,
  classifyHostname,
  embeddedIpv4,
  resolveTarget,
  staticUrlBlockReason,
} from "@/modules/discovery/network-policy";

afterEach(() => {
  delete process.env.DISCOVERY_PRIVATE_ALLOWLIST;
  vi.unstubAllEnvs();
});

describe("address classification", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.1.2.3", "private-network"],
    ["172.16.0.1", "private-network"],
    ["172.31.255.255", "private-network"],
    ["192.168.1.10", "private-network"],
    ["100.64.0.1", "private-network"],
    ["169.254.169.254", "metadata-endpoint"],
    ["169.254.170.2", "metadata-endpoint"],
    ["100.100.100.200", "metadata-endpoint"],
    ["169.254.1.1", "link-local"],
    ["0.0.0.0", "reserved"],
    ["255.255.255.255", "reserved"],
    ["224.0.0.1", "multicast"],
    ["198.18.0.1", "reserved"],
    ["::1", "loopback"],
    ["::", "reserved"],
    ["fd00:ec2::254", "metadata-endpoint"],
    ["fc00::1", "private-network"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "metadata-endpoint"],
    ["::ffff:10.0.0.1", "private-network"],
    ["64:ff9b::a9fe:a9fe", "metadata-endpoint"], // NAT64 of 169.254.169.254
    ["2002:7f00:1::", "loopback"], // 6to4 of 127.0.0.1
    ["not-an-ip", "reserved"],
  ])("blocks %s as %s", (address, reason) => {
    expect(classifyAddress(address)).toBe(reason);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "11.0.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows public %s", (address) => {
    expect(classifyAddress(address)).toBeNull();
  });

  it("extracts IPv4 embedded in IPv6", () => {
    expect(embeddedIpv4("::ffff:192.168.0.1")).toBe("192.168.0.1");
    expect(embeddedIpv4("2001:4860::1")).toBeNull();
  });
});

describe("hostname classification", () => {
  it.each([
    ["localhost", "local-hostname"],
    ["LOCALHOST.", "local-hostname"],
    ["app.localhost", "local-hostname"],
    ["printer.local", "local-hostname"],
    ["db.internal", "local-hostname"],
    ["redis", "local-hostname"],
    ["metadata.google.internal", "metadata-endpoint"],
    ["metadata", "metadata-endpoint"],
    ["[::1]", "loopback"],
    ["127.0.0.1", "loopback"],
  ])("blocks %s", (host, reason) => {
    expect(classifyHostname(host)).toBe(reason);
  });

  it("allows public names", () => {
    expect(classifyHostname("staging.example.com")).toBeNull();
  });
});

describe("static URL check (no DNS)", () => {
  it.each([
    ["http://localhost:3000", "local-hostname"],
    ["http://127.0.0.1", "loopback"],
    ["http://2130706433/", "loopback"], // decimal IPv4 normalised by the URL parser
    ["http://0x7f.1/", "loopback"], // hex/short form
    ["http://017700000001/", "loopback"], // octal
    ["http://[::ffff:127.0.0.1]/", "loopback"],
    ["http://169.254.169.254/latest/meta-data/", "metadata-endpoint"],
    ["http://metadata.google.internal/", "metadata-endpoint"],
    ["ftp://example.com/", "unsupported-scheme"],
  ])("refuses %s", (url, reason) => {
    expect(staticUrlBlockReason(url)).toBe(reason);
  });

  it("accepts public URLs", () => {
    expect(staticUrlBlockReason("https://staging.example.com/app")).toBeNull();
  });

  it("honours exact host:port allowlist entries outside production only", () => {
    process.env.DISCOVERY_PRIVATE_ALLOWLIST = "127.0.0.1:4100";
    expect(staticUrlBlockReason("http://127.0.0.1:4100/")).toBeNull();
    expect(staticUrlBlockReason("http://127.0.0.1:4101/")).toBe("loopback");
    expect(staticUrlBlockReason("http://localhost:4100/")).toBe("local-hostname");
    vi.stubEnv("NODE_ENV", "production");
    expect(staticUrlBlockReason("http://127.0.0.1:4100/")).toBe("loopback");
  });
});

describe("DNS resolution", () => {
  const fakeDns = (answers: Record<string, string[]>) => async (host: string) => {
    if (!answers[host]) throw new Error("ENOTFOUND");
    return answers[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

  it("returns the address to connect to for public hosts", async () => {
    await expect(resolveTarget("shop.example.com", 443, fakeDns({ "shop.example.com": ["93.184.216.34"] }))).resolves.toEqual({
      ok: true,
      address: "93.184.216.34",
      family: 4,
    });
  });

  it("blocks a host if any answer is private (split / rebinding records)", async () => {
    const result = await resolveTarget("rebind.example.com", 80, fakeDns({ "rebind.example.com": ["93.184.216.34", "127.0.0.1"] }));
    expect(result).toMatchObject({ ok: false, reason: "loopback" });
  });

  it("blocks names that resolve to metadata or private ranges", async () => {
    const dns = fakeDns({ "evil.example.com": ["169.254.169.254"], "corp.example.com": ["10.0.0.5"], "v6.example.com": ["::ffff:127.0.0.1"] });
    expect(await resolveTarget("evil.example.com", 80, dns)).toMatchObject({ ok: false, reason: "metadata-endpoint" });
    expect(await resolveTarget("corp.example.com", 80, dns)).toMatchObject({ ok: false, reason: "private-network" });
    expect(await resolveTarget("v6.example.com", 80, dns)).toMatchObject({ ok: false, reason: "loopback" });
  });

  it("reports DNS failures and blocks local names without resolving them", async () => {
    const dns = fakeDns({});
    expect(await resolveTarget("missing.example.com", 80, dns)).toMatchObject({ ok: false, reason: "dns-failure" });
    expect(await resolveTarget("localhost", 80, dns)).toMatchObject({ ok: false, reason: "local-hostname" });
  });
});
