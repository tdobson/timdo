import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { notifications } from '@mantine/notifications';
import type { VoiceCommandResult } from '../../../components/VoiceCommand/voiceTypes';
import { render } from '../../../test-utils/render';
import ReviewChangesPage from './page';

const mockPush = jest.fn();
const mockRouter = { push: mockPush };
const mockSearchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}));

jest.mock('@mantine/notifications', () => ({
  notifications: { show: jest.fn() },
}));

const API = 'https://worker.example.com/api/v2';
const fetchMock = jest.fn();
global.fetch = fetchMock as any;

const result: VoiceCommandResult = {
  transcript: 'Add a Acme Solar task for Robin to check the inverter datasheet',
  summary: 'Added a task for Robin',
  warnings: [
    'You have view-only access to "Club Kit", so I left out "Buy rope".',
    'Robin Fairweather is busy.',
  ],
  me: { id: 'alex', name: 'Alex Rowan' },
  proposedChanges: [
    {
      type: 'create',
      before: null,
      after: { project: 'Check the inverter datasheet', status: 'do', priority: 5, size: '***' },
      projectId: 'proj-acme',
      projectName: 'Acme Solar',
      orgName: 'Northstar Workshop',
      assigneeId: 'robin',
      assigneeName: 'Robin Fairweather',
      assigneeChanged: true,
      warnings: ['Robin Fairweather is busy.'],
    },
    {
      type: 'claim',
      before: {
        id: 'task-1',
        userId: 'alex',
        project: 'Acme Solar onboarding',
        status: 'do',
        priority: 7,
        size: '**',
        projectName: 'Acme Solar',
        assigneeId: null,
        assigneeName: null,
        isDeleted: false,
        createdAt: '',
        updatedAt: '',
      },
      after: null,
      taskId: 'task-1',
      projectId: 'proj-acme',
      projectName: 'Acme Solar',
      orgName: 'Northstar Workshop',
      assigneeId: 'alex',
      assigneeName: 'Alex Rowan',
      assigneeChanged: true,
    },
  ],
};

