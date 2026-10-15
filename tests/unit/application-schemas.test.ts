import { describe, expect, it } from "vitest";
import { applicationInputSchema, authorizedUrlSchema, branchSchema, repoUrlSchema } from "@/modules/applications/schemas";
import { isWithinAuthorizedUrl } from "@/modules/applications/authorized-url";

const errorFor = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  result.success ? null : result.error!.issues[0].message;

describe("authorized URL", () => {
  it.each([
    ["https://staging.example.com", "https://staging.example.com"],
    ["https://staging.example.com/", "https://staging.example.com"],
    ["  HTTPS://Staging.Example.com/app/  ", "https://staging.example.com/app"],
    ["http://localhost:3000", "http://localhost:3000"],
  ])("accepts and normalises %s", (input, expected) => {
    expect(authorizedUrlSchema.parse(input)).toBe(expected);
  });

  it.each([
    ["", "required"],
    ["staging.example.com", "full URL"],
    ["ftp://example.com", "http or https"],
    ["javascript:alert(1)", "http or https"],
    ["https://user:pass@example.com", "credentials"],
    ["https://token@example.com", "credentials"],
    ["https://example.com/?env=prod", "query string"],
    ["https://example.com/#top", "fragment"],
  ])("rejects %s", (input, message) => {
    expect(errorFor(authorizedUrlSchema.safeParse(input))).toContain(message);
  });
});

describe("repository URL", () => {
  it.each([
    ["https://github.com/acme/web", "https://github.com/acme/web"],
    ["https://github.com/acme/web.git/", "https://github.com/acme/web.git"],
    ["https://gitlab.example.com/group/sub/web", "https://gitlab.example.com/group/sub/web"],
    ["git@github.com:acme/web.git", "git@github.com:acme/web.git"],
    ["ssh://git@github.com/acme/web.git", "ssh://git@github.com/acme/web.git"],
    ["", null],
  ])("accepts %s", (input, expected) => {
    expect(repoUrlSchema.parse(input)).toBe(expected);
  });

  it.each([
    ["http://github.com/acme/web", "plain http"],
    ["https://ghp_secret@github.com/acme/web", "credentials"],
    ["https://user:token@github.com/acme/web", "credentials"],
    ["ssh://root@github.com/acme/web", "git user"],
    ["https://github.com/acme", "point at a repository"],
    ["file:///etc/passwd", "https://host"],
    ["git@github.com:/etc/passwd", "https://host"],
  ])("rejects %s", (input, message) => {
    expect(errorFor(repoUrlSchema.safeParse(input))).toContain(message);
  });
});

describe("branch name", () => {
  it.each(["main", "release/2.4", "feature/JIRA-123_fix", "v1.2.3"])("accepts %s", (name) => {
    expect(branchSchema.parse(name)).toBe(name);
  });

  it.each(["-rf", "/main", "main/", "a..b", "a//b", "feat/.hidden", "name.lock", "has space", "semi;colon", "$(whoami)", "x".repeat(256)])(
    "rejects %s",
    (name) => {
      expect(branchSchema.safeParse(name).success).toBe(false);
    },
  );
});

describe("application input", () => {
  const valid = {
    projectId: "cjld2cjxh0000qzrmn831i7rn",
    name: "  Storefront ",
    authorizedUrl: "https://staging.example.com/",
    environment: "STAGING",
  };

  it("parses a minimal application and defaults the optional fields", () => {
    expect(applicationInputSchema.parse(valid)).toEqual({
      projectId: valid.projectId,
      name: "Storefront",
      authorizedUrl: "https://staging.example.com",
      environment: "STAGING",
      type: "WEB",
      description: null,
      repoUrl: null,
      repoBranch: null,
    });
  });

  it("requires a repository when a branch is given", () => {
    const result = applicationInputSchema.safeParse({ ...valid, repoBranch: "main" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["repoBranch"], message: "Add a repository URL to set a branch" });
    expect(applicationInputSchema.safeParse({ ...valid, repoUrl: "https://github.com/a/b", repoBranch: "main" }).success).toBe(true);
  });

  it("rejects unknown environments and missing fields", () => {
    const result = applicationInputSchema.safeParse({ ...valid, environment: "QA", name: "" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual(["environment", "name"]);
  });
});

describe("authorized URL scope", () => {
  it.each([
    ["https://app.example.com/login", "https://app.example.com", true],
    ["https://app.example.com/shop", "https://app.example.com/shop", true],
    ["https://app.example.com/shop/cart", "https://app.example.com/shop", true],
    ["https://app.example.com/shopping", "https://app.example.com/shop", false],
    ["https://evil.example.com/", "https://app.example.com", false],
    ["http://app.example.com/", "https://app.example.com", false],
    ["https://app.example.com:8443/", "https://app.example.com", false],
    ["https://u:p@app.example.com/", "https://app.example.com", false],
    ["not a url", "https://app.example.com", false],
  ])("%s within %s → %s", (url, scope, expected) => {
    expect(isWithinAuthorizedUrl(url, scope)).toBe(expected);
  });
});
