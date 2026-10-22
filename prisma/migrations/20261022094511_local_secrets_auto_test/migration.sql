-- AlterEnum
ALTER TYPE "SecretProvider" ADD VALUE 'LOCAL';

-- AlterTable
ALTER TABLE "ApplicationSecret" ADD COLUMN     "encryptedValue" TEXT;

-- AlterTable
ALTER TABLE "DiscoveryRun" ADD COLUMN     "autoGenerate" BOOLEAN NOT NULL DEFAULT false;

-- LOCAL secrets are referenced as local://<id>; the ciphertext lives in encryptedValue.
-- Cast to text: a just-added enum value can't be used in the same transaction.
ALTER TABLE "ApplicationSecret" DROP CONSTRAINT "ApplicationSecret_reference_check";
ALTER TABLE "ApplicationSecret" ADD CONSTRAINT "ApplicationSecret_reference_check" CHECK (
  ("provider"::text = 'ENV' AND "reference" ~ '^env://[A-Z][A-Z0-9_]*$') OR
  ("provider"::text = 'VAULT' AND "reference" ~ '^vault://[A-Za-z0-9_./-]+#[A-Za-z0-9_.-]+$') OR
  ("provider"::text = 'AWS_SECRETS_MANAGER' AND "reference" ~ '^aws-sm://[A-Za-z0-9_+=.@/:-]+(#[A-Za-z0-9_.-]+)?$') OR
  ("provider"::text = 'GCP_SECRET_MANAGER' AND "reference" ~ '^gcp-sm://projects/[a-z0-9-]+/secrets/[A-Za-z0-9_-]+(/versions/(latest|[0-9]+))?$') OR
  ("provider"::text = 'AZURE_KEY_VAULT' AND "reference" ~ '^azure-kv://[a-z0-9-]+/[A-Za-z0-9-]+(/[0-9a-f]{32})?$') OR
  ("provider"::text = 'LOCAL' AND "reference" ~ '^local://[a-z0-9]+$' AND "encryptedValue" IS NOT NULL)
);
ALTER TABLE "ApplicationSecret" ADD CONSTRAINT "ApplicationSecret_encrypted_only_local_check" CHECK ("provider"::text = 'LOCAL' OR "encryptedValue" IS NULL);