describe('Review voice changes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
    sessionStorage.setItem('timdo:voice-review', JSON.stringify(result));
  });

  it('shows the workspace, project, assignee, transcript and warnings', async () => {
    render(<ReviewChangesPage />);
    expect(await screen.findByText('New task')).toBeInTheDocument();
    expect(screen.getByText('Northstar Workshop / Acme Solar')).toBeInTheDocument();
    expect(screen.getByText('Assign to Robin Fairweather')).toBeInTheDocument();
    expect(screen.getByText(/Add a Acme Solar task for Robin/)).toBeInTheDocument();
    // Left-out changes at the top, this card's own warning on the card
    expect(screen.getByText('One thing was left out')).toBeInTheDocument();
    expect(
      screen.getByText('You have view-only access to "Club Kit", so I left out "Buy rope".')
    ).toBeInTheDocument();
    expect(screen.getByText('Robin Fairweather is busy.')).toBeInTheDocument();
    expect(screen.getByText('Change 1 of 2')).toBeInTheDocument();
  });

  it('applies with ids, shows "Assign to you" for a claim, and finishes', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply and next' }));

    expect(await screen.findByText('Claim task')).toBeInTheDocument();
    expect(screen.getByText('Assign to you')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/projects`);
    expect(JSON.parse(init.body)).toMatchObject({ projectId: 'proj-acme', assigneeId: 'robin' });

    fireEvent.click(screen.getByRole('button', { name: 'Apply and finish' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/board'));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ assigneeId: 'alex' });
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Review complete',
        message: 'Applied 2 changes, skipped 0.',
      })
    );
    expect(sessionStorage.getItem('timdo:voice-review')).toBeNull();
  });

  it("shows the API's 403 message and stays on the change", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'You have view-only access to "Acme Solar"' }),
    });
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply and next' }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Not allowed',
          message: 'You have view-only access to "Acme Solar"',
          color: 'red',
        })
      )
    );
    expect(screen.getByText('New task')).toBeInTheDocument();
    expect(screen.getByText('You have view-only access to "Acme Solar"')).toBeInTheDocument();
  });

  it('counts skips', async () => {
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/board'));
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Applied 0 changes, skipped 2.' })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('goes back to the board when there is nothing to review', async () => {
    sessionStorage.clear();
    render(<ReviewChangesPage />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/board'));
  });
});

describe('Review voice changes: links', () => {
  const withLinks: VoiceCommandResult = {
    transcript: 'Link the offer page task to issue 12 on widgets, reported by member 4411',
    summary: 'Linked a task',
    me: { id: 'alex', name: 'Alex Rowan' },
    proposedChanges: [
      {
        type: 'update',
        before: {
          id: 'task-1',
          userId: 'alex',
          project: 'Broken offer page',
          status: 'do',
          priority: 7,
          size: '**',
          projectId: 'proj-acme',
          projectName: 'Acme Solar',
          assigneeId: 'alex',
          assigneeName: 'Alex Rowan',
          isDeleted: false,
          createdAt: '',
          updatedAt: '',
        },
        after: { project: 'Broken offer page', status: 'do', priority: 7, size: '**' },
        taskId: 'task-1',
        projectId: 'proj-acme',
        projectName: 'Acme Solar',
        orgName: 'Northstar Workshop',
        assigneeName: 'Alex Rowan',
        refs: [
          {
            ref: 'github.issue:acme/widgets#12',
            role: 'link',
            kind: 'github.issue',
            url: 'https://github.com/acme/widgets/issues/12',
            label: 'GitHub issue acme/widgets#12',
          },
          {
            ref: 'acme.member:4411',
            role: 'reported_by',
            kind: 'acme.member',
            url: null,
            label: 'acme.member:4411',
          },
        ],
        removeRefs: [{ ref: 'forum.post:4411', role: 'source' }],
      } as VoiceCommandResult['proposedChanges'][number],
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
    sessionStorage.setItem('timdo:voice-review', JSON.stringify(withLinks));
  });

  it('shows each proposed link change plainly before anything is applied', async () => {
    render(<ReviewChangesPage />);
    const section = await screen.findByTestId('voice-ref-changes');
    expect(section).toHaveTextContent('Remove source forum.post:4411');
    expect(section).toHaveTextContent('Link github.issue:acme/widgets#12');
    expect(section).toHaveTextContent('Reported by acme.member:4411');
    expect(screen.getByRole('link', { name: 'github.issue:acme/widgets#12' })).toHaveAttribute(
      'href',
      'https://github.com/acme/widgets/issues/12'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies only the ticked links, after the task change', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    render(<ReviewChangesPage />);
    const reporter = await screen.findByRole('checkbox', {
      name: 'Include: Reported by acme.member:4411',
    });
    expect(reporter).toBeChecked();
    fireEvent.click(reporter);
    // The name stays the same; only the checked state changes
    expect(
      screen.getByRole('checkbox', { name: 'Include: Reported by acme.member:4411' })
    ).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Include: Remove source forum.post:4411' })
    ).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Apply and finish' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/board'));
    // Nothing else changed on the task, so no PUT: just the links
    expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['DELETE', `${API}/tasks/task-1/refs?ref=forum.post%3A4411&role=source`],
      ['POST', `${API}/tasks/task-1/refs`],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      ref: 'github.issue:acme/widgets#12',
      role: 'link',
      url: 'https://github.com/acme/widgets/issues/12',
      label: 'GitHub issue acme/widgets#12',
    });
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Updated the links on "Broken offer page" (1 link added, 1 removed)',
        color: 'green',
      })
    );
  });

  it('says which links failed, and still counts the change as applied', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Role must be link, source, reported_by or about' }),
      });
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply and finish' }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "One link wasn't changed",
          message:
            "Couldn't link acme.member:4411: Role must be link, source, reported_by or about",
          color: 'yellow',
        })
      )
    );
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Applied 1 change, skipped 0.' })
    );
  });
});

describe('Review voice changes: atomic source refs', () => {
  const source = { ref: 'forum.post:4411', role: 'source' as const };
  const reporter = { ref: 'acme.member:4411', role: 'reported_by' as const };
  const withSources: VoiceCommandResult = {
    transcript: 'Add a task for the invoice import from the forum post',
    summary: 'Added an invoice import task',
    me: { id: 'alex', name: 'Alex Rowan' },
    proposedChanges: [
      {
        type: 'create',
        before: null,
        after: { project: 'Fix invoice import', status: 'do', priority: 5, size: '***' },
        projectId: 'proj-acme',
        projectName: 'Acme Solar',
        orgName: 'Northstar Workshop',
        refs: [source, reporter],
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
    sessionStorage.setItem('timdo:voice-review', JSON.stringify(withSources));
  });

  it.each([
    { name: 'includes the selected source', keepSource: true, expected: [source] },
    { name: 'omits the deselected source', keepSource: false, expected: [reporter] },
  ])('$name in the atomic create request', async ({ keepSource, expected }) => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'created-task', created: true }),
    });
    render(<ReviewChangesPage />);
    const sourceCheckbox = await screen.findByRole('checkbox', {
      name: 'Include: Source forum.post:4411',
    });
    expect(screen.getByTestId('voice-ref-changes')).toHaveTextContent(
      'Selected links are saved with the new task.'
    );
    const reporterCheckbox = screen.getByRole('checkbox', {
      name: 'Include: Reported by acme.member:4411',
    });
    if (keepSource) {
      fireEvent.click(reporterCheckbox);
    } else {
      fireEvent.click(sourceCheckbox);
    }

    fireEvent.click(screen.getByRole('button', { name: 'Apply and finish' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/board'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/projects`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).refs).toEqual(expected);
  });

  const existingTask = {
    id: '3f2a91c0-0000-0000-0000-000000000000',
    project: 'Existing source task',
    projectName: 'Acme Solar',
    canEdit: true,
  };

  it.each([
    {
      name: 'a structured 409',
      response: {
        ok: false,
        status: 409,
        json: async () => ({
          error: 'forum.post:4411 is already the source of 3f2a91c0 "Existing source task"',
          taskId: existingTask.id,
          task: existingTask,
        }),
      },
    },
    {
      name: 'a created:false response',
      response: {
        ok: true,
        status: 200,
        json: async () => ({ ...existingTask, created: false }),
      },
    },
  ])('shows $name as an existing task and does not advance', async ({ response }) => {
    fetchMock.mockResolvedValue(response);
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply and finish' }));

    expect(
      await screen.findByRole('link', { name: /Open #3f2a91c0 Existing source task/ })
    ).toHaveAttribute('href', `/tasks/${existingTask.id}`);
    expect(screen.getByText('Change 1 of 1')).toBeInTheDocument();
    expect(screen.getByText('New task')).toBeInTheDocument();
    expect(screen.getByText('No new task was created.')).toBeInTheDocument();
    expect(screen.queryByText('Add a note')).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/projects`);
    expect(notifications.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ color: 'green' })
    );
  });
});

describe('Review voice changes: likely duplicates', () => {
  const create = (n: number, similar: unknown[]) =>
    ({
      type: 'create',
      before: null,
      after: {
        project: n === 1 ? 'Fix the offer page' : 'Order inverter brackets',
        reason: n === 1 ? "Members can't book" : null,
        status: 'do',
        priority: 5,
        size: '***',
      },
      projectId: 'proj-acme',
      projectName: 'Acme Solar',
      orgName: 'Northstar Workshop',
      assigneeName: 'Alex Rowan',
      assigneeChanged: true,
      ...(n === 1
        ? {
            refs: [
              {
                ref: 'forum.post:4411',
                role: 'link',
                kind: 'forum.post',
                url: null,
                label: 'forum.post:4411',
              },
            ],
          }
        : {}),
      similar,
    }) as VoiceCommandResult['proposedChanges'][number];

  const offer = {
    id: 'task-offer',
    shortId: 'task-off',
    title: 'Broken offer page',
    status: 'do',
    projectId: 'proj-acme',
    projectName: 'Acme Solar',
    orgId: 'org-acme',
    orgName: 'Northstar Workshop',
    assigneeId: 'robin',
    assigneeName: 'Robin Fairweather',
    canEdit: true,
    score: 0.67,
    matchedRef: false,
  };
  const copy = { ...offer, id: 'task-copy', shortId: 'task-cop', title: 'Offer page copy' };

  const withDuplicates: VoiceCommandResult = {
    transcript: 'Add a Acme Solar task to fix the offer page, and order inverter brackets',
    summary: 'Added 2 tasks',
    me: { id: 'alex', name: 'Alex Rowan' },
    proposedChanges: [create(1, [offer, copy]), create(2, [])],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
    sessionStorage.setItem('timdo:voice-review', JSON.stringify(withDuplicates));
  });

  it('says it looks like an existing task, with the switch off by default', async () => {
    render(<ReviewChangesPage />);
    const hint = await screen.findByTestId('voice-duplicate-hint');
    expect(hint).toHaveTextContent(
      'Looks like an existing task: #task-off Broken offer page (Acme Solar)'
    );
    expect(hint).toHaveTextContent('Assigned to Robin Fairweather');
    expect(hint).toHaveTextContent('Also similar: #task-cop Offer page copy (Acme Solar)');
    expect(
      screen.getByRole('link', { name: 'Open #task-off Broken offer page (Acme Solar)' })
    ).toHaveAttribute('href', '/tasks/task-offer');
    expect(
      screen.getByRole('link', { name: 'Open #task-off Broken offer page (Acme Solar)' })
    ).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('switch', { name: 'Add as a note there instead' })).not.toBeChecked();
    expect(screen.getByText('New task')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('distinguishes matching titles in the same project by short ID', async () => {
    const sameTitle = { ...offer, id: 'task-other', shortId: 'other001' };
    sessionStorage.setItem(
      'timdo:voice-review',
      JSON.stringify({ ...withDuplicates, proposedChanges: [create(1, [offer, sameTitle])] })
    );
    render(<ReviewChangesPage />);

    expect(
      await screen.findByRole('link', { name: 'Open #task-off Broken offer page (Acme Solar)' })
    ).toHaveAttribute('href', '/tasks/task-offer');
    expect(
      screen.getByRole('link', { name: 'Open #other001 Broken offer page (Acme Solar)' })
    ).toHaveAttribute('href', '/tasks/task-other');
    fireEvent.click(screen.getByRole('switch', { name: 'Add as a note there instead' }));
    expect(
      screen.getByRole('radio', { name: '#task-off Broken offer page (Acme Solar)' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: '#other001 Broken offer page (Acme Solar)' })
    ).toBeInTheDocument();
  });

  it('does not offer the note action for a read-only matching task', async () => {
    const viewOnly = { ...offer, canEdit: false };
    sessionStorage.setItem(
      'timdo:voice-review',
      JSON.stringify({ ...withDuplicates, proposedChanges: [create(1, [viewOnly])] })
    );
    render(<ReviewChangesPage />);

    const toggle = await screen.findByRole('switch', { name: 'Add as a note there instead' });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText('You can view this task, but you cannot add a note here.')
    ).toBeInTheDocument();
  });

  it('left off, applying creates the task as usual', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'new' }) });
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply and next' }));
    await screen.findByText('Order inverter brackets');
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/projects`);
  });

  it('switched on, applying adds a note and the links to that task instead of creating', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'x' }) });
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Add as a note there instead' }));

    expect(screen.getByText('Add a note')).toBeInTheDocument();
    expect(screen.queryByText('New task')).not.toBeInTheDocument();
    expect(screen.getByTestId('voice-note-preview')).toHaveTextContent(
      "Note on \u201cBroken offer page\u201dFix the offer page Members can't book"
    );
    expect(screen.getByText(/Links are added to "Broken offer page" after the note/)).toBeVisible();
    expect(
      screen.getByRole('radio', { name: '#task-off Broken offer page (Acme Solar)' })
    ).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Apply and next' }));
    await screen.findByText('Order inverter brackets');
    expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['POST', `${API}/projects/task-offer/updates`],
      ['POST', `${API}/tasks/task-offer/refs`],
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      note: "Fix the offer page\nMembers can't book",
    });
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Added a note to "Broken offer page" (1 link added)',
        color: 'green',
      })
    );
    // The next change has no matches, so no hint and nothing left switched on
    expect(screen.queryByTestId('voice-duplicate-hint')).not.toBeInTheDocument();
    expect(screen.getByText('New task')).toBeInTheDocument();
  });

  it('advances after a saved note when only a link fails, without reposting the note', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 'note-1' }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Temporary link failure' }),
      });
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Add as a note there instead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply and next' }));

    await screen.findByText('Order inverter brackets');
    expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['POST', `${API}/projects/task-offer/updates`],
      ['POST', `${API}/tasks/task-offer/refs`],
    ]);
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Added a note to "Broken offer page"', color: 'green' })
    );
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "One link wasn't changed",
        message: "Couldn't link forum.post:4411: Temporary link failure",
        color: 'yellow',
        autoClose: false,
      })
    );
    expect(screen.getByText('Change 2 of 2')).toBeInTheDocument();
    expect(screen.queryByText('Add a note')).not.toBeInTheDocument();
  });

  it('with several matches, the note can go to another one', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'x' }) });
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Add as a note there instead' }));
    fireEvent.click(screen.getByRole('radio', { name: '#task-cop Offer page copy (Acme Solar)' }));
    expect(screen.getByTestId('voice-note-preview')).toHaveTextContent(
      'Note on \u201cOffer page copy\u201d'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply and next' }));
    await screen.findByText('Order inverter brackets');
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/projects/task-copy/updates`);
  });

  it('switching off again goes back to creating the task', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'x' }) });
    render(<ReviewChangesPage />);
    const toggle = await screen.findByRole('switch', { name: 'Add as a note there instead' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByText('New task')).toBeInTheDocument();
    expect(screen.queryByTestId('voice-note-preview')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply and next' }));
    await screen.findByText('Order inverter brackets');
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/projects`);
  });

  it('a skipped change with the switch on writes nothing', async () => {
    render(<ReviewChangesPage />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Add as a note there instead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await screen.findByText('Order inverter brackets');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
