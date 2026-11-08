# 0005. Rules live in services; failures are typed errors

**Status:** accepted, 2026-11-08

## Decision

Route handlers only validate input, call one service function and send its result. Rules (what is allowed, in what order, for which org) live in `apps/api/src/services/`. A service that refuses throws a typed error from `lib/errors.ts`; `handle()` and the app's `errorHandler` turn it into the response.

## Why

The code should be maintainable by a person without AI help. When routes queried the database, decided what was allowed and built every error response by hand, a rule could only be found by knowing which route used it, and the same refusal was written slightly differently in each place.

## Cost

One more layer to follow from a URL to its logic. `routes/workspaces.ts` still keeps its logic in the route, and status codes are fixed per error class, so a new status means a new class.
