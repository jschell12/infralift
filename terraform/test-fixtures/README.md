# Connector Test Fixtures

Minimal Terraform configs that provision the smallest possible resources on each
provider, giving the infralift connectors real API targets to assess.

## Usage

Each subdirectory is independent. `cd` into one, set the required env vars, then:

```bash
terraform init
terraform apply
# ... run connector tests ...
terraform destroy
```

## Cost

Every config targets free-tier or trial-credit resources. Nothing here should
cost money if destroyed promptly. See per-provider notes for details.

## Providers without Terraform

- **Render**: use `render.yaml` Blueprint or dashboard. Free static site is enough.
- **Railway**: create a project + starter service via dashboard. $5 trial credit.
