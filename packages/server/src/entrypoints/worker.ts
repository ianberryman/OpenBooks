/**
 * Worker role.
 *
 * Exists from M1 with no registered jobs, deliberately: it proves the
 * one-image-three-roles mechanism and the provider selection path before there
 * is a queue to consume. The agent task queue arrives in M5, the banking
 * import pipeline in M4.
 */
export async function startWorker(): Promise<void> {
  await Promise.resolve();
  process.stdout.write('worker: no jobs registered in M1; idling\n');
}
