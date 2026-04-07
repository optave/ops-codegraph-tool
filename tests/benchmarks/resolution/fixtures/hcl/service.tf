variable "repository_name" {
  type = string
}

variable "validators" {
  type = any
}

resource "null_resource" "user_service" {
  triggers = {
    repo = var.repository_name
  }
}

output "endpoint" {
  value = "http://localhost:8080"
}
