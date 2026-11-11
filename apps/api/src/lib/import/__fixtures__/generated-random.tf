# __generated__ by Terraform
# Please review these resources and move them into your main configuration files.

# __generated__ by Terraform from "abc123"
resource "random_string" "suffix" {
  keepers          = null
  length           = 6
  lower            = true
  min_lower        = 0
  min_numeric      = 0
  min_special      = 0
  min_upper        = 0
  numeric          = true
  override_special = null
  special          = true
  upper            = true
}

# __generated__ by Terraform from "hunter2-literal-value"
resource "random_password" "db" {
  keepers          = null
  length           = 21
  lower            = true
  min_lower        = 0
  min_numeric      = 0
  min_special      = 0
  min_upper        = 0
  numeric          = true
  override_special = null
  special          = true
  upper            = true
}
