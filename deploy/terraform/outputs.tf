output "api_base" {
  description = "Set this as the API_BASE repository variable for the GitHub Pages build."
  value       = "https://${local.api_host}"
}

output "static_ip" {
  value = aws_lightsail_static_ip.api.ip_address
}
