# Partial backend configuration: no bucket, key, region or lock table here.
#
# Deliberate, per the ticket and D-05 — this stack has never been applied and no AWS
# account exists for it. Hardwiring a bucket name would make `terraform init` fail for
# anyone reviewing the code, and would bake one organisation's account into the repo.
# Supply the rest at init time:
#
#   terraform init -backend-config=env/hosted-prod.backend.hcl
#
# `terraform init -backend=false` skips the backend entirely and is what `validate`
# runs on, in CI and locally.
#
# `use_lockfile` is S3-native locking (Terraform >= 1.10 / AWS provider >= 5.79),
# which replaces the DynamoDB lock table. It is set in the per-environment
# backend.hcl rather than here so an operator on an older Terraform can fall back to
# `dynamodb_table` without editing tracked code. state-backend/ creates both, so
# either mechanism works.
terraform {
  backend "s3" {}
}
