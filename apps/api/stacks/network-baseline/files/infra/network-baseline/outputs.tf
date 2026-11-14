output "vpc_id" {
  value = module.vpc.vpc_id
}

output "vpc_cidr" {
  value = module.vpc.vpc_cidr
}

output "public_subnet_ids" {
  value = module.vpc.public_subnet_ids
}

output "private_subnet_ids" {
  value = module.vpc.private_subnet_ids
}

# The same list as one string, in the form the postgres-with-backups stack's
# subnet_ids setting takes.
output "private_subnet_ids_csv" {
  value = join(",", module.vpc.private_subnet_ids)
}

output "nat_public_ips" {
  value = module.vpc.nat_public_ips
}

output "flow_log_group" {
  value = module.flow_logs.log_group_name
}
