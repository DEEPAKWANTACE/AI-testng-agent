-- NO ACTION (checked at the end of the statement) instead of RESTRICT (checked immediately),
-- so deleting an application can cascade to its secrets and its discovery login together,
-- while deleting a secret still in use by discovery login is refused.

-- DropForeignKey
ALTER TABLE "DiscoveryAuthConfig" DROP CONSTRAINT "DiscoveryAuthConfig_passwordSecretId_fkey";

-- DropForeignKey
ALTER TABLE "DiscoveryAuthConfig" DROP CONSTRAINT "DiscoveryAuthConfig_usernameSecretId_fkey";

-- AddForeignKey
ALTER TABLE "DiscoveryAuthConfig" ADD CONSTRAINT "DiscoveryAuthConfig_usernameSecretId_fkey" FOREIGN KEY ("usernameSecretId") REFERENCES "ApplicationSecret"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryAuthConfig" ADD CONSTRAINT "DiscoveryAuthConfig_passwordSecretId_fkey" FOREIGN KEY ("passwordSecretId") REFERENCES "ApplicationSecret"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

