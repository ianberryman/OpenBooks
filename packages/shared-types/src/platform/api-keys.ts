import { z } from 'zod';

/**
 * API-key management (OB-097; ROADMAP D-55, D-61) — the `api_keys` table M1 seeded and left
 * unused until OB-099 wires authentication to it.
 *
 * A key is first-party and role-bound, never a person (D-55): it authenticates as an org
 * and a **role** with no user behind it, for an operator's own scripts and server-to-server
 * jobs. That is `roleId` below, not `userId` — the API-key/OAuth boundary in one field.
 *
 * `.meta({ id })` throughout (OB-104): `/v1/api-keys` gives every one of these shapes a
 * route, so each becomes a named `components.schemas` entry the generated client (OB-024)
 * types against.
 */

const API_KEY_NAME_MAX_LENGTH = 120;

export const createApiKeyRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(API_KEY_NAME_MAX_LENGTH).meta({
      description: 'Display name for the key, e.g. `Nightly import job`.',
    }),
    roleId: z.uuid().meta({
      description:
        'The role the key authenticates as (D-55). Not the issuer’s own role — a key’s ' +
        'effective permissions are exactly this role’s, and narrowing the role narrows every ' +
        'key issued against it, the same guarantee D-54 gives an OAuth token.',
    }),
  })
  .meta({
    id: 'CreateApiKeyRequest',
    description: 'Issues a first-party, role-bound key (D-55) — no person behind it.',
  });

export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

/**
 * An API key as the API returns it — never carrying the key value itself. See
 * `apiKeyWithSecretSchema` for the one response that does.
 */
export const apiKeySchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    roleId: z.uuid(),
    keyPrefix: z.string().meta({
      description:
        'The non-secret prefix of the opaque key, shown so an operator can tell keys apart ' +
        'without holding the secret (D-61). The rest is a SHA-256 hash, never returned.',
    }),
    createdByUserId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso
      .datetime()
      .nullable()
      .meta({
        description:
          'Set once a key is revoked. Revocation is instant and effective on the next request ' +
          '(D-61) — there is no blocklist to propagate, because the key is an opaque lookup, ' +
          'not a self-validating token.',
      }),
  })
  .meta({
    id: 'ApiKey',
    description: 'A first-party, role-bound API key (D-55, D-61), never carrying its secret.',
  });

export type ApiKey = z.infer<typeof apiKeySchema>;

/**
 * Returned once, at creation — the only response that ever carries the full opaque key.
 * After this, only `keyPrefix` is ever shown again, the same discipline a password reset
 * or an OAuth client secret follows.
 */
export const apiKeyWithSecretSchema = z
  .strictObject({
    ...apiKeySchema.shape,
    key: z.string().meta({
      description: 'The full opaque key. Not recoverable — losing it means issuing a new one.',
    }),
  })
  .meta({
    id: 'ApiKeyWithSecret',
    description: 'An API key with its full opaque value, returned exactly once at creation (D-61).',
  });

export type ApiKeyWithSecret = z.infer<typeof apiKeyWithSecretSchema>;

/**
 * Local and inline rather than through `pageSchema` — `oauthClientPageSchema`'s
 * reasoning applied here too.
 */
export const apiKeyPageSchema = z
  .strictObject({
    items: z.array(apiKeySchema),
    nextCursor: z.string().nullable(),
  })
  .meta({
    id: 'ApiKeyPage',
    description: 'One page of the org’s API keys, revoked ones included.',
  });

export type ApiKeyPage = z.infer<typeof apiKeyPageSchema>;
