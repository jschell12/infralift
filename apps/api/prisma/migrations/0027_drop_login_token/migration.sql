-- LoginToken backed a magic-link stub (routes/auth.ts) that was never mounted:
-- sign-in is Cloudflare Access (lib/cf-auth.ts), and the stub would have
-- returned a login link in the response body. Nothing reads or writes the
-- table. Dropping it drops its unique index and its foreign key to User.
DROP TABLE "LoginToken";
