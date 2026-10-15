import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Egress policy for the discovery worker (SSRF protection).
 *
 * Blocks loopback, private, link-local, carrier-grade NAT, multicast, reserved and
 * documentation ranges (IPv4 and IPv6, including IPv4 embedded in IPv6), cloud metadata
 * endpoints and local-only hostnames. A hostname is blocked if *any* of its DNS answers is
 * blocked. Callers must connect to the address returned here (not re-resolve) to avoid DNS
 * rebinding — the egress proxy does exactly that.
 *
 * For local development and tests only, exact `host:port` pairs can be allowlisted with
 * DISCOVERY_PRIVATE_ALLOWLIST. It is ignored when NODE_ENV=production.
 */

export type BlockReason =
  | "loopback"
  | "private-network"
  | "link-local"
  | "metadata-endpoint"
  | "reserved"
  | "multicast"
  | "local-hostname"
  | "unsupported-scheme"
  | "dns-failure";

const v4Ranges: Array<[string, number, BlockReason]> = [
  ["0.0.0.0", 8, "reserved"],
  ["10.0.0.0", 8, "private-network"],
  ["100.64.0.0", 10, "private-network"], // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"], // includes AWS/GCP/Azure metadata 169.254.169.254
  ["172.16.0.0", 12, "private-network"],
  ["192.0.0.0", 24, "reserved"],
  ["192.0.2.0", 24, "reserved"],
  ["192.88.99.0", 24, "reserved"],
  ["192.168.0.0", 16, "private-network"],
  ["198.18.0.0", 15, "reserved"],
  ["198.51.100.0", 24, "reserved"],
  ["203.0.113.0", 24, "reserved"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"], // includes 255.255.255.255
];

const v6Ranges: Array<[string, number, BlockReason]> = [
  ["::", 128, "reserved"],
  ["::1", 128, "loopback"],
  ["100::", 64, "reserved"],
  ["2001:db8::", 32, "reserved"],
  ["fc00::", 7, "private-network"], // unique local, includes AWS metadata fd00:ec2::254
  ["fe80::", 10, "link-local"],
  ["ff00::", 8, "multicast"],
];
/** One BlockList per range so a match also tells us the reason. */
function compile(ranges: Array<[string, number, BlockReason]>, type: "ipv4" | "ipv6") {
  return ranges.map(([address, prefix, reason]) => {
    const list = new BlockList();
    list.addSubnet(address, prefix, type);
    return { list, reason };
  });
}
const V4 = compile(v4Ranges, "ipv4");
const V6 = compile(v6Ranges, "ipv6");

const METADATA_ADDRESSES = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]);
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.internal",
]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];

/** Expands an IPv6 address to its 8 groups (handles `::` and a trailing dotted IPv4). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().split("%")[0];
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const parse = (part: string) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  return [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
}

/** IPv4 address embedded in an IPv6 one (mapped, compatible, NAT64 or 6to4), if any. */
export function embeddedIpv4(address: string): string | null {
  const g = ipv6Groups(address);
  const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return toV4(g[6], g[7]); // ::ffff:a.b.c.d
  if (zeros(6) && (g[6] !== 0 || g[7] > 1)) return toV4(g[6], g[7]); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return toV4(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return toV4(g[1], g[2]); // 6to4
  return null;
}

/** Why an IP address must not be contacted, or null if it is a public unicast address. */
export function classifyAddress(address: string): BlockReason | null {
  const family = isIP(address);
  if (family === 0) return "reserved";
  if (METADATA_ADDRESSES.has(address.toLowerCase())) return "metadata-endpoint";

  if (family === 4) return V4.find(({ list }) => list.check(address, "ipv4"))?.reason ?? null;

  const embedded = embeddedIpv4(address);
  if (embedded) return classifyAddress(embedded);
  return V6.find(({ list }) => list.check(address, "ipv6"))?.reason ?? null;
}

/** Hostname-level checks that need no DNS (metadata names, local-only names, IP literals). */
export function classifyHostname(hostname: string): BlockReason | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host)) return classifyAddress(host);
  if (METADATA_HOSTNAMES.has(host)) return "metadata-endpoint";
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "local-hostname";
  // Single-label names ("redis", "intranet") only resolve inside private networks.
  if (!host.includes(".")) return "local-hostname";
  return null;
}

/** Exact host:port pairs allowed despite being private. Never honoured in production. */
export function privateAllowlist(): Set<string> {
  if (process.env.NODE_ENV === "production") return new Set();
  return new Set(
    (process.env.DISCOVERY_PRIVATE_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowlisted(hostname: string, port: number): boolean {
  return privateAllowlist().has(`${hostname.toLowerCase().replace(/^\[|\]$/g, "")}:${port}`);
}

export function defaultPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

export type ResolvedTarget = { ok: true; address: string; family: 4 | 6 } | { ok: false; reason: BlockReason; detail: string };

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemLookup: Lookup = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Resolves a host and returns the address to connect to, or why it is blocked.
 * `lookupFn` is injectable for tests.
 */
export async function resolveTarget(hostname: string, port: number, lookupFn: Lookup = systemLookup): Promise<ResolvedTarget> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowlisted = isAllowlisted(host, port);

  if (!allowlisted) {
    const reason = classifyHostname(host);
    if (reason) return { ok: false, reason, detail: `${host} is not a public host (${reason})` };
  }
  if (isIP(host)) return { ok: true, address: host, family: isIP(host) as 4 | 6 };

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookupFn(host);
  } catch {
    return { ok: false, reason: "dns-failure", detail: `Could not resolve ${host}` };
  }
  if (answers.length === 0) return { ok: false, reason: "dns-failure", detail: `No addresses for ${host}` };

  if (!allowlisted) {
    for (const answer of answers) {
      const reason = classifyAddress(answer.address);
      if (reason) return { ok: false, reason, detail: `${host} resolves to ${answer.address} (${reason})` };
    }
  }
  return { ok: true, address: answers[0].address, family: answers[0].family as 4 | 6 };
}

/**
 * DNS-free check used when an application is saved: rejects URLs that obviously target
 * local, private or metadata hosts. The worker re-checks with DNS before connecting.
 */
export function staticUrlBlockReason(rawUrl: string): BlockReason | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "reserved";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "unsupported-scheme";
  if (isAllowlisted(url.hostname, defaultPort(url))) return null;
  return classifyHostname(url.hostname);
}

export const BLOCK_REASON_LABELS: Record<BlockReason, string> = {
  loopback: "Loopback address",
  "private-network": "Private network",
  "link-local": "Link-local address",
  "metadata-endpoint": "Cloud metadata endpoint",
  reserved: "Reserved address",
  multicast: "Multicast address",
  "local-hostname": "Local-only hostname",
  "unsupported-scheme": "Unsupported scheme",
  "dns-failure": "DNS lookup failed",
};
