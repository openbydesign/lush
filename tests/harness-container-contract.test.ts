import { describe, expect, test } from "bun:test";

describe("managed-agent harness container contract", () => {
  test("ships a provider-neutral Lush harness entrypoint", async () => {
    const dockerfile = await Bun.file("containers/harness/Dockerfile").text();
    expect(dockerfile).toContain("Lush Agent Harness");
    expect(dockerfile).toContain("/opt/lush/services");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["bun", "run", "/opt/lush/services/agent/src/harness/harness-host.ts"]'
    );
    expect(dockerfile.toLowerCase()).not.toContain("cloudflare");
  });

  test("publishes the harness as an immutable release image", async () => {
    const workflow = await Bun.file(".github/workflows/publish-images.yml").text();
    expect(workflow).toContain("image: lush-harness");
    expect(workflow).toContain("dockerfile: containers/harness/Dockerfile");
    expect(workflow).not.toContain("image: lush-sandbox");
  });
});
