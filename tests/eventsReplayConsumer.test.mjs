import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumePage,
  createFictionalPage,
  FictionalReceiver,
  runReplayDemo,
} from '../examples/events-replay-consumer.mjs';

test('a partly successful page replays without repeating the recorded local action', async () => {
  const page = createFictionalPage();
  const receiver = new FictionalReceiver();
  const firstEventId = page.events[0].id;
  const failedEventId = page.events[1].id;

  await assert.rejects(
    consumePage(page, receiver, { failEventId: failedEventId }),
    new RegExp(`simulated receiver failure for ${failedEventId}`)
  );
  assert.deepEqual(
    receiver.actions.map((action) => action.eventId),
    [firstEventId]
  );

  const retry = await consumePage(page, receiver);
  assert.deepEqual(retry.skippedEventIds, [firstEventId]);
  assert.deepEqual(retry.appliedEventIds, [failedEventId]);
  assert.equal(retry.next, page.next);
  assert.deepEqual(
    receiver.actions.map((action) => action.eventId),
    [firstEventId, failedEventId]
  );
  assert.equal(receiver.actions.filter((action) => action.eventId === firstEventId).length, 1);
});

test('an asynchronous receiver.has is awaited before deciding to skip', async () => {
  const page = createFictionalPage();
  const hasCalls = [];
  const applyCalls = [];
  const receiver = {
    async has(eventId) {
      hasCalls.push(eventId);
      return false;
    },
    async apply(event) {
      applyCalls.push(event.id);
      return { applied: true };
    },
  };

  const result = await consumePage(page, receiver);

  assert.deepEqual(
    hasCalls,
    page.events.map((event) => event.id)
  );
  assert.deepEqual(
    applyCalls,
    page.events.map((event) => event.id)
  );
  assert.deepEqual(
    result.appliedEventIds,
    page.events.map((event) => event.id)
  );
  assert.deepEqual(result.skippedEventIds, []);
});

test('an apply result must explicitly report success or a duplicate skip', async () => {
  const page = createFictionalPage();
  const receiver = {
    async has() {
      return false;
    },
    async apply() {
      return undefined;
    },
  };

  await assert.rejects(
    consumePage(page, receiver),
    /receiver\.apply must return \{ applied: true \| false \}/
  );
});

test('an empty page still returns its continuation cursor after successful handling', async () => {
  const receiver = new FictionalReceiver();
  const page = {
    version: 1,
    events: [],
    next: 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    hasMore: false,
  };
  const result = await consumePage(page, receiver);

  assert.deepEqual(result, {
    appliedEventIds: [],
    skippedEventIds: [],
    next: page.next,
    hasMore: false,
  });
  assert.deepEqual(receiver.actions, []);
});

test('pages without stable event IDs or with repeated IDs are rejected before actions', async () => {
  const receiver = new FictionalReceiver();
  const page = createFictionalPage();

  await assert.rejects(
    consumePage({ ...page, events: [{ type: 'task.updated' }] }, receiver),
    /stable event ID/
  );
  await assert.rejects(
    consumePage({ ...page, events: [page.events[0], page.events[0]] }, receiver),
    /duplicate event ID/
  );
  assert.deepEqual(receiver.actions, []);
});

test('the runnable demo leaves acknowledgement to its caller', async () => {
  const result = await runReplayDemo();

  assert.match(result.firstAttemptFailure, /evt-example-102/);
  assert.deepEqual(result.firstAttemptActions, ['evt-example-101']);
  assert.deepEqual(result.retryAppliedEventIds, ['evt-example-102']);
  assert.deepEqual(result.retrySkippedEventIds, ['evt-example-101']);
  assert.deepEqual(result.receiverActions, ['evt-example-101', 'evt-example-102']);
  assert.deepEqual(result.acknowledgementCandidate, {
    from: '0',
    to: 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });
});
