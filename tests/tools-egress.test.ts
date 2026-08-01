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

  test("rejects non-canonical dotted-decimal IPv4", () => {
    expect(classifyIp("0177.0.0.1")).toContain("invalid IPv4");
    expect(classifyIp("001.002.003.004")).toContain("invalid IPv4");
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

  test("rejects credentials embedded in connector URLs", async () => {
    await expect(
      assertSafeUrl("https://user:secret@example.com/mcp", publicPolicy, resolvePublic)
    ).rejects.toMatchObject({ code: "embedded_credentials" });
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

  test("rejects ambiguous legacy IPv4 spellings", async () => {
    const ambiguous = [
      "0177.0.0.1", // octal octet
      "0x7f.0.0.1", // hexadecimal octet
      "127.1", // short form
      "2130706433", // single-integer form
      "127.0.0.1.", // trailing dot
      "001.002.003.004" // leading-zero octets
    ];

    for (const host of ambiguous) {
      await expect(
        assertSafeUrl(`https://${host}/mcp`, publicPolicy)
      ).rejects.toMatchObject({ code: "ambiguous_ip_literal" });
    }
  });

  test("retains a trailing dot on an ordinary DNS hostname", async () => {
    let resolvedHost = "";
    const url = await assertSafeUrl(
      "https://example.com./mcp",
      publicPolicy,
      async (host) => {
        resolvedHost = host;
        return ["93.184.216.34"];
      }
    );
    expect(url.hostname).toBe("example.com.");
    expect(resolvedHost).toBe("example.com.");
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
  test("rejects promptly when a pending request is aborted", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        await Bun.sleep(200);
        return new Response("too late");
      }
    });
    try {
      const policy: EgressPolicy = {
        allowInsecureHttp: true,
        allowPrivateHosts: true,
        maxRedirects: 0
      };
      const reason = new Error("deadline exceeded");
      const controller = new AbortController();
      setTimeout(() => controller.abort(reason), 10);

      await expect(safeFetch(
        `http://127.0.0.1:${server.port}/slow`,
        { signal: controller.signal },
        policy
      )).rejects.toBe(reason);
    } finally {
      server.stop(true);
    }
  });

  test("connects to the validated address without re-resolving DNS", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("pinned")
    });
    try {
      const policy: EgressPolicy = {
        allowInsecureHttp: true,
        allowPrivateHosts: true,
        maxRedirects: 5
      };
      const response = await safeFetch(
        `http://rebind.example:${server.port}/start`,
        {},
        policy,
        async () => ["127.0.0.1"]
      );
      expect(await response.text()).toBe("pinned");
    } finally {
      server.stop(true);
    }
  });

  test("rejects cross-origin redirects before forwarding credentials", async () => {
    let credentialSeen = false;
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        credentialSeen = request.headers.has("authorization");
        return new Response("unexpected");
      }
    });
    const origin = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${target.port}/steal` }
        });
      }
    });
    try {
      const policy: EgressPolicy = {
        allowInsecureHttp: true,
        allowPrivateHosts: true,
        maxRedirects: 5
      };
      await expect(
        safeFetch(
          `http://127.0.0.1:${origin.port}/start`,
          { headers: { authorization: "Bearer secret" } },
          policy
        )
      ).rejects.toMatchObject({ code: "cross_origin_redirect" });
      expect(credentialSeen).toBe(false);
    } finally {
      origin.stop(true);
      target.stop(true);
    }
  });
});
