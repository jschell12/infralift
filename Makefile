FRAMEWORK_HOST ?= josh-schell@10.0.0.2

.PHONY: build-api build-dashboard build-admin build deploy-images deploy

build-api:
	docker build --platform linux/amd64 -t infralift-api:local -f apps/api/Dockerfile .

build-dashboard:
	docker build --platform linux/amd64 -t infralift-dashboard:local \
		-f apps/dashboard/Dockerfile .

build-admin:
	docker build --platform linux/amd64 -t infralift-admin:local \
		-f apps/admin/Dockerfile .

build: build-api build-dashboard build-admin

deploy-images:
	docker save infralift-api:local | ssh $(FRAMEWORK_HOST) docker load
	docker save infralift-dashboard:local | ssh $(FRAMEWORK_HOST) docker load
	docker save infralift-admin:local | ssh $(FRAMEWORK_HOST) docker load

deploy: build deploy-images
	@echo "Images deployed. Run: nomad job run nomad/jobs/infralift.nomad.hcl"
