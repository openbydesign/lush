import { describe, expect, test } from "bun:test";

const workflowPaths = [
  ".github/workflows/release.yml",
  ".github/workflows/test.yml",
  ".github/workflows/publish-images.yml"
];

describe("workflow security invariants", () => {
  test("pins every external action to an immutable commit", async () => {
    for (const path of workflowPaths) {
      const workflow = await Bun.file(path).text();
      for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
        const target = match[1]!;
        if (target.startsWith("./")) {
          continue;
        }

        const separator = target.lastIndexOf("@");
        if (separator <= 0) {
          throw new Error(`${path}: ${target} has no ref`);
        }
        if (!/^[a-f0-9]{40}$/.test(target.slice(separator + 1))) {
          throw new Error(
            `${path}: ${target} must use a 40-character commit SHA`
          );
        }
      }
    }
  });

  test("normal CI and release validation both run database integration tests", async () => {
    for (const path of [
      ".github/workflows/test.yml",
      ".github/workflows/publish-images.yml"
    ]) {
      const workflow = await Bun.file(path).text();
      expect(workflow).toContain("LUSH_TEST_DATABASE_URL:");
      expect(workflow).toContain("image: postgres:17@sha256:");
      expect(workflow).toContain("bun test");
    }
  });

  test("Dependabot owns GitHub Action SHA updates", async () => {
    const config = await Bun.file(".github/dependabot.yml").text();
    expect(config).toContain("package-ecosystem: github-actions");
  });

  test("CI and release publication validate the static web distribution", async () => {
    const testWorkflow = await Bun.file(".github/workflows/test.yml").text();
    expect(testWorkflow).toContain("name: Build lush-web distribution");
    expect(testWorkflow).toContain("web-distribution.ts verify");

    const publishWorkflow = await Bun.file(
      ".github/workflows/publish-images.yml"
    ).text();
    expect(publishWorkflow).toContain("name: Build lush-web distribution");
    expect(publishWorkflow).toContain("subject-path:");
    expect(publishWorkflow).toContain(".tar.gz.sha256");
    expect(publishWorkflow).toContain("gh release upload");
    expect(publishWorkflow).toMatch(
      /publish:\n[\s\S]*?needs:\n\s+- prepare\n\s+- web-distribution/
    );
  });

  test("release publication stages every artifact before locking the release", async () => {
    const releaseConfig = JSON.parse(
      await Bun.file("release-please-config.json").text()
    ) as Record<string, unknown>;
    expect(releaseConfig.draft).toBe(true);
    expect(releaseConfig["force-tag-creation"]).toBe(true);

    const publishWorkflow = await Bun.file(
      ".github/workflows/publish-images.yml"
    ).text();
    expect(publishWorkflow).toMatch(
      /finalize:\n[\s\S]*?needs:\n\s+- prepare\n\s+- web-distribution\n\s+- publish/
    );
    expect(publishWorkflow).toContain(
      'gh release edit "$RELEASE_REF" --repo "$REPOSITORY" --draft=false'
    );
  });

  test("release verification pins the tagged commit and documents minimum PAT access", async () => {
    const releases = await Bun.file("docs/releases.md").text();
    expect(releases).toContain('--source-digest "$source_digest"');
    expect(releases).not.toContain('--source-ref "refs/tags/v$version"');
    expect(releases).toContain("Contents and Pull requests write access");
    expect(releases).toContain("can remain\ndisabled");
    expect(releases).not.toContain("Issues, and Pull requests write access");
  });

  test("static distribution docs preserve the topology-neutral web contract", async () => {
    const deployment = await Bun.file("docs/deployment.md").text();
    expect(deployment).toContain("it never proxies API traffic");
    expect(deployment).not.toContain("same-origin API proxy");
  });

  test("manual publication and release workflow permissions preserve provenance", async () => {
    const publishWorkflow = await Bun.file(
      ".github/workflows/publish-images.yml"
    ).text();
    expect(publishWorkflow).toContain(
      '"$GITHUB_EVENT_NAME" == "workflow_dispatch" && "$GITHUB_SHA" != "$tag_commit"'
    );
    expect(publishWorkflow).toContain(
      "images: ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}"
    );
    expect(publishWorkflow).toContain(
      "subject-name: ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}"
    );
    expect(publishWorkflow).not.toContain("ghcr.io/lush-agents/");

    for (const path of [
      "deploy/self-host/compose.yml",
      "docs/deployment.md",
      "docs/releases.md",
      "services/docs/content/docs/setup/self-hosting.mdx"
    ]) {
      expect(await Bun.file(path).text()).not.toContain("ghcr.io/lush-agents/");
    }

    const releaseWorkflow = await Bun.file(".github/workflows/release.yml").text();
    expect(releaseWorkflow).toMatch(/^permissions:\n  contents: read\n\njobs:/m);
    expect(releaseWorkflow).not.toContain("issues: write");
    expect(releaseWorkflow).not.toContain("pull-requests: write");

    const releases = await Bun.file("docs/releases.md").text();
    expect(releases).toContain(
      "gh workflow run publish-images.yml --ref v0.1.0 -f ref=v0.1.0"
    );
  });
});
