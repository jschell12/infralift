# infralift inventory collectors

Two scripts that read your hosting account and write a JSON file. You run them.
Nothing is sent anywhere.

They exist because "give us a read-only API token" is a bigger ask than it
sounds, and security teams are right to push back on it. A Vercel token is
account-wide. A Heroku key with `read` scope can fetch config vars, which are
your secrets in plaintext. "We only read what we need" is a promise about our
behaviour, and a promise is not something a reviewer can verify.

This is the version you can verify.

## Running them

Node 18 or newer. No install step, no dependencies.

```bash
# Vercel
VERCEL_TOKEN=... node vercel.mjs --out vercel-inventory.json

# Heroku
HEROKU_API_KEY=... node heroku.mjs --out heroku-inventory.json
```

Then read the file, and upload it if you want an assessment. If you do not, you
have still got a useful inventory of your own stack and we never learn you ran
it.

```bash
node vercel.mjs --dry-run    # the exact API calls it would make, makes none
node heroku.mjs --fields     # every field it captures
```

## For whoever reviews this

Four claims, each checkable against the source in a few minutes.

**It transmits nothing.** Every request goes through a single function
(`vfetch` in `vercel.mjs`, `hFetch` in `heroku.mjs`) whose base URL is a
hard-coded constant. Grep for `fetch(` and you will find those two functions
and nothing else. There is no telemetry, no version check, no crash reporter,
no callback. Output goes to stdout or the `--out` path.

**It captures a fixed list of fields.** Neither script ever writes a raw API
response. Field selection is a function of explicit assignments (`pickProject`,
`pickApp`, `pickAddon`), so adding a field requires editing that function and
shows up in a diff. `--fields` prints the list.

This matters concretely on Vercel: `GET /v9/projects` returns an `env` array
where each entry has a `value`. Vercel encrypts those, so they arrive as
ciphertext rather than plaintext, but a collector that dumped the response
would still drop about a kilobyte of opaque data per environment variable into
a file you are about to send someone. These scripts record `envVarCount`, a
number, and never touch the array. On a real account that is the difference
between a 10.5 KB raw response and a 1.0 KB snapshot.

**It never reads Heroku config vars.** `/apps/{id}/config-vars` returns your
config values in plaintext and a `read` scoped key can reach it. It is not in
`ENDPOINTS`, and since `hFetch` is the only function that makes a request, the
endpoint list is the complete story. `node heroku.mjs --dry-run` prints both
what is called and what is deliberately not.

**It has no dependencies.** Nothing to `npm install`, nothing transitive to
audit, no build step. What you read is what runs.

### The complete request surface

| Script | Calls | Never calls |
|---|---|---|
| `vercel.mjs` | `GET /v9/projects?limit=100`<br>`GET /v5/domains?limit=100` | anything under `/v9/projects/{id}/env` |
| `heroku.mjs` | `GET /apps`<br>`GET /apps/{id}/formation`<br>`GET /apps/{id}/addons` | `GET /apps/{id}/config-vars` |

This table is enforced, not documented: `bundle-parity.test.ts` in the API
records every URL the collectors request and fails if the set changes.

### About the token

The token is read from an environment variable, used only for the
`Authorization` header on the calls above, and never written to the output.
It stays on your machine. You can revoke it the moment the script finishes:

```bash
heroku authorizations:create -d "infralift inventory"   # then revoke by id
```

## What we do with the file

The snapshot is only an inventory. The cost model, the target sizing, and the
generated Terraform are not in these scripts and are not derivable from the
output. Uploading a snapshot gets you the same assessment a token would have,
because the server runs the same analyzers over the same data either way, which
is checked by a test rather than asserted here.

One honest difference: an assessment built from a snapshot is marked as
self-reported and stamped with the collection time, because we did not observe
your account ourselves and the file could be weeks old. Token-based assessments
also re-run on their own as your stack changes; a snapshot is a photograph, so
re-running means running the script again.

## Layout

| File | |
|---|---|
| `vercel.mjs` | Vercel collector, runnable and importable |
| `heroku.mjs` | Heroku collector |
| `*.d.mts` | Types for the API, which imports these same files |

The API imports `collect()` from these scripts rather than reimplementing the
calls, so there is exactly one collector per provider. A token-based assessment
and an uploaded snapshot cannot describe the same account differently, because
the same code read it.

This package has no dependencies and no imports from the rest of the repo, so
it can be published as-is.
