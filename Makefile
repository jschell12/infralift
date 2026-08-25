FRAMEWORK_HOST ?= josh-schell@10.0.0.2
DASHBOARD_URL ?= https://api.infralift.dev

.PHONY: build-api build-dashboard build deploy-images deploy

build-api:
	docker build -t infralift-api:local -f apps/api/Dockerfile .

build-dashboard:
	docker build -t infralift-dashboard:local \
		--build-arg NEXT_PUBLIC_API_URL=$(DASHBOARD_URL) \
		-f apps/dashboard/Dockerfile .

build: build-api build-dashboard

deploy-images:
	docker save infralift-api:local | ssh $(FRAMEWORK_HOST) docker load
	docker save infralift-dashboard:local | ssh $(FRAMEWORK_HOST) docker load

deploy: build deploy-images
	@echo "Images deployed. Run: nomad job run nomad/jobs/infralift.nomad.hcl"
