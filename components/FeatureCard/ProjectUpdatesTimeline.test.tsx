import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { addProjectUpdate, deleteProjectUpdate, getProjectUpdates } from '../../app/lib/apiClient';
import type { ProjectSummary, ProjectUpdate } from '../../app/types/project.types';
import { clearOnAccountChange } from '../../components/Providers';
import { ProjectUpdatesTimeline } from './ProjectUpdatesTimeline';

jest.mock('../../app/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ userId: 'test-user-id' }),
}));

jest.mock('../../app/lib/apiClient', () => ({
  addProjectUpdate: jest.fn(),
  deleteProjectUpdate: jest.fn(),
  getProjectUpdates: jest.fn(),
}));

jest.mock('@mantine/notifications', () => ({
  notifications: { show: jest.fn() },
}));

const taskId = 'fictional-task';
const accountId = 'test-user-id';
const timelineKey = ['project-updates', taskId] as const;
const summaryKey = ['board-summary', accountId, 'all'] as const;

function update(
  id: string,
  createdAt: string,
  overrides: Partial<ProjectUpdate> = {}
): ProjectUpdate {
  return {
    id,
    projectId: taskId,
    userId: accountId,
    authorName: 'Test User',
    note: `Note ${id}`,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: taskId,
    userId: accountId,
    project: 'Fictional task',
    status: 'do',
    priority: 5,
    size: '**',
    noteCount: 0,
    lastNoteAt: null,
    isDeleted: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mountTimeline(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <ProjectUpdatesTimeline projectId={taskId} />
      </MantineProvider>
    </QueryClientProvider>
  );
}

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clearOnAccountChange(queryClient, undefined, accountId);
  return queryClient;
}

function seedCaches(
  queryClient: QueryClient,
  updates: ProjectUpdate[],
  cachedSummary: ProjectSummary = summary({
    noteCount: updates.length,
    lastNoteAt: updates.at(-1)?.createdAt ?? null,
  }),
  queryKey: readonly unknown[] = summaryKey
) {
  queryClient.setQueryData(timelineKey, updates);
  queryClient.setQueryData(queryKey, [cachedSummary]);
}

