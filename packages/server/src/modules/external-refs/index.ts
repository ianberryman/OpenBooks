/**
 * `external_refs` — the correlation map from an integrator's own id to an
 * OpenBooks entity, unique both ways (OB-102; ROADMAP D-58; migration
 * `0010_platform`).
 *
 * D-04's idempotency generalized: a one-shot `Idempotency-Key` guards one
 * request, and this guards a *relationship* an integrator keeps re-asserting
 * over time — the seam D-33 named for the M7 QuickBooks import, opened now
 * because the shape does not depend on QuickBooks arriving to justify it. A
 * bulk importer that creates the same external ref every run needs the create
 * to be a no-op on every run after the first, and needs it caught rather than
 * silently ignored the one time the same external id is offered for a
 * different entity — see `createExternalRef` in `external-refs.service.ts` for
 * the exact three-way split that gives it.
 *
 * ## Surface
 *
 * | Operation                          | Permission            |
 * | ----------------------------------- | ---------------------- |
 * | `createExternalRef(input, ctx)`     | `integrations.write`  |
 * | `lookupExternalRef(query, ctx)`     | `integrations.read`   |
 * | `listExternalRefs(query, ctx)`      | `integrations.read`   |
 *
 * `(input, ctx)` / `(query, ctx)` and `ctx` as the source of the org follow the
 * rest of the service layer: spec §4 forbids an org as a loose parameter.
 *
 * No routes live here. OB-104 owns ids and the HTTP surface, exactly as
 * `dimensions/index.ts` and `api-keys/index.ts` say of their own transports.
 *
 * ## Why `entity_id` is not validated against `entity_type`
 *
 * `entity_type` names *which* OpenBooks table the ref points into, and only that
 * table's own service can say whether an id names a live row of it. Checking that
 * here would give this module an import edge to every subledger, every ledger
 * table, and every future entity type M7 adds — the exact coupling `0010_platform.ts`'s
 * migration comment says the schema chose not to take by leaving `entity_id`
 * unconstrained. This module is a correlation record, not a foreign key: the
 * integrator asserts the mapping, and it is reachable by two directions with no
 * ambiguity by construction (`uq_external_refs_external`, `uq_external_refs_entity`),
 * not by this module cross-checking every entity in the system.
 */

export type {
  CreateExternalRefRequest,
  ExternalRef,
  ExternalRefEntityType,
  ExternalRefPage,
  ExternalRefQuery,
} from '@openbooks/shared-types';
export { EXTERNAL_REF_ENTITY_TYPES } from '@openbooks/shared-types';

export { createExternalRef, listExternalRefs, lookupExternalRef } from './external-refs.service';
