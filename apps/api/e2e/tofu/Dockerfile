# OpenTofu for the e2e stack: the binary from OpenTofu's own minimal image,
# on Alpine with the tools the import check's shell steps use (bash, jq).
# The version matches what opentofu/setup-opentofu@v1 installs in a
# customer's CI today; bump both together.
FROM ghcr.io/opentofu/opentofu:1.12.6-minimal AS tofu

FROM alpine:3.22
RUN apk add --no-cache bash jq ca-certificates
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
ENTRYPOINT []
