import { afterEach, describe, expect, it } from "vitest";
import { resolveSecret, secretAvailability } from "@/modules/secrets/resolver";
import { secretReferenceInputSchema } from "@/modules/secrets/schemas";

describe("secret reference input", () => {
  it.each([
    ["env://QA_STOREFRONT_PASSWORD", "ENV"],
    ["vault://kv/qa/storefront#password", "VAULT"],
    ["aws-sm://qa/storefront#password", "AWS_SECRETS_MANAGER"],
    ["aws-sm://arn:aws:secretsmanager:eu-west-1:123456789012:secret:qa-AbCdEf", "AWS_SECRETS_MANAGER"],
    ["gcp-sm://projects/acme-qa/secrets/storefront-password/versions/latest", "GCP_SECRET_MANAGER"],
    ["azure-kv://acme-qa-vault/storefront-password", "AZURE_KEY_VAULT"],
  ])("accepts %s and infers %s", (reference, provider) => {
    expect(secretReferenceInputSchema.parse({ name: "TEST_PASSWORD", reference })).toEqual({
      name: "TEST_PASSWORD",
      reference,
      provider,
      description: null,
    });
  });

  it.each([
    ["hunter2", "never the secret value"],
    ["P@ssw0rd!2024", "never the secret value"],
    ["https://vault.example.com/secret", "never the secret value"],
    ["env://DATABASE_URL", "Invalid env:// reference"],
    ["env://qa_lowercase", "Invalid env:// reference"],
    ["vault://kv/qa/storefront", "Invalid vault:// reference"],
    ["gcp-sm://my-secret", "Invalid gcp-sm:// reference"],
  ])("rejects %s", (reference, message) => {
    const result = secretReferenceInputSchema.safeParse({ name: "TEST_PASSWORD", reference });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["reference"] });
    expect(result.error?.issues[0].message).toContain(message);
  });

  it.each(["test_password", "1PASSWORD", "TEST-PASSWORD", "", "A".repeat(65)])("rejects name %s", (name) => {
    expect(secretReferenceInputSchema.safeParse({ name, reference: "env://QA_X" }).success).toBe(false);
  });
});

describe("secret resolution", () => {
  afterEach(() => {
    delete process.env.QA_UNIT_SECRET;
  });

  it("resolves QA_ environment references at use time", async () => {
    process.env.QA_UNIT_SECRET = "value-from-env";
    await expect(resolveSecret("env://QA_UNIT_SECRET")).resolves.toBe("value-from-env");
    expect(secretAvailability("env://QA_UNIT_SECRET")).toBe("available");
  });

  it("reports missing values without revealing anything", async () => {
    await expect(resolveSecret("env://QA_UNIT_SECRET")).rejects.toThrow("not set");
    expect(secretAvailability("env://QA_UNIT_SECRET")).toBe("missing");
  });

  it("never resolves the server's own configuration", async () => {
    process.env.DATABASE_URL ??= "postgresql://example";
    await expect(resolveSecret("env://DATABASE_URL")).rejects.toThrow("QA_-prefixed");
    expect(secretAvailability("env://DATABASE_URL")).toBe("missing");
  });

  it("treats other providers as external until a client is configured", async () => {
    expect(secretAvailability("vault://kv/qa#password")).toBe("external");
    await expect(resolveSecret("vault://kv/qa#password")).rejects.toThrow("not configured");
  });
});

describe("secret reference errors", () => {
  it("reports an invalid reference even when the name is also invalid", () => {
    const result = secretReferenceInputSchema.safeParse({ name: "", reference: "hunter2" });
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual(["name", "reference"]);
  });
});
