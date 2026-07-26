import type { OperationContext } from '@openbooks/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  ContextUnavailableError,
  createRequestContext,
  deriveContext,
  getContext,
  hasContext,
  runInContext,
  runInDerivedContext,
  tryGetContext,
} from '../../src/context/index';
import type { RequestContext } from '../../src/context/index';
import { toWireError } from '../../src/errors/index';

const context = (orgId: string): RequestContext =>
  createRequestContext({
    requestId: `req-${orgId}`,
    orgId,
    userId: `user-${orgId}`,
    roleId: 'role-owner',
    actorType: 'user',
    actorId: `user-${orgId}`,
    invocationMode: 'interactive',
  });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('createRequestContext', () => {
  it('satisfies the plugin-api OperationContext contract', () => {
    // Compile-time half of the assertion; the runtime keys below are the rest.
    const operation: OperationContext = context('org-a');
    expect(Object.keys(operation).sort()).toEqual([
      'actorId',
      'actorType',
      'idempotencyKey',
      'invocationMode',
      'orgId',
      'requestId',
      'roleId',
      'userId',
    ]);
  });

  it('generates a requestId and defaults the nullable fields to null', () => {
    const ctx = createRequestContext({
      orgId: 'org-a',
      roleId: 'role-owner',
      actorType: 'automation',
      actorId: 'automation-7',
    });

    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(ctx.userId).toBeNull();
    expect(ctx.idempotencyKey).toBeNull();
  });

  it('omits invocationMode entirely when unrecorded rather than defaulting it', () => {
    const ctx = createRequestContext({
      orgId: 'org-a',
      roleId: 'role-owner',
      actorType: 'agent',
      actorId: 'agent-session-1',
    });

    expect('invocationMode' in ctx).toBe(false);
  });

  it('is frozen, so scope cannot be changed by writing to it', () => {
    const ctx = context('org-a');
    expect(() => {
      (ctx as { orgId: string }).orgId = 'org-b';
    }).toThrow(TypeError);
    expect(ctx.orgId).toBe('org-a');
  });
});

describe('reading context outside a scope', () => {
  it('throws rather than returning undefined', () => {
    expect(() => getContext()).toThrow(ContextUnavailableError);
  });

  it('names the operation and maps to an internal error, not a client error', () => {
    let thrown: unknown;
    try {
      getContext('postJournal');
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContextUnavailableError);
    expect((thrown as Error).message).toContain('postJournal');
    expect(toWireError(thrown)).toEqual({
      code: 'internal_error',
      status: 500,
      message: 'An internal error occurred.',
    });
  });

  it('reports absence through the non-throwing reads', () => {
    expect(tryGetContext()).toBeUndefined();
    expect(hasContext()).toBe(false);
  });

  it('refuses to derive a context with no parent to derive from', () => {
    expect(() => deriveContext({ orgId: 'org-a' })).toThrow(ContextUnavailableError);
  });
});

describe('isolation across concurrent async operations', () => {
  /**
   * The property that makes AsyncLocalStorage safe to hold `orgId` in, and the
   * reason two sequential calls would prove nothing: several operations are in
   * flight at once, each suspending repeatedly, and each must continue to see its
   * own org across every resumption.
   *
   * The interleaving is asserted rather than assumed — a test that happened to run
   * the operations to completion one at a time would pass without exercising
   * anything.
   */
  it('keeps each operation on its own org while they interleave', async () => {
    const orgs = ['org-a', 'org-b', 'org-c', 'org-d'];
    const resumptionOrder: string[] = [];

    const operation = async (orgId: string): Promise<readonly string[]> => {
      const observed: string[] = [];
      for (let step = 0; step < 6; step += 1) {
        // Varying delays, plus a microtask hop, so the resumptions do not line up
        // into per-operation blocks.
        await delay(1 + ((step * 3 + orgId.length) % 4));
        await Promise.resolve();
        resumptionOrder.push(orgId);
        observed.push(getContext().orgId);
      }
      return observed;
    };

    const results = await Promise.all(
      orgs.map((orgId) => runInContext(context(orgId), () => operation(orgId))),
    );

    for (const [index, orgId] of orgs.entries()) {
      expect(results[index]).toEqual(Array.from({ length: 6 }, () => orgId));
    }

    const switches = resumptionOrder.filter(
      (orgId, index) => index > 0 && resumptionOrder[index - 1] !== orgId,
    ).length;
    expect(switches).toBeGreaterThan(orgs.length);
  });

  it('does not leak a nested derived scope into the operation that opened it', async () => {
    await runInContext(context('org-a'), async () => {
      expect(getContext().orgId).toBe('org-a');

      await runInDerivedContext({ orgId: 'org-b' }, async () => {
        await delay(2);
        expect(getContext().orgId).toBe('org-b');
      });

      await delay(2);
      expect(getContext().orgId).toBe('org-a');
    });
  });

  it('leaves no context behind after the scope completes', async () => {
    await runInContext(context('org-a'), () => delay(1));
    expect(hasContext()).toBe(false);
  });
});

describe('deriveContext', () => {
  it('carries provenance forward and replaces only what was asked for', () => {
    runInContext(context('org-a'), () => {
      const derived = deriveContext({ orgId: 'org-b' });

      expect(derived.orgId).toBe('org-b');
      expect(derived.requestId).toBe('req-org-a');
      expect(derived.actorId).toBe('user-org-a');
      expect(derived.invocationMode).toBe('interactive');
    });
  });

  it('treats an explicit null as an override and an absent key as inheritance', () => {
    runInContext(context('org-a'), () => {
      expect(deriveContext({ userId: null }).userId).toBeNull();
      expect(deriveContext({}).userId).toBe('user-org-a');
    });
  });
});

describe('background jobs re-scope per row (spec §4)', () => {
  it('handles rows from several orgs without any handler seeing another org', async () => {
    const rows = [
      { orgId: 'org-a', id: 1 },
      { orgId: 'org-b', id: 2 },
      { orgId: 'org-a', id: 3 },
      { orgId: 'org-c', id: 4 },
    ];

    const seen: { readonly id: number; readonly orgId: string }[] = [];

    // A job's own root scope: an automation actor, no user, scheduled.
    await runInContext(
      createRequestContext({
        orgId: rows[0]?.orgId ?? 'org-a',
        roleId: 'role-system',
        actorType: 'automation',
        actorId: 'nightly-job',
        invocationMode: 'scheduled',
      }),
      async () => {
        // Concurrent on purpose: the per-row scope has to hold even when the rows
        // are processed in parallel, which is how a real queue consumer drains.
        await Promise.all(
          rows.map((row) =>
            runInDerivedContext({ orgId: row.orgId }, async () => {
              await delay(1 + (row.id % 3));
              seen.push({ id: row.id, orgId: getContext().orgId });
            }),
          ),
        );
      },
    );

    expect(seen.sort((a, b) => a.id - b.id)).toEqual(rows.map((row) => ({ ...row })));
  });
});
