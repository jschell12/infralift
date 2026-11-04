# YOURS. infralift never rewrites this file.
#
# Any key set in `overrides` replaces the UI's choice in main.tf, e.g.
#   overrides = { server_type = "cx33", backup_retention_days = 90 }
#
# Resources you add below sit beside the generated ones and can read the
# module's outputs (module.app.*).

locals {
  overrides = {}

  extra_labels = {}
}
