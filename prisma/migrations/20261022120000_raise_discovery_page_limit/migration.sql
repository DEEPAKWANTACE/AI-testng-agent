-- "Test the whole application" crawls need more than 500 pages.
ALTER TABLE "DiscoveryRun" DROP CONSTRAINT "DiscoveryRun_max_pages_check";
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_max_pages_check" CHECK ("maxPages" BETWEEN 1 AND 1000);
