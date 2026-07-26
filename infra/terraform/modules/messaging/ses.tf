data "aws_region" "current" {}

# EMAIL_PROVIDER=ses selects the adapter; self-host sets smtp.
#
# NOT AUTOMATABLE HERE: a new SES identity starts in the sandbox — 200 messages a day, and
# recipients must themselves be verified. Leaving the sandbox is a support request against
# the account, so the first apply produces a correctly configured identity that cannot
# yet email a customer. Called out again in the README.

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.root_domain

  # Easy DKIM. BYODKIM would let Terraform hold the private key, which means the signing
  # key in state alongside everything else — worse than letting SES generate and hold it.
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# A custom MAIL FROM domain is what makes SPF *align* under DMARC rather than merely
# pass. Without it the envelope domain is amazonses.com, SPF alignment fails, and DMARC
# then rests on DKIM alone.
resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity = aws_sesv2_email_identity.domain.email_identity

  mail_from_domain = "${var.mail_from_subdomain}.${var.root_domain}"

  # RejectMessage, not UseDefaultValue: if the MAIL FROM records are wrong, silently
  # falling back to amazonses.com would break alignment invisibly. Failing the send is the
  # signal that the DNS is broken.
  behavior_on_mx_failure = "REJECT_MESSAGE"
}

resource "aws_route53_record" "dkim" {
  count = 3

  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.root_domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = var.route53_zone_id
  name    = "${var.mail_from_subdomain}.${var.root_domain}"
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${data.aws_region.current.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = var.route53_zone_id
  name    = "${var.mail_from_subdomain}.${var.root_domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

# Published at the apex. If the zone already has a DMARC record this resource will
# conflict on the first apply — see the README's "not managed here".
resource "aws_route53_record" "dmarc" {
  zone_id = var.route53_zone_id
  name    = "_dmarc.${var.root_domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=${var.dmarc_policy}; rua=mailto:dmarc-reports@${var.root_domain}; fo=1"]
}

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = var.name_prefix

  delivery_options {
    # REQUIRE, not OPTIONAL. Invoices and statements are not worth downgrading to
    # cleartext because a receiving MTA cannot negotiate STARTTLS.
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    # Account-level suppression for both, so a hard bounce or complaint is never retried.
    # Repeatedly mailing a dead address is how a sending domain loses its reputation.
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}
