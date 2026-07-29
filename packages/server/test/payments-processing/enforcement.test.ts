import { describe, expect, it } from 'vitest';

import { uuidToBuffer } from '../../src/db';

import {
  accountBalance,
  automationCtxFor,
  chargeEvent,
  connectFakeProcessor,
  deliverFakeWebhook,
  disputeEvent,
  invoiceIn,
  journalByMemo,
  journalById,
  linesOfJournal,
  paymentJournalIdByReference,
  paymentsCount,
  processorEventsCount,
  recordEvent,
  refundEvent,
  sceneIn,
  usePayProcessingApp,
} from './support';

/**
 * J5's signature refusal, D-06/spec-§6 actor provenance on every processor-driven
 * write, and the exact posting sides D-82/D-84/D-104 name — the enforcement half of
 * OB-152, split from `idempotency.property.test.ts` because these are boundary
 * checks rather than properties over a generated stream.
 *
 * The sides checks read `journal_lines` directly rather than only a net account
 * balance, which is the CLAUDE.md-flagged gap: a permuted debit/credit on a
 * two-line journal is net-zero-preserving and would still pass a balance-only
 * check (the reversal-permutation lesson). Reading the lines themselves is what a
 * side-swap actually fails.
 */
const harness = usePayProcessingApp();
const db = harness.db;

