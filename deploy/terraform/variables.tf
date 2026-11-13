variable "region" {
  type    = string
  default = "eu-west-2" # London
}

variable "name" {
  type    = string
  default = "climate-indices-poc"
}

variable "bundle_id" {
  description = "Lightsail plan. small_3_0 = 2 GB RAM, 2 vCPU, 60 GB disk, 12 USD per month."
  type        = string
  default     = "small_3_0"
}

variable "repo_url" {
  type    = string
  default = "https://github.com/Nolski/climate-indices-poc.git"
}

variable "git_ref" {
  description = "Branch or tag the server builds and runs."
  type        = string
  default     = "main"
}

variable "cors_origins" {
  description = "Exact origins allowed to call the API (the GitHub Pages site)."
  type        = string
  default     = "https://nolski.github.io"
}

variable "api_hostname" {
  description = "Optional own hostname for the API. Empty = <static-ip>.sslip.io."
  type        = string
  default     = ""
}

variable "admin_cidrs" {
  description = "Extra addresses allowed to reach SSH, for example [\"198.51.100.4/32\"]."
  type        = list(string)
  default     = []
}

variable "max_datasets" {
  type    = number
  default = 20
}

variable "max_upload_mb" {
  description = "An 80-year station file is about 0.7 MB."
  type        = number
  default     = 2
}

variable "container_memory" {
  type    = string
  default = "1400m"
}

variable "alert_email" {
  description = "Address for the monthly cost alert. Empty = no budget is created. Pass it with TF_VAR_alert_email; do not commit it."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  type    = number
  default = 20
}
