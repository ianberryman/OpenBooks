import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  contactPageSchema,
  contactSchema,
  createContactRequestSchema,
  pageCursorSchema,
  updateContactRequestSchema,
} from '@openbooks/shared-types';
import type { Contact, ContactPage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  createContact,
  deactivateContact,
  deleteContact,
  getContact,
  listContacts,
  reactivateContact,
  updateContact,
} from '../../modules/contacts';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  requireOrgScope,
} from './support';

/**
 * `/v1/contacts` — customers and vendors, as one collection (OB-036; spec §2.1).
 *
 * The surface is `/v1/accounts`'s, deliberately: create, read, list, patch, the two
 * activation routes, and a delete that only an unreferenced row may take. Two
 * resources that behave the same way should not read differently, and every one of
 * the arguments `accounts.ts` makes for that shape — deactivation is an operation
 * rather than a flag in a patch, reactivation has to exist or deactivation is a
 * one-way door — applies here unchanged.
 *
 * One thing that is *not* the same, and it is the one to know: a contact's `code`
 * is mutable, so it appears in the patch body. `updateContactRequestSchema` carries
 * the argument, which is about accounts rather than about codes — a posted line
 * names a contact by row, so renumbering a customer restates nothing, and a contact
 * the ledger names can never be deleted and recreated the way a mistyped account
 * can.
 */

const TAG = 'contacts';

const contactParamsSchema = z.strictObject({ contactId: z.uuid() });

/**
 * Local and carrying no `id`, like the accounts and journals list queries: a
 * querystring is emitted as individual `parameters`, so a component for the object
 * would be referenced by nothing. The coercions are here because this is the only
 * layer that knows the values arrived as text — `listContactsQuerySchema` in
 * `@openbooks/shared-types` takes real booleans, because a shared schema that
 * accepted `'false'` would accept it from a JSON body too.
 */
const listContactsWireQuerySchema = z.strictObject({
  isCustomer: z.stringbool().optional().meta({
    description: 'Accepts `true`/`false` (and `1`/`0`, `yes`/`no`, `on`/`off`).',
  }),
  isVendor: z.stringbool().optional().meta({
    description: 'Independent of `isCustomer`: a contact that is both matches either filter.',
  }),
  isActive: z.stringbool().optional().meta({
    description: 'Omitted matches active and inactive contacts alike.',
  }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX)
    .default(PAGE_SIZE_DEFAULT)
    .meta({
      description:
        'How many contacts to return, at most. Over the maximum is refused rather than clamped, ' +
        'so a short page always means the list is short.',
    }),
  cursor: pageCursorSchema.optional(),
});

export function registerContactRoutes(app: App): void {
  app.post(
    '/v1/contacts',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createContact',
        summary: 'Create a contact',
        description:
          'Contacts are created active. Only `displayName` is required: `isCustomer` and ' +
          '`isVendor` both default to false, because a party named on a journal line need take ' +
          'part in no subledger at all — an employee expense reimbursement being the ordinary ' +
          'case.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createContactRequestSchema,
        response: { 201: contactSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createContact', request: request.body, successStatus: 201 },
        () => createContact(request.body, ctx),
      );

      const contact = idempotentBody<Contact>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/contacts/${contact.id}`)
        .send(contact);
    },
  );

  app.get(
    '/v1/contacts',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listContacts',
        summary: 'List contacts',
        description:
          'One page, oldest first by creation. Deliberately not alphabetical: `displayName` is ' +
          'the field most likely to be edited, and a keyset cursor over a mutable column drops ' +
          'the rows that moved behind it (ROADMAP D-21). A screen that wants the list by name ' +
          'sorts what it holds.',
        tags: [TAG],
        querystring: listContactsWireQuerySchema,
        response: { 200: contactPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ContactPage> => {
      const { isCustomer, isVendor, isActive, limit, cursor } = request.query;
      return listContacts(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(isCustomer === undefined ? {} : { isCustomer }),
          ...(isVendor === undefined ? {} : { isVendor }),
          ...(isActive === undefined ? {} : { isActive }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/contacts/:contactId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getContact',
        summary: 'One contact',
        tags: [TAG],
        params: contactParamsSchema,
        response: { 200: contactSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Contact> => getContact(request.params.contactId, getContext()),
  );

  app.patch(
    '/v1/contacts/:contactId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateContact',
        summary: 'Update a contact',
        description:
          'An absent field is unchanged and an explicit `null` clears it. `code` may be changed ' +
          'here, unlike an account’s: a posted line references a contact by row, so renumbering ' +
          'a customer restates nothing, and codes usually arrive from the system the org ' +
          'migrated off.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: contactParamsSchema,
        body: updateContactRequestSchema,
        response: { 200: contactSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { contactId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateContact',
          request: { contactId, patch: request.body },
          successStatus: 200,
        },
        () => updateContact(contactId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Contact>(result));
    },
  );

  /** Registered from a table for the reason `accounts.ts` gives: they differ in one word. */
  for (const route of [
    {
      path: '/v1/contacts/:contactId/deactivate',
      operationId: 'deactivateContact',
      summary: 'Deactivate a contact',
      description:
        'Takes a contact out of circulation without removing it from the books, which is the ' +
        'only removal available to a contact the ledger names. A deactivated contact may not be ' +
        'named on a new entry (`contact_inactive`), though a reversal of an old one is exempt. ' +
        'Idempotent: an already-inactive contact is returned unchanged.',
      run: deactivateContact,
    },
    {
      path: '/v1/contacts/:contactId/reactivate',
      operationId: 'reactivateContact',
      summary: 'Reactivate a contact',
      description: 'The counterpart, so that deactivation is not a one-way door.',
      run: reactivateContact,
    },
  ] as const) {
    app.post(
      route.path,
      {
        onRequest: ORG_SCOPED_WRITE_HOOKS,
        schema: {
          operationId: route.operationId,
          summary: route.summary,
          description: route.description,
          tags: [TAG],
          headers: idempotencyKeyHeaderSchema,
          params: contactParamsSchema,
          response: { 200: contactSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const ctx = getContext();
        const { contactId } = request.params;
        const result = await withIdempotency(
          { endpoint: route.operationId, request: { contactId }, successStatus: 200 },
          () => route.run(contactId, ctx),
        );

        return reply.status(result.status).send(idempotentBody<Contact>(result));
      },
    );
  }

  app.delete(
    '/v1/contacts/:contactId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deleteContact',
        summary: 'Delete a contact nothing references',
        description:
          'A contact is a directory row rather than a record of what happened, so deleting an ' +
          'unreferenced one restates nothing — and refusing would leave every mistyped and ' +
          'double-entered row in the picker forever. A contact named by a posted line answers ' +
          '`precondition_failed` with `contact_has_postings`, and one named by a draft with ' +
          '`contact_on_draft`: a posting is permanent and a draft is a form in progress, so the ' +
          'two are told apart rather than lumped together. Deactivate the first; edit the second.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: contactParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { contactId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deleteContact', request: { contactId }, successStatus: 204 },
        () => deleteContact(contactId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );
}
