import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { apiFetch } from '../../app/lib/apiClient';
import { setTaskCacheAccount } from '../../app/lib/taskCache';
import { VoiceCommand } from './VoiceCommand';

const mockUseSession = jest.fn();
const mockPush = jest.fn();

jest.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('../../app/lib/apiClient', () => ({ apiFetch: jest.fn() }));
jest.mock('../../app/lib/apiConfig', () => ({
  getWorkerApiBaseUrl: () => 'https://worker.example.test',
}));
jest.mock('./RecordingToolbar', () => ({ RecordingToolbar: () => null }));
jest.mock('@mantine/notifications', () => ({ notifications: { show: jest.fn() } }));

class TestMediaRecorder {
  static isTypeSupported() {
    return true;
  }

  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  start() {}

  stop() {
    this.onstop?.();
  }
}

describe('VoiceCommand upload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    mockUseSession.mockReturnValue({
      data: {
        user: { id: 'account-a', email: 'account-a@example.test' },
        accessToken: 'fictional-token',
      },
      status: 'authenticated',
    });
    (apiFetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ summary: 'No changes suggested', proposedChanges: [] }),
    });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: TestMediaRecorder,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: jest.fn().mockResolvedValue({
          getTracks: () => [{ stop: jest.fn() }],
        }),
      },
    });
  });

  it('does not serialise the full cached task list with the audio', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    setTaskCacheAccount(queryClient, 'account-a');
    queryClient.setQueryData(
      ['projects'],
      [{ id: 'fictional-task', project: 'A cached task', notes: 'Full private body' }]
    );

    render(
      <QueryClientProvider client={queryClient}>
        <MantineProvider>
          <VoiceCommand />
        </MantineProvider>
      </QueryClientProvider>
    );

    const label = screen.getByText('Voice Command');
    fireEvent.click(label);
    await screen.findByText('Recording... Click stop when done.');
    fireEvent.click(label);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    const [, request] = (apiFetch as jest.Mock).mock.calls[0];
    const form = request.body as FormData;
    expect(form.has('audio')).toBe(true);
    expect(form.has('projects')).toBe(false);
  });

  it.each([false, true])(
    'keeps review data out of URLs when storage works: %s',
    async (storageWorks) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      setTaskCacheAccount(queryClient, 'account-a');
      const result = {
        transcript: 'Fictional private dictated details',
        summary: 'Fictional private summary',
        me: { id: 'account-a', name: 'Casey Example' },
        proposedChanges: [
          { type: 'create', before: null, after: { project: 'Fictional private task' } },
        ],
      };
      (apiFetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => result });
      const storage = jest.spyOn(Storage.prototype, 'setItem');
      if (!storageWorks) {
        storage.mockImplementation(() => {
          throw new DOMException('Fictional storage failure', 'QuotaExceededError');
        });
      }
      const view = render(
        <QueryClientProvider client={queryClient}>
          <MantineProvider>
            <VoiceCommand />
          </MantineProvider>
        </QueryClientProvider>
      );

      try {
        fireEvent.click(screen.getByText('Voice Command'));
        await screen.findByText('Recording... Click stop when done.');
        fireEvent.click(screen.getByText('Voice Command'));
        await waitFor(() =>
          expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success')
        );
        expect(storage).toHaveBeenCalled();
        if (storageWorks) {
          expect(mockPush).toHaveBeenCalledWith('/board/review-changes');
          expect(JSON.parse(sessionStorage.getItem('timdo:voice-review')!)).toMatchObject({
            accountId: 'account-a',
            result,
          });
        } else {
          expect(mockPush).not.toHaveBeenCalled();
          expect(sessionStorage.getItem('timdo:voice-review')).toBeNull();
          expect(notifications.show).toHaveBeenCalledWith(
            expect.objectContaining({
              title: 'Review unavailable',
              message: expect.stringContaining('No task changes were made'),
              autoClose: false,
            })
          );
        }
        expect(mockPush.mock.calls.every(([url]) => !url.includes('?'))).toBe(true);
        expect(screen.getByText('Click anywhere to start')).toBeInTheDocument();
      } finally {
        storage.mockRestore();
        view.unmount();
        queryClient.clear();
      }
    }
  );

  it('does not save or navigate when voice generation finishes in a different account', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    setTaskCacheAccount(queryClient, 'account-a');
    let resolveRequest!: (response: unknown) => void;
    const result = {
      transcript: 'Add a task',
      summary: 'Added a task',
      proposedChanges: [
        {
          type: 'create',
          before: null,
          after: { project: 'Account A task' },
        },
      ],
    };
    const json = jest.fn(async () => result);
    (apiFetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );

    const view = render(
      <QueryClientProvider client={queryClient}>
        <MantineProvider>
          <VoiceCommand />
        </MantineProvider>
      </QueryClientProvider>
    );

    const label = screen.getByText('Voice Command');
    fireEvent.click(label);
    await screen.findByText('Recording... Click stop when done.');
    fireEvent.click(label);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    mockUseSession.mockReturnValue({
      data: { user: { id: 'account-b', email: 'account-b@example.test' }, accessToken: 'token-b' },
      status: 'authenticated',
    });
    setTaskCacheAccount(queryClient, 'account-b');
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <MantineProvider>
          <VoiceCommand />
        </MantineProvider>
      </QueryClientProvider>
    );

    await act(async () => {
      resolveRequest({ ok: true, json });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(json).toHaveBeenCalled();
    expect(sessionStorage.getItem('timdo:voice-review')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('leaves the new account recording and timeout intact when the old stop event arrives late', async () => {
    jest.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    setTaskCacheAccount(queryClient, 'account-a');
    const pendingStops: (() => void)[] = [];
    const recorders: AsyncMediaRecorder[] = [];
    class AsyncMediaRecorder extends TestMediaRecorder {
      state = 'inactive';

      constructor() {
        super();
        recorders.push(this);
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        pendingStops.push(() => this.onstop?.());
      }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: AsyncMediaRecorder,
    });
    const stopFirstStream = jest.fn();
    const stopSecondStream = jest.fn();
    (navigator.mediaDevices.getUserMedia as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce({ getTracks: () => [{ stop: stopFirstStream }] })
      .mockResolvedValueOnce({ getTracks: () => [{ stop: stopSecondStream }] });
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
    const content = (
      <QueryClientProvider client={queryClient}>
        <MantineProvider>
          <VoiceCommand />
        </MantineProvider>
      </QueryClientProvider>
    );
    const view = render(content);

    try {
      await act(async () => fireEvent.click(screen.getByText('Voice Command')));
      expect(recorders[0].state).toBe('recording');
      mockUseSession.mockReturnValue({
        data: {
          user: { id: 'account-b', email: 'account-b@example.test' },
          accessToken: 'token-b',
        },
        status: 'authenticated',
      });
      setTaskCacheAccount(queryClient, 'account-b');
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <MantineProvider>
            <VoiceCommand />
          </MantineProvider>
        </QueryClientProvider>
      );
      expect(pendingStops).toHaveLength(1);
      expect(stopFirstStream).toHaveBeenCalledTimes(1);

      await act(async () => fireEvent.click(screen.getByText('Voice Command')));
      expect(recorders[1].state).toBe('recording');
      const timeoutIndex = setTimeoutSpy.mock.calls.findLastIndex((call) => call[1] === 180000);
      expect(timeoutIndex).toBeGreaterThanOrEqual(0);
      const secondTimeout = setTimeoutSpy.mock.results[timeoutIndex].value;
      clearTimeoutSpy.mockClear();

      act(() => pendingStops[0]());
      expect(stopSecondStream).not.toHaveBeenCalled();
      expect(clearTimeoutSpy).not.toHaveBeenCalledWith(secondTimeout);
      expect(apiFetch).not.toHaveBeenCalled();
      expect(screen.getByText('Recording... Click stop when done.')).toBeInTheDocument();

      act(() => jest.advanceTimersByTime(180000));
      expect(pendingStops).toHaveLength(2);
      expect(recorders[1].state).toBe('inactive');
      await act(async () => pendingStops[1]());
      expect(stopSecondStream).toHaveBeenCalledTimes(1);
      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect((apiFetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('Bearer token-b');
    } finally {
      view.unmount();
      queryClient.clear();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
