variable "min_name_length" {
  type    = number
  default = 2
}

locals {
  email_pattern = "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$"
}

output "email_regex" {
  value = local.email_pattern
}
