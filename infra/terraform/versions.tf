# Versions are pinned, and .terraform.lock.hcl is committed (see .gitignore — it
# excludes .terraform/ and state, deliberately not the lockfile), so every reviewer
# and every CI run resolves the same provider builds.
terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
