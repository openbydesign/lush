import { describe, expect, test } from "bun:test";

describe("managed sandbox container contract", () => {
  test("pins a matching Cloudflare Sandbox runtime and ships the Lush harness", async () => {
    const dockerfile = await Bun.file("containers/sandbox/Dockerfile").text();
    expect(dockerfile).toContain(
      "FROM docker.io/cloudflare/sandbox:0.12.4@sha256:e83bb4d6d9748b93a4b876ce0852b5e93d8e0893da10c59d425770aef0d73738"
    );
    expect(dockerfile).toContain("/opt/lush/services");
    expect(dockerfile).not.toMatch(/^ENTRYPOINT/m);
  });

  test("publishes the sandbox as an immutable release image", async () => {
    const workflow = await Bun.file(".github/workflows/publish-images.yml").text();
    expect(workflow).toContain("image: lush-sandbox");
    expect(workflow).toContain("dockerfile: containers/sandbox/Dockerfile");
    expect(workflow).toContain("platforms: ${{ matrix.platforms }}");
  });
});
