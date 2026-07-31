/**
 * SSRF-safe egress for remote connectors.
 *
 * Remote connector discovery, OAuth metadata, and tool invocation all reach
 * arbitrary, org-configured URLs. This module is the single choke point that
 * enforces HTTPS, blocks private/loopback/link-local/metadata destinations, and
 * re-validates every redirect hop. The IP classification is a pure function so
 * it is unit-testable without network access.
 *
 * DNS is resolved once per hop and the socket connects directly to a validated
 * address while retaining the original Host/SNI identity. This makes the
 * credential-resolving gateway path authoritative against DNS rebinding rather
 * than relying on an unrelated sandbox network boundary.
 */

import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { optionalBooleanEnv } from "@lush/config/env";

export type EgressPolicy = {
  /** Allow plain http:// (never in production). */
  allowInsecureHttp: boolean;
  /** Allow loopback/private destinations (local dev + tests only). */
  allowPrivateHosts: boolean;
  /** Maximum number of redirects to follow. */
  maxRedirects: number;
};

export class EgressError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502
  ) {
    super(message);
    this.name = "EgressError";
  }
}

export function defaultEgressPolicy(): EgressPolicy {
  // Private/insecure destinations are only permitted when explicitly opted in,
  // which the dev and test harnesses do for local mock servers. Env access goes
  // through the config boundary helper rather than reading the environment here.
  const allowPrivate = optionalBooleanEnv("LUSH_TOOLS_ALLOW_PRIVATE_EGRESS", false);
  return {
    allowInsecureHttp: allowPrivate,
    allowPrivateHosts: allowPrivate,
    maxRedirects: 5
  };
}

/**
 * Classify a literal IP address (v4 or v6) as safe for public egress or not.
 * Returns a reason string when blocked, or null when the address is a routable
 * public address.
 */
export function classifyIp(ip: string): string | null {
  const normalized = ip.trim().toLowerCase();

  if (normalized.includes(":")) {
    return classifyIpv6(normalized);
  }
  return classifyIpv4(normalized);
}

function classifyIpv4(ip: string): string | null {
  const parts = ip.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))
  ) {
    return `invalid IPv4 address: ${ip}`;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((n) => n > 255)) return `invalid IPv4 address: ${ip}`;
  const [a, b, c] = octets as [number, number, number, number];

  if (a === 0) return "unspecified address";
  if (a === 10) return "private network (10.0.0.0/8)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 169 && b === 254) return "link-local / cloud metadata (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "private network (172.16.0.0/12)";
  if (a === 192 && b === 168) return "private network (192.168.0.0/16)";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT (100.64.0.0/10)";
  if (a === 192 && b === 0) return "IANA special-use (192.0.0.0/24)";
  if (a === 192 && b === 88 && c === 99) return "6to4 relay anycast (192.88.99.0/24)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15)";
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (incl. 255.255.255.255).
  if (a >= 224) return "multicast/reserved range";
  return null;
}

function classifyIpv6(ip: string): string | null {
  let address = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  // Drop any zone identifier (e.g. fe80::1%eth0) before parsing.
  address = address.split("%")[0] ?? address;

  // Fully expand so compressed, hex-mapped, and dotted-quad forms all classify
  // identically (e.g. ::1, 0:0:0:0:0:0:0:1, ::ffff:127.0.0.1, and
  // 0:0:0:0:0:ffff:7f00:1 all resolve to loopback).
  const hextets = expandIpv6(address);
  if (!hextets) {
    return `invalid IPv6 address: ${ip}`;
  }

  if (hextets.every((h) => h === 0)) return "unspecified address";
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) {
    return "loopback (::1)";
  }

  // IPv4-mapped ::ffff:0:0/96 — classify the embedded IPv4.
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return classifyIpv4(hextetsToIpv4(hextets[6]!, hextets[7]!));
  }

  const first = hextets[0]!;
  if ((first & 0xfe00) === 0xfc00) return "unique-local address (fc00::/7)";
  if ((first & 0xffc0) === 0xfe80) return "link-local address (fe80::/10)";
  if ((first & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  if (first === 0x64 && hextets[1] === 0xff9b) return "NAT64 (64:ff9b::/96)";
  return null;
}

/** Expand an IPv6 string to exactly 8 hextets, or null if malformed. */
function expandIpv6(address: string): number[] | null {
  let addr = address;
  // Convert a trailing dotted-quad (IPv4 tail) into two hextets.
  const dotted = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[2]) {
    const octets = dotted[2].split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    addr = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] =>
    part.length === 0 ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];

  const valid = (groups: number[]) =>
    groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff);
  if (!valid(head) || !valid(tail)) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null; // "::" must stand for at least one group.
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function hextetsToIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Validate a URL against the egress policy, resolving its hostname and rejecting
 * any address that classifies as private/reserved. Returns the resolved URL
 * unchanged when safe.
 */
export async function assertSafeUrl(
  rawUrl: string,
  policy: EgressPolicy,
  resolver: (host: string) => Promise<string[]> = defaultResolver
): Promise<URL> {
  return (await resolveSafeDestination(rawUrl, policy, resolver)).url;
}

type SafeDestination = { url: URL; address: string };

