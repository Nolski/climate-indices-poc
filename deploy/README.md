# Demo hosting

The public demonstration runs in two parts:

- **The page** is the static `web/` folder, published on GitHub Pages by
  `.github/workflows/pages.yml` (see `docs/pages-hosting.md`).
- **The calculations** run in the container on one small AWS Lightsail instance, defined here
  with Terraform. Caddy sits in front of it and obtains the HTTPS certificate automatically.

If the server is not reachable, the page falls back to a labelled demonstration that uses saved
results for the sample station.

## What Terraform creates

| Resource | Notes |
|---|---|
| Lightsail instance, 2 GB / 2 vCPU, Ubuntu 24.04 | 12 USD per month at November 2026 list prices |
| Static IP, attached | free while attached |
| Firewall | 80 and 443 open; 22 only from the Lightsail browser console |
| Budget alert (optional) | email at 80 % of 20 USD per month of Lightsail spend |

On first boot `user-data.sh.tftpl` installs podman and Caddy, clones this repository, builds the
image and starts it as a systemd service: read-only root, no capabilities, memory capped,
bound to localhost. Demo limits (2 MB uploads, 20 datasets, 30 minutes retention, 60 requests
per minute per client) are set by environment variables in `/opt/climpoc/env`.

## Use

```bash
cd deploy/terraform
terraform init
terraform apply          # prints api_base
```

Set the printed `api_base` as the `API_BASE` repository variable so the Pages build points at
the server. To deploy a newer commit, run `sudo climpoc-deploy` on the instance.
`terraform destroy` removes everything.

## Limits of this setup

One instance, one process, no redundancy, data held in memory only. It is sized for a
demonstration. A production deployment would put the same container on ECS Fargate behind a
load balancer, with a job queue for gridded data; that is not built here.
