-- The connectors' flat savings guess.
--
-- Every row here was the bill minus a $20 VPS (or $200 for two demo
-- fixtures), whatever the workload, and the dashboard home and projects list
-- showed it while the options page showed a sized, net-of-ops figure for the
-- same account. Savings are now computed on read from the same comparison the
-- options page makes (services/assessments.ts), so nothing reads or writes
-- this column, and keeping it would only invite someone to.
ALTER TABLE "Assessment" DROP COLUMN "estimatedMonthlySavingsCents";