async function resolveSafeDestination(
  rawUrl: string,
  policy: EgressPolicy,
  resolver: (host: string) => Promise<string[]> = defaultResolver
): Promise<SafeDestination> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressError("invalid_url", `Invalid URL: ${rawUrl}`, 400);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EgressError(
      "unsupported_scheme",
      `Unsupported URL scheme: ${url.protocol}`,
      400
    );
  }
  if (url.username || url.password) {
    throw new EgressError(
      "embedded_credentials",
      "Remote connector URLs must not contain credentials",
      400
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const originalHost = rawAuthorityHostname(rawUrl);
  if (
    isIP(host) === 4 &&
    originalHost !== null &&
    originalHost.toLowerCase() !== host.toLowerCase()
  ) {
    // WHATWG URL parsing accepts legacy octal, hexadecimal, integer, short,
    // and trailing-dot IPv4 spellings. Reject rather than silently normalize
    // them so policy classification and socket connection share one spelling.
    throw new EgressError(
      "ambiguous_ip_literal",
      `IPv4 address must use canonical dotted-decimal notation: ${originalHost}`,
      400
    );
  }
  if (url.protocol === "http:" && !policy.allowInsecureHttp) {
    throw new EgressError(
      "insecure_scheme",
      "Remote connectors require HTTPS",
      400
    );
  }

  // A literal IP in the URL is checked directly; otherwise resolve DNS and check
  // every returned address to defeat DNS rebinding to an internal target. When
  // the host is an IP literal the classification below covers it fully, so no
  // separate literal check is needed.
  const addresses = isIP(host) !== 0 ? [host] : await resolver(host);

  if (addresses.length === 0) {
    throw new EgressError("dns_failure", `Could not resolve host: ${host}`, 502);
  }

  for (const address of addresses) {
    const reason = classifyIp(address);
    if (reason && !policy.allowPrivateHosts) {
      throw new EgressError(
        "blocked_destination",
        `Destination ${host} (${address}) is blocked: ${reason}`,
        403
      );
    }
  }

  return { url, address: addresses[0]! };
}

function rawAuthorityHostname(rawUrl: string): string | null {
  const schemeEnd = rawUrl.indexOf("://");
  if (schemeEnd < 0) return null;

  const authorityStart = schemeEnd + 3;
  const authorityEnd = rawUrl.slice(authorityStart).search(/[/?#]/);
  const authority = rawUrl.slice(
    authorityStart,
    authorityEnd < 0 ? undefined : authorityStart + authorityEnd
  );
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) {
    const closingBracket = hostPort.indexOf("]");
    return closingBracket < 0 ? null : hostPort.slice(1, closingBracket);
  }
  const portSeparator = hostPort.lastIndexOf(":");
  return portSeparator < 0 ? hostPort : hostPort.slice(0, portSeparator);
}

async function defaultResolver(host: string): Promise<string[]> {
  try {
    const records = await lookup(host, { all: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

/**
 * fetch() with SSRF-safe URL validation and manual redirect handling. Each
 * redirect target is re-validated before being followed.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  policy: EgressPolicy,
  resolver?: (host: string) => Promise<string[]>
): Promise<Response> {
  let current = await resolveSafeDestination(rawUrl, policy, resolver);
  let currentInit = { ...init };

  for (let redirect = 0; redirect <= policy.maxRedirects; redirect += 1) {
    const response = await pinnedRequest(current, currentInit);

    if (!isRedirect(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    const nextUrl = new URL(location, current.url);
    if (nextUrl.origin !== current.url.origin) {
      await response.body?.cancel().catch(() => {});
      throw new EgressError(
        "cross_origin_redirect",
        "Remote connector redirects must remain on the configured origin",
        403
      );
    }
    await response.body?.cancel().catch(() => {});
    current = await resolveSafeDestination(nextUrl.toString(), policy, resolver);

    const method = (currentInit.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const headers = new Headers(currentInit.headers);
      headers.delete("content-length");
      headers.delete("content-type");
      currentInit = { ...currentInit, method: "GET", body: undefined, headers };
    }
  }

  throw new EgressError(
    "too_many_redirects",
    `Exceeded ${policy.maxRedirects} redirects`,
    502
  );
}

async function pinnedRequest(
  destination: SafeDestination,
  init: RequestInit
): Promise<Response> {
  const { url, address } = destination;
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  const body = requestBody(init.body);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        agent: false,
        servername: url.protocol === "https:" && isIP(url.hostname) === 0
          ? url.hostname
          : undefined
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        const status = incoming.statusCode ?? 502;
        const bodyForbidden =
          init.method?.toUpperCase() === "HEAD" || status === 204 || status === 304;
        if (bodyForbidden) incoming.resume();
        const responseBody = bodyForbidden
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(
          new Response(responseBody, {
            status,
            statusText: incoming.statusMessage,
            headers: responseHeaders
          })
        );
      }
    );

    const abort = () => req.destroy(new DOMException("The operation was aborted", "AbortError"));
    if (init.signal?.aborted) {
      abort();
    } else {
      init.signal?.addEventListener("abort", abort, { once: true });
    }
    req.once("error", reject);
    req.once("close", () => init.signal?.removeEventListener("abort", abort));
    req.end(body);
  });
}

function requestBody(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof URLSearchParams) return body.toString();
  throw new EgressError(
    "unsupported_request_body",
    "Remote connector request body must be buffered",
    500
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
