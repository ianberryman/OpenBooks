import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StorageProvider } from '@openbooks/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalStorageProvider, LOCAL_ARTIFACT_PREFIX } from './local';

/**
 * The local `StorageProvider`, in isolation (OB-120).
 *
 * A real temp directory, no mocks (spec §11): every case is a claim about bytes on
 * disk. The two that carry the adapter's contract are the round-trip — what `put`
 * writes is exactly what `get` reads back — and the nested key, because invoicing's
 * keys carry `/` (`orgs/<id>/logo.png`) and the adapter, not the caller, owns
 * creating the layout.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('createLocalStorageProvider', () => {
  let basePath: string;
  let storage: StorageProvider;

  beforeEach(async () => {
    basePath = await mkdtemp(join(tmpdir(), 'openbooks-storage-'));
    storage = createLocalStorageProvider({ provider: 'local', basePath });
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  it('round-trips put through get, byte for byte', async () => {
    const bytes = encoder.encode('a retained invoice PDF');

    await storage.put('invoice.pdf', bytes, 'application/pdf');
    const read = await storage.get('invoice.pdf');

    expect(decoder.decode(read)).toBe('a retained invoice PDF');
    // The exact bytes, not a coincidentally-equal decode — the contract is Uint8Array.
    expect([...read]).toEqual([...bytes]);
  });

  it('creates nested directories for a key containing slashes', async () => {
    const bytes = encoder.encode('logo');

    await storage.put('orgs/abc/logo.png', bytes, 'image/png');

    // The nested layout exists on disk, and get resolves the same key.
    const onDisk = await stat(join(basePath, 'orgs', 'abc', 'logo.png'));
    expect(onDisk.isFile()).toBe(true);
    expect(decoder.decode(await storage.get('orgs/abc/logo.png'))).toBe('logo');
  });

  it('removes an object on delete and is idempotent on an absent key', async () => {
    await storage.put('gone.pdf', encoder.encode('x'));
    await storage.delete('gone.pdf');

    await expect(storage.get('gone.pdf')).rejects.toThrow();
    // A second delete of the same, now-absent key does not throw (contract: idempotent).
    await expect(storage.delete('gone.pdf')).resolves.toBeUndefined();
  });

  it('signedUrl returns the app-served retrieval path, not an external URL', async () => {
    // Local has no signing; the api streams the object itself from this path. The
    // expiry argument is accepted and has no local meaning.
    const url = await storage.signedUrl('orgs/abc/logo.png', 900);

    expect(url).toBe(`${LOCAL_ARTIFACT_PREFIX}orgs/abc/logo.png`);
  });

  it('refuses a key that escapes basePath', async () => {
    await expect(storage.put('../escape.pdf', encoder.encode('x'))).rejects.toThrow(
      /outside the configured basePath/,
    );
  });
});
