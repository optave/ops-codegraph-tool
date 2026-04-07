variable "storage_type" {
  type    = string
  default = "memory"
}

resource "null_resource" "repository" {
  triggers = {
    storage = var.storage_type
  }
}

output "name" {
  value = "user_repository"
}
