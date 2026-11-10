-- The customer's own monthly bill, entered on the options page.
--
-- Most connectors cannot read billing (Vercel, AWS, GCP, Azure, Netlify,
-- Firebase and Cloudflare all return no cost), and the ones that can price the
-- inventory at published list rates rather than reading an invoice. Without
-- this column an unknown bill was compared as $0, so every target looked more
-- expensive and the report said to stay put. Null means the customer has not
-- said; it is never defaulted to zero.
ALTER TABLE "Assessment" ADD COLUMN "reportedMonthlySpendCents" INTEGER;
