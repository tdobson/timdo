import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class FictionalReceiver {
  #receipts = new Map();
  #actions = [];

  has(eventId) {
    return this.#receipts.has(eventId);
  }

  async apply(event, { failEventId } = {}) {
    if (this.#receipts.has(event.id)) return { applied: false };
    if (event.id === failEventId) throw new Error(`simulated receiver failure for ${event.id}`);

    const receipt = { eventId: event.id, type: event.type, taskId: event.taskId ?? null };
    this.#receipts.set(event.id, receipt);
    this.#actions.push(receipt);
    return { applied: true };
  }

  get actions() {
    return this.#actions.map((action) => ({ ...action }));
  }
}

function validatePage(page) {
  if (
    !page ||
    typeof page !== 'object' ||
    Array.isArray(page) ||
    page.version !== 1 ||
    !Array.isArray(page.events) ||
    typeof page.next !== 'string' ||
    page.next.length === 0 ||
    typeof page.hasMore !== 'boolean'
  ) {
    throw new Error('expected one version 1 events page');
  }
  const ids = new Set();
  for (const event of page.events) {
    if (
      !event ||
      typeof event !== 'object' ||
      typeof event.id !== 'string' ||
      event.id.length === 0
    ) {
      throw new Error('every event needs a stable event ID');
    }
    if (ids.has(event.id)) throw new Error(`duplicate event ID in page: ${event.id}`);
    ids.add(event.id);
  }
}

export async function consumePage(page, receiver, options = {}) {
  validatePage(page);
  if (!receiver || typeof receiver.has !== 'function' || typeof receiver.apply !== 'function') {
    throw new Error('receiver must provide has(eventId) and apply(event)');
  }

  const appliedEventIds = [];
  const skippedEventIds = [];
  for (const event of page.events) {
    if (await receiver.has(event.id)) {
      skippedEventIds.push(event.id);
      continue;
    }
    const result = await receiver.apply(event, options);
    if (!result || typeof result !== 'object' || typeof result.applied !== 'boolean') {
      throw new Error('receiver.apply must return { applied: true | false }');
    }
    if (result.applied === false) skippedEventIds.push(event.id);
    else appliedEventIds.push(event.id);
  }

  // The caller receives a cursor only after every event in the page has succeeded.
  return {
    appliedEventIds,
    skippedEventIds,
    next: page.next,
    hasMore: page.hasMore,
  };
}

export function createFictionalPage() {
  return {
    version: 1,
    events: [
      { id: 'evt-example-101', type: 'task.completed', taskId: 'task-example-201' },
      { id: 'evt-example-102', type: 'ref.added', taskId: 'task-example-202' },
    ],
    next: 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    hasMore: false,
  };
}

export async function runReplayDemo() {
  const page = createFictionalPage();
  const receiver = new FictionalReceiver();
  let failure;
  try {
    await consumePage(page, receiver, { failEventId: 'evt-example-102' });
  } catch (error) {
    failure = error.message;
  }

  const firstAttemptActions = receiver.actions.map((action) => action.eventId);
  const retry = await consumePage(page, receiver);
  return {
    firstAttemptFailure: failure,
    firstAttemptActions,
    retryAppliedEventIds: retry.appliedEventIds,
    retrySkippedEventIds: retry.skippedEventIds,
    receiverActions: receiver.actions.map((action) => action.eventId),
    acknowledgementCandidate: { from: '0', to: retry.next },
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runReplayDemo()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
