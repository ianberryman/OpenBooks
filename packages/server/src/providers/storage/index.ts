import type { StorageProvider } from '@openbooks/plugin-api';

import type { StorageConfig } from '../../config';

import { createLocalStorageProvider } from './local';
import { createS3StorageProvider } from './s3';

/**
 * The storage adapter for this deployment (D-07), selected by configuration.
 *
 * The switch mirrors `selectEmailProvider`/`selectQueueProvider`: exhaustive over the
 * `StorageConfig` discriminated union, so a new provider id does not compile until it
 * has an adapter to answer for it. `local` is the self-host story (filesystem under
 * `basePath`); `s3` is the hosted one (a bucket). Both ship now because both have a
 * consumer now — invoicing needs somewhere to keep a logo and a retained PDF on either
 * topology (OB-120), which is exactly the "adapter ships with its first consumer" bar
 * D-07 sets.
 */
export function createStorageProvider(storage: StorageConfig): StorageProvider {
  switch (storage.provider) {
    case 'local':
      return createLocalStorageProvider(storage);
    case 's3':
      return createS3StorageProvider(storage);
  }
}

export { createLocalStorageProvider, LOCAL_ARTIFACT_PREFIX } from './local';
export { createS3StorageProvider } from './s3';
