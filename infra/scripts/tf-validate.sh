#!/usr/bin/env bash
#
# Format and validation gate for the Terraform tree. Requires no AWS credentials — that is
# the point, and it is the ceiling of what can be checked (D-05: nothing here has ever been
# applied, so `plan` is not available; see infra/terraform/README.md).
#
# Intended to run in CI (OB-027) as a non-blocking job until credentials exist, and blocking
# afterwards.
#
#   infra/scripts/tf-validate.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tf_dir="${repo_root}/infra/terraform"

if ! command -v terraform >/dev/null 2>&1; then
  echo "terraform is not installed. See infra/terraform/README.md for the pinned version." >&2
  exit 127
fi

echo "==> terraform fmt -recursive -check"
terraform -chdir="${tf_dir}" fmt -recursive -check

# Only the two ROOTS are validated as roots.
#
# The five modules under modules/ are not independently validatable and should not be: a
# reusable module declares no provider configuration, and modules/edge goes further and
# declares a `configuration_aliases` entry for aws.us_east_1 (CloudFront requires a
# us-east-1 ACM certificate). Validating it standalone fails with "Provider configuration
# not present", which is correct behaviour, not a defect. `terraform validate` on the root
# validates every module it composes, so the modules are covered here.
for root in "." "state-backend"; do
  echo "==> ${root}: init -backend=false"
  terraform -chdir="${tf_dir}/${root}" init -backend=false -input=false >/dev/null

  echo "==> ${root}: validate"
  terraform -chdir="${tf_dir}/${root}" validate
done

echo
echo "OK: fmt clean, both roots valid."
echo "NOTE: this proves the configuration is syntactically and semantically well-formed."
echo "      It does not prove it applies. See the 'This has never been applied' section of"
echo "      infra/terraform/README.md."