describe('J5: signature enforcement', () => {
  it('rejects a well-formed but wrong x-fake-signature, and posts nothing', async () => {
    const app = harness.app();
    const scene = await sceneIn(db);
    const { connection, webhookSecret } = await connectFakeProcessor(scene);
    const invoice = await invoiceIn(scene, 10_000n);

    const event = chargeEvent({
      invoiceId: invoice.id,
      externalObjectId: 'ch_bad_sig',
      externalEventId: 'evt_bad_sig',
      grossMinor: '10000',
    });

    // A real HMAC shape (64 hex chars — the same length a genuine SHA-256 digest
    // has) so this exercises the actual byte comparison in `fake.ts`, not merely
    // `timingSafeEqual`'s length guard.
    const response = await deliverFakeWebhook(app, connection.id, webhookSecret, event, {
      signatureOverride: 'a'.repeat(64),
    });

    expect(response.statusCode).toBe(400);
    expect(await paymentsCount(db.app, scene.orgId)).toBe(0);
    // The signature fails before a `processor_events` row is ever written
    // (`handleProcessorWebhook` verifies before `recordNormalizedEvent` is called).
    expect(await processorEventsCount(db.app, scene.orgId)).toBe(0);
  });

  it('rejects a request with no signature header at all', async () => {
    const app = harness.app();
    const scene = await sceneIn(db);
    const { connection } = await connectFakeProcessor(scene);
    const invoice = await invoiceIn(scene, 10_000n);

    const event = chargeEvent({
      invoiceId: invoice.id,
      externalObjectId: 'ch_no_sig',
      externalEventId: 'evt_no_sig',
      grossMinor: '10000',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/public/processing/${connection.id}/webhook`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(event),
    });

    expect(response.statusCode).toBe(400);
    expect(await paymentsCount(db.app, scene.orgId)).toBe(0);
  });

  it('an unknown connection id is a 404, not a signature failure', async () => {
    const app = harness.app();

    const event = chargeEvent({
      invoiceId: null,
      externalObjectId: 'ch_unknown_conn',
      externalEventId: 'evt_unknown_conn',
      grossMinor: '10000',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/public/processing/f47ac10b-58cc-4372-a567-0e02b2c3d479/webhook',
      headers: { 'content-type': 'application/json', 'x-fake-signature': 'a'.repeat(64) },
      payload: JSON.stringify(event),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('provenance: every processor-driven write is automation, never interactive', () => {
  it('a charge with a fee: the settle journal and the fee journal both carry actor_type=automation and NULL invocation_mode', async () => {
    const scene = await sceneIn(db);
    const { connection } = await connectFakeProcessor(scene);
    const invoice = await invoiceIn(scene, 50_000n);
    const ctx = automationCtxFor(scene, connection.id);

    const result = await recordEvent(
      ctx,
      connection.id,
      'fake',
      chargeEvent({
        invoiceId: invoice.id,
        externalObjectId: 'ch_prov',
        externalEventId: 'evt_prov_charge',
        grossMinor: '50000',
        feeMinor: '1500',
      }),
    );
    expect(result.status).toBe('processed');

    const settleJournalId = await paymentJournalIdByReference(db.app, scene.orgId, 'ch_prov');
    const settleJournal = await journalById(db.app, settleJournalId);
    expect(settleJournal.actor_type).toBe('automation');
    expect(settleJournal.actor_id).toEqual(uuidToBuffer(connection.id));
    expect(settleJournal.invocation_mode).toBeNull();

    const feeJournal = await journalByMemo(db.app, scene.orgId, 'processor fee ch_prov');
    expect(feeJournal.actor_type).toBe('automation');
    expect(feeJournal.actor_id).toEqual(uuidToBuffer(connection.id));
    expect(feeJournal.invocation_mode).toBeNull();
  });

  it('a refund: the journal carries actor_type=automation', async () => {
    const scene = await sceneIn(db);
    const { connection } = await connectFakeProcessor(scene);
    const ctx = automationCtxFor(scene, connection.id);

    const result = await recordEvent(
      ctx,
      connection.id,
      'fake',
      refundEvent({
        invoiceId: null,
        externalObjectId: 'rf_prov',
        externalEventId: 'evt_prov_refund',
        grossMinor: '2000',
      }),
    );
    expect(result.status).toBe('processed');

    const journal = await journalByMemo(db.app, scene.orgId, 'processor refund rf_prov');
    expect(journal.actor_type).toBe('automation');
    expect(journal.actor_id).toEqual(uuidToBuffer(connection.id));
    expect(journal.invocation_mode).toBeNull();
  });

  it('a chargeback: the journal carries actor_type=automation', async () => {
    const scene = await sceneIn(db);
    const { connection } = await connectFakeProcessor(scene);
    const ctx = automationCtxFor(scene, connection.id);

    const result = await recordEvent(
      ctx,
      connection.id,
      'fake',
      disputeEvent({
        externalObjectId: 'cb_prov',
        externalEventId: 'evt_prov_dispute',
        grossMinor: '1000',
      }),
    );
    expect(result.status).toBe('processed');

    const journal = await journalByMemo(db.app, scene.orgId, 'processor chargeback cb_prov');
    expect(journal.actor_type).toBe('automation');
    expect(journal.actor_id).toEqual(uuidToBuffer(connection.id));
    expect(journal.invocation_mode).toBeNull();
  });
});

describe('sides (mutation-resistant): a permuted debit/credit is caught by the lines themselves, not only a net balance', () => {
  it('a charge with a fee: DR clearing / CR AR by the gross, and DR fee / CR clearing by the fee — as two separate journals', async () => {
    const scene = await sceneIn(db);
    const { connection } = await connectFakeProcessor(scene);
    const invoice = await invoiceIn(scene, 40_000n);
    const ctx = automationCtxFor(scene, connection.id);

    await recordEvent(
      ctx,
      connection.id,
      'fake',
      chargeEvent({
        invoiceId: invoice.id,
        externalObjectId: 'ch_sides',
        externalEventId: 'evt_sides_charge',
        grossMinor: '40000',
        feeMinor: '1200',
      }),
    );

    const settleJournalId = await paymentJournalIdByReference(db.app, scene.orgId, 'ch_sides');
    const settleLines = await linesOfJournal(db.app, settleJournalId);
    expect(settleLines).toEqual([
      { account_id: scene.clearing.id, debit_minor: 40_000n, credit_minor: 0n },
      { account_id: scene.receivable.id, debit_minor: 0n, credit_minor: 40_000n },
    ]);

    const feeJournal = await journalByMemo(db.app, scene.orgId, 'processor fee ch_sides');
    const feeLines = await linesOfJournal(db.app, feeJournal.id);
    expect(feeLines).toEqual([
      { account_id: scene.fee.id, debit_minor: 1_200n, credit_minor: 0n },
      { account_id: scene.clearing.id, debit_minor: 0n, credit_minor: 1_200n },
    ]);

    // The net balances agree too — belt and braces, not a substitute for the lines
    // above (a permuted side is net-zero-preserving on a two-line journal and would
    // not move either of these).
    expect(await accountBalance(db.app, scene.fee.id)).toBe(1_200n);
    expect(await accountBalance(db.app, scene.clearing.id)).toBe(40_000n - 1_200n);
  });

  it('a refund: DR AR / CR clearing by the gross — the mirror of a charge, never the same side twice', async () => {
    const scene = await sceneIn(db);
    const { connection } = await connectFakeProcessor(scene);
    const ctx = automationCtxFor(scene, connection.id);

    await recordEvent(
      ctx,
      connection.id,
      'fake',
      refundEvent({
        invoiceId: null,
        externalObjectId: 'rf_sides',
        externalEventId: 'evt_sides_refund',
        grossMinor: '3000',
      }),
    );

    const journal = await journalByMemo(db.app, scene.orgId, 'processor refund rf_sides');
    const lines = await linesOfJournal(db.app, journal.id);
    expect(lines).toEqual([
      { account_id: scene.receivable.id, debit_minor: 3_000n, credit_minor: 0n },
      { account_id: scene.clearing.id, debit_minor: 0n, credit_minor: 3_000n },
    ]);
  });

  it('a chargeback: DR fee (loss bucket) / CR clearing by the gross', async () => {
    const scene = await sceneIn(db);
    const { connection } = await connectFakeProcessor(scene);
    const ctx = automationCtxFor(scene, connection.id);

    await recordEvent(
      ctx,
      connection.id,
      'fake',
      disputeEvent({
        externalObjectId: 'cb_sides',
        externalEventId: 'evt_sides_dispute',
        grossMinor: '900',
      }),
    );

    const journal = await journalByMemo(db.app, scene.orgId, 'processor chargeback cb_sides');
    const lines = await linesOfJournal(db.app, journal.id);
    expect(lines).toEqual([
      { account_id: scene.fee.id, debit_minor: 900n, credit_minor: 0n },
      { account_id: scene.clearing.id, debit_minor: 0n, credit_minor: 900n },
    ]);
  });
});
