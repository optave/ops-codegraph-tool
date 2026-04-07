module "user_service" {
  source = "./service"

  repository_name = module.repository.name
  validators      = module.validators
}

module "repository" {
  source = "./repository"

  storage_type = var.storage_type
}

module "validators" {
  source = "./validators"

  min_name_length = 2
}

variable "storage_type" {
  type    = string
  default = "memory"
}

output "service_endpoint" {
  value = module.user_service.endpoint
}
