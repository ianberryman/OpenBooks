data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

locals {
  ecr_repository_url = var.manage_ecr_repository ? one(aws_ecr_repository.server[*].repository_url) : one(data.aws_ecr_repository.server[*].repository_url)
  ecr_repository_arn = var.manage_ecr_repository ? one(aws_ecr_repository.server[*].arn) : one(data.aws_ecr_repository.server[*].arn)

  # One image reference, used by all four task definitions. Spec §2.5: the api, worker,
  # migrate and (in the data module) bootstrap roles are the same bytes; only OPENBOOKS_ROLE
  # differs. If this ever becomes more than one expression, §2.5 has been broken.
  image = "${local.ecr_repository_url}:${var.image_tag}"

  log_group_prefix = "/openbooks/${var.environment}"
}

resource "aws_ecr_repository" "server" {
  count = var.manage_ecr_repository ? 1 : 0

  name = var.ecr_repository_name

  # A tag that can be moved makes "which code is running" unanswerable after the fact,
  # and every deployed task definition here pins a tag. CI must therefore push a unique
  # tag per build (the commit SHA) rather than re-pointing `develop`.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  # AES256, deliberately not the per-environment CMK. This repository is intentionally NOT
  # environment-prefixed so an image can be promoted from staging to production by digest;
  # encrypting it with one environment's key would require the other environment's execution
  # roles to hold kms:Decrypt on it, coupling the two key policies to enable an image pull.
  # The contents are the AGPL server build, not a secret.
  encryption_configuration {
    encryption_type = "AES256"
  }
}

data "aws_ecr_repository" "server" {
  count = var.manage_ecr_repository ? 0 : 1

  name = var.ecr_repository_name
}

resource "aws_ecr_lifecycle_policy" "server" {
  count = var.manage_ecr_repository ? 1 : 0

  repository = aws_ecr_repository.server[0].name

  # Rule order matters: ECR evaluates ascending by rulePriority and an image matched by an
  # earlier rule is not considered by later ones. Untagged images are cleared first so the
  # tagged-image count is not consumed by build intermediates.
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.ecr_untagged_expiry_days
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Retain a rollback window of tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.ecr_tagged_image_count
        }
        action = { type = "expire" }
      },
    ]
  })
}
