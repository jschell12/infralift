# API address the dashboard and admin proxy /api to. Baked in at build time;
# the deploy sets it to the production API.
API_BACKEND_URL ?= http://localhost:4000

.PHONY: build-api build-dashboard build-admin build

build-api:
	docker build --platform linux/amd64 -t infralift-api:local -f apps/api/Dockerfile .

build-dashboard:
	docker build --platform linux/amd64 -t infralift-dashboard:local \
		--build-arg API_BACKEND_URL=$(API_BACKEND_URL) -f apps/dashboard/Dockerfile .

build-admin:
	docker build --platform linux/amd64 -t infralift-admin:local \
		--build-arg API_BACKEND_URL=$(API_BACKEND_URL) -f apps/admin/Dockerfile .

build: build-api build-dashboard build-admin

# The end-to-end suite against a local stack: Postgres, moto (AWS), a GitHub
# fake, Prism (Cloudflare) and OpenTofu. No cloud account, no spend. Needs
# Docker. See README, "Testing without cloud accounts".
.PHONY: e2e
e2e:
	bash scripts/e2e.sh
