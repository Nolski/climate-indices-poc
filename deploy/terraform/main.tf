# Demo hosting for the API: one small Lightsail instance behind Caddy (automatic HTTPS).
# The static front end is published separately on GitHub Pages and calls this API.
# Cost at November 2026 list prices: 12 USD per month (2 GB, 2 vCPU, 60 GB disk, 3 TB transfer).

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
}

locals {
  # A hostname that resolves to the instance without touching anyone's DNS:
  # 203.0.113.7 -> 203-0-113-7.sslip.io. Caddy obtains a certificate for it.
  api_host = var.api_hostname != "" ? var.api_hostname : "${replace(aws_lightsail_static_ip.api.ip_address, ".", "-")}.sslip.io"
}

resource "aws_lightsail_static_ip" "api" {
  name = "${var.name}-ip"
}

resource "aws_lightsail_instance" "api" {
  name              = var.name
  availability_zone = "${var.region}a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = var.bundle_id
  user_data = templatefile("${path.module}/../user-data.sh.tftpl", {
    api_host      = local.api_host
    repo_url      = var.repo_url
    git_ref       = var.git_ref
    cors_origins  = var.cors_origins
    max_datasets  = var.max_datasets
    max_upload_mb = var.max_upload_mb
    memory_limit  = var.container_memory
  })
  tags = { project = "climate-indices-poc", purpose = "demo" }
}

resource "aws_lightsail_static_ip_attachment" "api" {
  static_ip_name = aws_lightsail_static_ip.api.name
  instance_name  = aws_lightsail_instance.api.name

  # A replaced instance keeps its name, so without this the address would stay detached.
  lifecycle {
    replace_triggered_by = [aws_lightsail_instance.api]
  }
}

resource "aws_lightsail_instance_public_ports" "api" {
  instance_name = aws_lightsail_instance.api.name

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
  }
  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
  }
  # SSH only from the Lightsail browser console, plus any admin addresses given explicitly.
  port_info {
    protocol          = "tcp"
    from_port         = 22
    to_port           = 22
    cidrs             = var.admin_cidrs
    cidr_list_aliases = ["lightsail-connect"]
  }
}

# Cost guard: an email when Lightsail spending passes 80 % of the monthly budget, or is
# forecast to exceed it. Scoped to Lightsail so other workloads in the account do not trigger it.
resource "aws_budgets_budget" "demo" {
  count        = var.alert_email != "" ? 1 : 0
  name         = "${var.name}-lightsail-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Service"
    values = ["Amazon Lightsail"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
