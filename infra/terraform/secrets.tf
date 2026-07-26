# Session signing key for the opaque session tokens in OB-015. Lives in the root rather
# than in a module because it is neither a data-tier nor a compute-tier concern — it is
# application configuration that outlives any single service.
#
# Like the database passwords, this value is in Terraform state in cleartext; see the
# note at the top of modules/data/secrets.tf, which applies verbatim.
#
# GUESS: OB-003 owns the environment schema and has not landed. The container env var
# name (SESSION_SECRET) and the fact that a single symmetric secret is what OB-015 wants
# are both assumptions. If OB-015 uses a keyring for rotation, this becomes a JSON secret
# and the change is confined to this file and modules/compute/tasks.tf.
resource "random_password" "session_secret" {
  length  = 64
  special = false # base62 only: this value is carried in shell env vars and log-scrubbing config

  keepers = {
    rotation = "1"
  }
}

resource "aws_secretsmanager_secret" "session" {
  name                    = "${local.name_prefix}/app/session-secret"
  description             = "Session token signing key (OB-015)."
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 14
}

resource "aws_secretsmanager_secret_version" "session" {
  secret_id     = aws_secretsmanager_secret.session.id
  secret_string = random_password.session_secret.result
}
