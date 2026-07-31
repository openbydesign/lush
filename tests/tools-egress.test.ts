import { describe, expect, test } from "bun:test";
import {
  assertSafeUrl,
  classifyIp,
  EgressError,
  safeFetch,
  type EgressPolicy
} from "../services/tools/src/net/egress";

const publicPolicy: EgressPolicy = {
  allowInsecureHttp: false,
  allowPrivateHosts: false,
  maxRedirects: 5
};

describe("classifyIp", () => {
  test("blocks loopback, private, link-local, and metadata ranges", () => {
    expect(classifyIp("127.0.0.1")).toContain("loopback");
    expect(classifyIp("10.1.2.3")).toContain("private");
    expect(classifyIp("172.16.0.1")).toContain("private");
    expect(classifyIp("172.31.255.255")).toContain("private");
    expect(classifyIp("192.168.1.1")).toContain("private");
    expect(classifyIp("169.254.169.254")).toContain("metadata");
    expect(classifyIp("0.0.0.0")).toContain("unspecified");
    expect(classifyIp("100.64.0.1")).toContain("NAT");
  });

  test("allows routable public IPv4 addresses", () => {
    expect(classifyIp("8.8.8.8")).toBeNull();
    expect(classifyIp("1.1.1.1")).toBeNull();
    expect(classifyIp("172.32.0.1")).toBeNull();
  });

  test("classifies IPv6 loopback, ULA, and link-local", () => {
    expect(classifyIp("::1")).toContain("loopback");
    expect(classifyIp("fc00::1")).toContain("unique-local");
    expect(classifyIp("fe80::1")).toContain("link-local");
    expect(classifyIp("::ffff:127.0.0.1")).toContain("loopback");
    expect(classifyIp("2606:4700:4700::1111")).toBeNull();
  });

  test("catches fully-expanded and hex-mapped IPv6 forms", () => {
    // Fully-expanded loopback.
    expect(classifyIp("0:0:0:0:0:0:0:1")).toContain("loopback");
    // IPv4-mapped in hex-hextet form (::ffff:7f00:1 == 127.0.0.1).
    expect(classifyIp("::ffff:7f00:1")).toContain("loopback");
    expect(classifyIp("0:0:0:0:0:ffff:7f00:1")).toContain("loopback");
    // IPv4-mapped private in hex form (::ffff:a00:1 == 10.0.0.1).
    expect(classifyIp("::ffff:a00:1")).toContain("private");
    // NAT64 well-known prefix.
    expect(classifyIp("64:ff9b::1")).toContain("NAT64");
    // Zone id is stripped before classification.
    expect(classifyIp("fe80::1%eth0")).toContain("link-local");
    // A genuinely public v6 address still passes.
    expect(classifyIp("2001:4860:4860::8888")).toBeNull();
  });

  test("blocks benchmarking and reserved/broadcast IPv4 ranges", () => {
    expect(classifyIp("198.18.0.1")).toContain("benchmarking");
    expect(classifyIp("192.88.99.1")).toContain("6to4");
    expect(classifyIp("255.255.255.255")).not.toBeNull();
  });
});

describe("assertSafeUrl", () => {
  const resolvePublic = async () => ["93.184.216.34"];

  test("rejects non-http(s) schemes", async () => {
    await expect(
      assertSafeUrl("ftp://example.com", publicPolicy, resolvePublic)
    ).rejects.toBeInstanceOf(EgressError);
  });

  test("rejects http when insecure is disallowed", async () => {
    await expect(
      assertSafeUrl("http://example.com", publicPolicy, resolvePublic)
    ).rejects.toMatchObject({ code: "insecure_scheme" });
  });

  test("rejects hosts that resolve to a private address (DNS rebinding)", async () => {
    await expect(
      assertSafeUrl(
        "https://internal.example.com",
        publicPolicy,
        async () => ["10.0.0.5"]
      )
    ).rejects.toMatchObject({ code: "blocked_destination" });
  });

  test("rejects an IP-literal loopback URL", async () => {
    await expect(
      assertSafeUrl("https://127.0.0.1:8080/mcp", publicPolicy)
    ).rejects.toMatchObject({ code: "blocked_destination" });
  });

  test("accepts a public https URL", async () => {
    const url = await assertSafeUrl(
      "https://example.com/mcp",
      publicPolicy,
      resolvePublic
    );
    expect(url.hostname).toBe("example.com");
  });

  test("allows private hosts when the policy opts in", async () => {
    const url = await assertSafeUrl(
      "http://127.0.0.1:9000/mcp",
      { allowInsecureHttp: true, allowPrivateHosts: true, maxRedirects: 5 }
    );
    expect(url.port).toBe("9000");
  });
});

describe("safeFetch", () => {
  test("re-validates redirect targets and blocks private redirects", async () => {
    // A real server redirecting to an internal address must be caught even
    // though the initial destination was public.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" }
        });
      }
    });
    try {
      const policy: EgressPolicy = {
        allowInsecureHttp: true,
        allowPrivateHosts: false,
        maxRedirects: 5
      };
      // Permit the loopback origin but not the metadata redirect target.
      await expect(
        safeFetch(
          `http://127.0.0.1:${server.port}/start`,
          {},
          policy,
          async (host) => (host === "127.0.0.1" ? ["8.8.8.8"] : [host])
        )
      ).rejects.toMatchObject({ code: "blocked_destination" });
    } finally {
      server.stop(true);
    }
  });
});
