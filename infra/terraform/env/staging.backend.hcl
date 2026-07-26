# Partial backend configuration for staging. See hosted-prod.backend.hcl for the placeholder
# note; the only difference is the state key.
#
#   terraform init -reconfigure -backend-config=env/staging.backend.hcl

bucket = "REPLACE-ME-openbooks-tfstate"
key    = "staging/terraform.tfstate"
region = "us-east-1"

use_lockfile = true

encrypt = true
