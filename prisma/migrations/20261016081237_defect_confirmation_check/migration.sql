-- A defect can only be CONFIRMED (or NOT_CONFIRMED) by a recorded human verification.
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_verification_recorded"
  CHECK ("verification" = 'REPRODUCED' OR "verifiedAt" IS NOT NULL);