async function startAdd(noteText = 'A fresh note') {
  fireEvent.click(screen.getByRole('button', { name: 'Add Update / Note' }));
  fireEvent.change(screen.getByPlaceholderText('Write an update or note...'), {
    target: { value: noteText },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Update' }));
  await waitFor(() => expect(addProjectUpdate).toHaveBeenCalled());
}

async function startDelete(index = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete update' })[index]);
  await waitFor(() => expect(deleteProjectUpdate).toHaveBeenCalled());
}

describe('ProjectUpdatesTimeline note mutations', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = createQueryClient();
    (getProjectUpdates as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => queryClient.clear());

  it('adds the note to the timeline and updates board note metadata', async () => {
    const original = update('note-old', '2026-10-01T10:00:00.000Z');
    const added = update('note-new', '2026-10-03T10:00:00.000Z', {
      note: 'A fresh note',
      gmailThreadId: 'thread-123',
    });
    seedCaches(queryClient, [original]);
    (addProjectUpdate as jest.Mock).mockResolvedValueOnce(added);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    mountTimeline(queryClient);
    await startAdd();

    await waitFor(() => expect(queryClient.getQueryData(timelineKey)).toEqual([original, added]));
    expect(queryClient.getQueryData<ProjectSummary[]>(summaryKey)?.[0]).toMatchObject({
      noteCount: 2,
      lastNoteAt: added.createdAt,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Note added', color: 'green' })
    );
  });

  it('removes a deleted note and derives the latest date from the remaining notes', async () => {
    const first = update('note-first', '2026-10-01T10:00:00.000Z');
    const second = update('note-second', '2026-10-02T10:00:00.000Z');
    seedCaches(queryClient, [first, second]);
    (deleteProjectUpdate as jest.Mock).mockResolvedValueOnce({ message: 'Deleted' });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    mountTimeline(queryClient);
    await startDelete(1);

    await waitFor(() => expect(queryClient.getQueryData(timelineKey)).toEqual([first]));
    expect(queryClient.getQueryData<ProjectSummary[]>(summaryKey)?.[0]).toMatchObject({
      noteCount: 1,
      lastNoteAt: first.createdAt,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Note deleted', color: 'green' })
    );
  });

  it('does not write a delayed add response into the next account timeline', async () => {
    const pending = deferred<ProjectUpdate>();
    const addedByPreviousAccount = update('note-old-account', '2026-10-03T10:00:00.000Z');
    const currentAccountNote = update('note-current-account', '2026-10-02T10:00:00.000Z', {
      userId: 'account-b',
      authorName: 'Other User',
    });
    seedCaches(queryClient, []);
    (addProjectUpdate as jest.Mock).mockReturnValueOnce(pending.promise);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    mountTimeline(queryClient);
    await startAdd();

    clearOnAccountChange(queryClient, accountId, 'account-b');
    queryClient.setQueryData(timelineKey, [currentAccountNote]);
    const currentSummary = summary({
      userId: 'account-b',
      noteCount: 1,
      lastNoteAt: currentAccountNote.createdAt,
    });
    queryClient.setQueryData(['board-summary', 'account-b', 'all'], [currentSummary]);
    pending.resolve(addedByPreviousAccount);

    await waitFor(() => expect(addProjectUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(queryClient.getQueryData(timelineKey)).toEqual([currentAccountNote])
    );
    expect(
      queryClient.getQueryData<ProjectSummary[]>(['board-summary', 'account-b', 'all'])?.[0]
    ).toEqual(currentSummary);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(notifications.show).not.toHaveBeenCalled();
  });

  it('does not write a delayed delete response into the next account timeline', async () => {
    const pending = deferred<{ message: string }>();
    const noteFromPreviousAccount = update('shared-note-id', '2026-10-01T10:00:00.000Z');
    const currentAccountNote = update('shared-note-id', '2026-10-01T10:00:00.000Z', {
      userId: 'account-b',
      authorName: 'Other User',
    });
    seedCaches(queryClient, [noteFromPreviousAccount]);
    (deleteProjectUpdate as jest.Mock).mockReturnValueOnce(pending.promise);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    mountTimeline(queryClient);
    await startDelete();

    clearOnAccountChange(queryClient, accountId, 'account-b');
    queryClient.setQueryData(timelineKey, [currentAccountNote]);
    const currentSummary = summary({
      userId: 'account-b',
      noteCount: 1,
      lastNoteAt: currentAccountNote.createdAt,
    });
    queryClient.setQueryData(['board-summary', 'account-b', 'all'], [currentSummary]);
    pending.resolve({ message: 'Deleted' });

    await waitFor(() =>
      expect(queryClient.getQueryData(timelineKey)).toEqual([currentAccountNote])
    );
    expect(
      queryClient.getQueryData<ProjectSummary[]>(['board-summary', 'account-b', 'all'])?.[0]
    ).toEqual(currentSummary);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(notifications.show).not.toHaveBeenCalled();
  });

  it('ignores an add response from before logout and relogin with the same account id', async () => {
    const pending = deferred<ProjectUpdate>();
    const addedBeforeLogout = update('note-before-logout', '2026-10-03T10:00:00.000Z');
    const noteAfterLogin = update('note-after-login', '2026-10-02T10:00:00.000Z');
    seedCaches(queryClient, []);
    (addProjectUpdate as jest.Mock).mockReturnValueOnce(pending.promise);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    mountTimeline(queryClient);
    await startAdd();

    clearOnAccountChange(queryClient, accountId, null);
    clearOnAccountChange(queryClient, null, accountId);
    seedCaches(
      queryClient,
      [noteAfterLogin],
      summary({ noteCount: 1, lastNoteAt: noteAfterLogin.createdAt })
    );
    pending.resolve(addedBeforeLogout);

    await waitFor(() => expect(queryClient.getQueryData(timelineKey)).toEqual([noteAfterLogin]));
    expect(queryClient.getQueryData<ProjectSummary[]>(summaryKey)?.[0]).toMatchObject({
      noteCount: 1,
      lastNoteAt: noteAfterLogin.createdAt,
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(notifications.show).not.toHaveBeenCalled();
  });

  it('ignores a delete response from before logout and relogin with the same account id', async () => {
    const pending = deferred<{ message: string }>();
    const noteBeforeLogout = update('same-note-id', '2026-10-01T10:00:00.000Z');
    const noteAfterLogin = update('same-note-id', '2026-10-02T10:00:00.000Z');
    seedCaches(queryClient, [noteBeforeLogout]);
    (deleteProjectUpdate as jest.Mock).mockReturnValueOnce(pending.promise);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    mountTimeline(queryClient);
    await startDelete();

    clearOnAccountChange(queryClient, accountId, null);
    clearOnAccountChange(queryClient, null, accountId);
    seedCaches(
      queryClient,
      [noteAfterLogin],
      summary({ noteCount: 2, lastNoteAt: noteAfterLogin.createdAt })
    );
    pending.resolve({ message: 'Deleted' });

    await waitFor(() => expect(queryClient.getQueryData(timelineKey)).toEqual([noteAfterLogin]));
    expect(queryClient.getQueryData<ProjectSummary[]>(summaryKey)?.[0]).toMatchObject({
      noteCount: 2,
      lastNoteAt: noteAfterLogin.createdAt,
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(notifications.show).not.toHaveBeenCalled();
  });

  it('does not report an old account add failure in the current session', async () => {
    const pending = deferred<ProjectUpdate>();
    const currentAccountNote = update('note-current-account', '2026-10-02T10:00:00.000Z', {
      userId: 'account-b',
      authorName: 'Other User',
    });
    seedCaches(queryClient, []);
    (addProjectUpdate as jest.Mock).mockReturnValueOnce(pending.promise);

    mountTimeline(queryClient);
    await startAdd();

    clearOnAccountChange(queryClient, accountId, 'account-b');
    queryClient.setQueryData(timelineKey, [currentAccountNote]);
    pending.reject(new Error('Old request failed'));

    await waitFor(() =>
      expect(queryClient.getQueryData(timelineKey)).toEqual([currentAccountNote])
    );
    expect(notifications.show).not.toHaveBeenCalled();
  });
});
