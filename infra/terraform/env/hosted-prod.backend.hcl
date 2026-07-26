# Partial backend configuration for hosted-prod.
#
#   terraform init -reconfigure -backend-config=env/hosted-prod.backend.hcl
#
# PLACEHOLDER: `bucket`. Replace with the output of the state-backend root
# (`terraform -chdir=state-backend output -raw bucket`). It is left as an obvious
# placeholder rather than a plausible-looking name so a wrong value cannot be mistaken for a
# right one — S3 bucket names are global and there is no OpenBooks AWS account (D-05).

bucket = "REPLACE-ME-openbooks-tfstate"
key    = "hosted-prod/terraform.tfstate"
region = "us-east-1"

# S3-native locking (Terraform >= 1.10), which needs no DynamoDB table. If you are pinned to
# an older Terraform, drop this line and add:
#   dynamodb_table = "REPLACE-ME-openbooks-tfstate-locks"
# The state-backend root creates both so either works.
use_lockfile = true

encrypt = true
