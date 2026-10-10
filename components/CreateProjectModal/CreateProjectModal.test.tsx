import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils/render';
import { CreateProjectModal } from './CreateProjectModal';

jest.mock('../../app/hooks/useEpicQueries', () => ({
  useEpics: () => ({ data: [] }),
}));
jest.mock('../../app/hooks/useGoalQueries', () => ({
  useGoals: () => ({ data: [] }),
}));
jest.mock('../../app/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ userId: 'user-avery', user: { id: 'user-avery', name: 'Avery Reed' } }),
}));

const personalProject = {
  value: 'proj-personal',
  label: 'Personal tasks',
  projectName: 'Personal tasks',
  orgId: 'org-avery',
  orgLabel: 'Personal',
  isShared: false,
  canEdit: true,
};
const sharedProject = {
  value: 'proj-installation',
  label: 'Installation',
  projectName: 'Installation',
  orgId: 'org-acme',
  orgLabel: 'Acme Solar',
  isShared: true,
  canEdit: true,
};
// A workspace where I'm only a viewer: its tasks can be opened but not added to
const viewerProject = {
  value: 'proj-board',
  label: 'Board papers',
  projectName: 'Board papers',
  orgId: 'org-harbour',
  orgLabel: 'Harbour Services',
  isShared: true,
  canEdit: false,
};
const projectOptions = [personalProject, sharedProject, viewerProject];

jest.mock('../../app/hooks/useWorkspaces', () => ({
  useWorkspaceProjects: () => ({
    workspaces: [],
    projectOptions,
    // View-only workspaces never make it into the picker
    editableProjectGroups: [
      { group: 'Personal', items: [{ value: 'proj-personal', label: 'Personal tasks' }] },
      {
        group: 'Acme Solar (shared)',
        items: [{ value: 'proj-installation', label: 'Installation' }],
      },
    ],
    findProject: (id: string | null) => projectOptions.find((p) => p.value === id) ?? null,
    hasSharedWorkspace: true,
    isLoading: false,
  }),
}));

jest.mock('../../app/hooks/useOrganisationQueries', () => ({
  useOrganisationMembers: () => ({
    data: [
      { id: 'm1', orgId: 'org-acme', userId: 'user-avery', userName: 'Avery Reed', role: 'owner' },
      {
        id: 'm2',
        orgId: 'org-acme',
        userId: 'user-robin',
        userName: 'Robin Fairweather',
        role: 'member',
      },
    ],
    isLoading: false,
  }),
}));

// Every test answers the API from here, so none of them reach the network
const API = 'https://worker.example.com/api/v2';
const originalFetch = global.fetch;
/** The list waits for a pause in typing, and this machine may be busy */
const LIST_TIMEOUT = { timeout: 5000 };

const brokenOfferPage = {
  id: 'task-3f2a',
  shortId: '3f2a91c0',
  title: 'Broken offer page',
  status: 'do',
  projectId: 'proj-installation',
  projectName: 'Installation',
  orgId: sharedProject.orgId,
  orgName: sharedProject.orgLabel,
  assigneeId: 'user-robin',
  assigneeName: 'Robin Fairweather',
  score: 0.67,
  canEdit: true,
  matchedRef: false,
};
const offerMinutes = {
  ...brokenOfferPage,
  id: 'task-77b0',
  shortId: '77b0c2d1',
  title: 'Offer page in the minutes',
  projectId: 'proj-board',
  projectName: 'Board papers',
  orgId: viewerProject.orgId,
  orgName: viewerProject.orgLabel,
  assigneeId: null,
  assigneeName: null,
  score: 0.5,
  canEdit: false,
};

let similarAnswer: unknown[];

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
/** Paste rather than type, one event instead of one per letter, for tests about other things */
async function typeQuickly(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string
) {
  await user.click(field);
  await user.paste(text);
}

const calls = (match: RegExp) =>
  (global.fetch as jest.Mock).mock.calls.filter(([url]) => match.test(String(url)));

beforeEach(() => {
  process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
  similarAnswer = [];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/tasks/similar')) {
      return json(200, similarAnswer);
    }
    if (url.endsWith('/updates') && init?.method === 'POST') {
      return json(201, { id: 'note-1', note: JSON.parse(String(init.body)).note });
    }
    if (url.endsWith('/refs') && init?.method === 'POST') {
      return json(201, { id: 'ref-1', existing: false });
    }
    return json(404, { error: 'Not found' });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('CreateProjectModal', () => {
  it('renders the form correctly and calls onSave with form data', async () => {
    const user = userEvent.setup();
    const handleSave = jest.fn();
    const handleClose = jest.fn();

    render(<CreateProjectModal opened onClose={handleClose} onSave={handleSave} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'New Test Project');
    await typeQuickly(user, screen.getByLabelText(/reason/i), 'A very good reason');
    await user.click(screen.getByLabelText('Delay'));
    await user.click(screen.getByRole('button', { name: /create task/i }));

    // No project picked: nothing about projects or assignees is sent
    expect(handleSave).toHaveBeenCalledWith({
      project: 'New Test Project',
      reason: 'A very good reason',
      status: 'delay',
      priority: 5,
      size: '***',
      awaitUntil: null,
      notes: '',
    });
    expect(handleClose).toHaveBeenCalled();
  });

  it('does not submit an awaiting task without a return date', async () => {
    const user = userEvent.setup();
    const handleSave = jest.fn();

    render(<CreateProjectModal opened onClose={jest.fn()} onSave={handleSave} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Awaiting without date');
    await typeQuickly(user, screen.getByLabelText(/reason/i), 'Needs a return date');
    await user.click(screen.getByLabelText('Awaiting'));
    await user.click(screen.getByRole('button', { name: /create task/i }));

    expect(handleSave).not.toHaveBeenCalled();
  });

  it('shows validation errors for required fields', async () => {
    const handleSave = jest.fn();

    render(<CreateProjectModal opened onClose={jest.fn()} onSave={handleSave} />);

    // Submit directly: the browser's own "required" check would otherwise stop the submit
    fireEvent.submit(screen.getByRole('button', { name: /create task/i }).closest('form')!);

    expect(await screen.findByText('Task name is required')).toBeInTheDocument();
    expect(screen.getByLabelText(/task name/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/reason/i)).toHaveAttribute('aria-invalid', 'true');
    expect(handleSave).not.toHaveBeenCalled();
  });

  it('offers projects grouped by workspace and only asks for an assignee in shared ones', async () => {
    const user = userEvent.setup();
    const handleSave = jest.fn();

    render(<CreateProjectModal opened onClose={jest.fn()} onSave={handleSave} />);

    // Personal project: no assignee picker, task stays mine by default
    await user.click(screen.getByRole('textbox', { name: /^project/i }));
    expect(await screen.findByText('Acme Solar (shared)')).toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Personal tasks' }));
    expect(screen.queryByRole('textbox', { name: /assignee/i })).not.toBeInTheDocument();

    // Shared project: assignee picker appears, defaulting to me
    await user.click(screen.getByRole('textbox', { name: /^project/i }));
    await user.click(await screen.findByRole('option', { name: 'Installation' }));
    const assignee = screen.getByRole('textbox', { name: /assignee/i });
    expect(assignee).toHaveValue('You (Avery Reed)');

    await user.click(assignee);
    await user.click(await screen.findByRole('option', { name: /robin fairweather/i }));

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Check inverter stock');
    await typeQuickly(user, screen.getByLabelText(/reason/i), 'Install next week');
    await user.click(screen.getByRole('button', { name: /create task/i }));

    expect(handleSave).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'Check inverter stock',
        projectId: 'proj-installation',
        assigneeId: 'user-robin',
      })
    );
  });

  it('sends pasted links as refs, one per line, with a live preview', async () => {
    const user = userEvent.setup();
    const handleSave = jest.fn();

    render(<CreateProjectModal opened onClose={jest.fn()} onSave={handleSave} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Broken offer page');
    await typeQuickly(user, screen.getByLabelText(/reason/i), 'Members cannot post offers');
    await typeQuickly(
      user,
      screen.getByTestId('create-links-input'),
      'https://github.com/acme/widgets/issues/12\n\nacme.member:123456\ngithub.issue:acme/widgets#12'
    );

    const preview = screen.getByTestId('create-links-preview');
    expect(preview).toHaveTextContent('GitHub issue acme/widgets#12');
    expect(preview).toHaveTextContent('acme.member:123456');

    await user.click(screen.getByRole('button', { name: /create task/i }));

    // Blank lines are skipped and the same issue written two ways is sent once
    expect(handleSave).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'Broken offer page',
        refs: [{ ref: 'https://github.com/acme/widgets/issues/12' }, { ref: 'acme.member:123456' }],
      })
    );
  });

  it('will not create the task while a link line cannot be read', async () => {
    const user = userEvent.setup();
    const handleSave = jest.fn();

    render(<CreateProjectModal opened onClose={jest.fn()} onSave={handleSave} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Broken offer page');
    await typeQuickly(user, screen.getByLabelText(/reason/i), 'Members cannot post offers');
    await typeQuickly(
      user,
      screen.getByTestId('create-links-input'),
      'forum.post:4411\nnot a link'
    );

    expect(screen.getByText(/^Line 2: Can't tell what that is/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create task/i }));

    expect(handleSave).not.toHaveBeenCalled();
    expect(await screen.findByText('Fix or remove the lines marked in red')).toBeInTheDocument();
  });
});

describe('CreateProjectModal similar tasks', () => {
  beforeEach(() => {
    similarAnswer = [brokenOfferPage, offerMinutes];
  });

  it('keeps the create button outside a fixed-height scrolling body', () => {
    render(<CreateProjectModal opened onClose={jest.fn()} onSave={jest.fn()} />);

    const body = screen.getByTestId('create-form-body');
    expect(body.style.height).toBeTruthy();
    expect(body).not.toContainElement(screen.getByRole('button', { name: /create task/i }));
  });

  it('lists similar open tasks under the title once two words are typed, and hides them again', async () => {
    const user = userEvent.setup();
    render(<CreateProjectModal opened onClose={jest.fn()} onSave={jest.fn()} />);
    const title = screen.getByLabelText(/task name/i);

    await typeQuickly(user, title, 'Fix the offer page');
    const list = await screen.findByTestId('similar-tasks', {}, LIST_TIMEOUT);
    expect(list).toHaveTextContent('Similar open tasks');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('#3f2a91c0');
    expect(rows[0]).toHaveTextContent('Broken offer page');
    expect(rows[0]).toHaveTextContent('Installation · Robin Fairweather');
    expect(rows[1]).toHaveTextContent('Board papers · Unassigned');

    // Asked once, after the pause, not once per keystroke
    expect(calls(/\/tasks\/similar/)).toHaveLength(1);
    expect(new URL(calls(/\/tasks\/similar/)[0][0]).searchParams.get('title')).toBe(
      'Fix the offer page'
    );

    // Open goes to the task; viewers can't add a note, so only Open is offered there
    expect(within(rows[0]).getByRole('link', { name: /open #3f2a91c0/i })).toHaveAttribute(
      'href',
      '/tasks/task-3f2a'
    );
    expect(
      within(rows[0]).getByRole('button', { name: /add a note there instead/i })
    ).toBeVisible();
    expect(within(rows[1]).queryByRole('button', { name: /add a note there instead/i })).toBeNull();

    // The list lives in the scrolling body; the Create button sits below it and never moves
    const body = screen.getByTestId('create-form-body');
    expect(body).toContainElement(list);
    expect(body).not.toContainElement(screen.getByRole('button', { name: /create task/i }));

    // Cut back to one word: the list goes at once
    await user.clear(title);
    await user.type(title, 'Offer');
    expect(screen.queryByTestId('similar-tasks')).not.toBeInTheDocument();
  });

  it('shows nothing when there are no matches', async () => {
    similarAnswer = [];
    const user = userEvent.setup();
    render(<CreateProjectModal opened onClose={jest.fn()} onSave={jest.fn()} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Order inverter stock');
    await waitFor(() => expect(calls(/\/tasks\/similar/)).toHaveLength(1), LIST_TIMEOUT);
    expect(screen.queryByTestId('similar-tasks')).not.toBeInTheDocument();
    expect(screen.queryByText('Similar open tasks')).not.toBeInTheDocument();
  });

  it('adds a note to the existing task instead of creating one', async () => {
    const user = userEvent.setup();
    const handleSave = jest.fn();
    const handleClose = jest.fn();
    render(<CreateProjectModal opened onClose={handleClose} onSave={handleSave} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Fix the offer page');
    await typeQuickly(user, screen.getByLabelText(/reason/i), 'Members cannot post offers');
    await typeQuickly(user, screen.getByTestId('create-links-input'), 'acme.member:123456');
    const list = await screen.findByTestId('similar-tasks', {}, LIST_TIMEOUT);
    await user.click(within(list).getAllByRole('button', { name: /add a note there instead/i })[0]);

    // The modal is now a note form for that task, carrying what was typed
    expect(screen.getByText('Add a note instead')).toBeInTheDocument();
    const form = screen.getByTestId('note-instead-form');
    expect(form).toHaveTextContent('#3f2a91c0');
    expect(form).toHaveTextContent('Broken offer page');
    expect(form).toHaveTextContent('Installation · Robin Fairweather');
    expect(form).toHaveTextContent('Your link will be added to that task as well.');
    const note = within(form).getByLabelText(/^note/i);
    expect(note).toHaveValue('Fix the offer page\nMembers cannot post offers');
    expect(note).toHaveFocus();

    await user.type(note, '{Enter}Seen on the members page too');
    await user.click(within(form).getByRole('button', { name: 'Add note' }));

    await waitFor(() => expect(handleClose).toHaveBeenCalled());
    const [noteCall] = calls(/\/projects\/task-3f2a\/updates$/);
    expect(JSON.parse(String(noteCall[1].body))).toEqual({
      note: 'Fix the offer page\nMembers cannot post offers\nSeen on the members page too',
    });
    // The typed link goes to that task too, and no task is created
    const [refCall] = calls(/\/tasks\/task-3f2a\/refs$/);
    expect(JSON.parse(String(refCall[1].body))).toEqual({ ref: 'acme.member:123456' });
    expect(handleSave).not.toHaveBeenCalled();
  });

  it('goes back to the new task form as it was', async () => {
    const user = userEvent.setup();
    const handleSave = jest.fn();
    render(<CreateProjectModal opened onClose={jest.fn()} onSave={handleSave} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Fix the offer page');
    await typeQuickly(user, screen.getByLabelText(/reason/i), 'Members cannot post offers');
    const list = await screen.findByTestId('similar-tasks', {}, LIST_TIMEOUT);
    await user.click(within(list).getAllByRole('button', { name: /add a note there instead/i })[0]);
    await user.click(screen.getByRole('button', { name: /back to new task/i }));

    expect(screen.getByText('New task')).toBeInTheDocument();
    expect(screen.getByLabelText(/task name/i)).toHaveValue('Fix the offer page');
    expect(screen.getByLabelText(/task name/i)).toHaveFocus();
    expect(screen.getByLabelText(/reason/i)).toHaveValue('Members cannot post offers');
    expect(calls(/\/updates$/)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /create task/i }));
    expect(handleSave).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'Fix the offer page' })
    );
  });

  it('keeps the note form open when the note cannot be added', async () => {
    const user = userEvent.setup();
    const handleClose = jest.fn();
    render(<CreateProjectModal opened onClose={handleClose} onSave={jest.fn()} />);
    (global.fetch as jest.Mock).mockImplementation(async (url: string) =>
      url.includes('/tasks/similar')
        ? json(200, [brokenOfferPage])
        : json(403, { error: 'You have view-only access to "Acme Solar"' })
    );

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Fix the offer page');
    const list = await screen.findByTestId('similar-tasks', {}, LIST_TIMEOUT);
    await user.click(within(list).getByRole('button', { name: /add a note there instead/i }));
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    await waitFor(() => expect(calls(/\/updates$/)).toHaveLength(1));
    expect(screen.getByTestId('note-instead-form')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeEnabled();
    expect(handleClose).not.toHaveBeenCalled();
  });

  it('retries only failed links after the note has been saved', async () => {
    const user = userEvent.setup();
    const handleClose = jest.fn();
    const handleSave = jest.fn();
    let failedOnce = false;
    (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/tasks/similar')) {
        return json(200, [brokenOfferPage]);
      }
      if (url.endsWith('/updates')) {
        return json(201, { id: 'note-1' });
      }
      const input = JSON.parse(String(init?.body));
      if (input.ref === 'forum.post:4411' && !failedOnce) {
        failedOnce = true;
        return json(503, { error: 'Temporary link failure' });
      }
      return json(201, { id: 'ref-1' });
    });
    render(<CreateProjectModal opened onClose={handleClose} onSave={handleSave} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Fix the offer page');
    await typeQuickly(
      user,
      screen.getByTestId('create-links-input'),
      'forum.post:4411\nacme.member:123456'
    );
    const list = await screen.findByTestId('similar-tasks', {}, LIST_TIMEOUT);
    await user.click(within(list).getByRole('button', { name: /add a note there instead/i }));
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    const retry = await screen.findByRole('button', { name: 'Retry missing links' });
    expect(handleClose).not.toHaveBeenCalled();
    expect(calls(/\/updates$/)).toHaveLength(1);
    expect(screen.getByLabelText(/^note/i)).toHaveAttribute('readonly');
    const form = screen.getByTestId('note-instead-form');
    expect(form).toHaveTextContent('Your note is saved. 1 link still needs adding.');
    expect(form).toHaveTextContent('forum.post:4411');
    expect(form).not.toHaveTextContent('acme.member:123456');
    expect(screen.queryByRole('button', { name: /back to new task/i })).not.toBeInTheDocument();

    await user.click(retry);
    await waitFor(() => expect(handleClose).toHaveBeenCalledTimes(1));
    expect(calls(/\/updates$/)).toHaveLength(1);
    expect(calls(/\/refs$/).map(([, init]) => JSON.parse(String(init.body)).ref)).toEqual([
      'forum.post:4411',
      'acme.member:123456',
      'forum.post:4411',
    ]);
    expect(handleSave).not.toHaveBeenCalled();
  });

  it('can finish a saved note without retrying its failed links', async () => {
    const user = userEvent.setup();
    const handleClose = jest.fn();
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('/tasks/similar')) {
        return json(200, [brokenOfferPage]);
      }
      return url.endsWith('/updates')
        ? json(201, { id: 'note-1' })
        : json(503, { error: 'Temporary link failure' });
    });
    render(<CreateProjectModal opened onClose={handleClose} onSave={jest.fn()} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Fix the offer page');
    await typeQuickly(user, screen.getByTestId('create-links-input'), 'forum.post:4411');
    const list = await screen.findByTestId('similar-tasks', {}, LIST_TIMEOUT);
    await user.click(within(list).getByRole('button', { name: /add a note there instead/i }));
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));

    expect(handleClose).toHaveBeenCalledTimes(1);
    expect(calls(/\/updates$/)).toHaveLength(1);
    expect(calls(/\/refs$/)).toHaveLength(1);
  });

  it('cannot close the modal while the saved note links are in flight', async () => {
    const user = userEvent.setup();
    const handleClose = jest.fn();
    let finishRef!: (response: ReturnType<typeof json>) => void;
    const pendingRef = new Promise<ReturnType<typeof json>>((resolve) => {
      finishRef = resolve;
    });
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('/tasks/similar')) {
        return json(200, [brokenOfferPage]);
      }
      return url.endsWith('/updates') ? json(201, { id: 'note-1' }) : pendingRef;
    });
    render(<CreateProjectModal opened onClose={handleClose} onSave={jest.fn()} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Fix the offer page');
    await typeQuickly(user, screen.getByTestId('create-links-input'), 'forum.post:4411');
    const list = await screen.findByTestId('similar-tasks', {}, LIST_TIMEOUT);
    await user.click(within(list).getByRole('button', { name: /add a note there instead/i }));
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(calls(/\/refs$/)).toHaveLength(1));
    try {
      await user.keyboard('{Escape}');
      expect(handleClose).not.toHaveBeenCalled();
    } finally {
      await act(async () => finishRef(json(201, { id: 'ref-1' })));
    }
    await waitFor(() => expect(handleClose).toHaveBeenCalledTimes(1));
  });

  it('opens a similar task and keeps the draft for later', async () => {
    const user = userEvent.setup();
    const handleClose = jest.fn();
    const handleSave = jest.fn();
    const { rerender } = render(
      <CreateProjectModal opened onClose={handleClose} onSave={handleSave} />
    );

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Fix the offer page');
    const list = await screen.findByTestId('similar-tasks', {}, LIST_TIMEOUT);
    // jsdom can't navigate; the link's href is checked in the first test
    const stopNavigation = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('click', stopNavigation);
    await user.click(within(list).getByRole('link', { name: /open #3f2a91c0/i }));
    window.removeEventListener('click', stopNavigation);

    expect(handleClose).toHaveBeenCalled();
    expect(handleSave).not.toHaveBeenCalled();
    rerender(<CreateProjectModal opened={false} onClose={handleClose} onSave={handleSave} />);
    rerender(<CreateProjectModal opened onClose={handleClose} onSave={handleSave} />);
    expect(await screen.findByLabelText(/task name/i)).toHaveValue('Fix the offer page');
  });

  it('will not add an empty note', async () => {
    const user = userEvent.setup();
    render(<CreateProjectModal opened onClose={jest.fn()} onSave={jest.fn()} />);

    await typeQuickly(user, screen.getByLabelText(/task name/i), 'Fix the offer page');
    const list = await screen.findByTestId('similar-tasks', {}, LIST_TIMEOUT);
    await user.click(within(list).getAllByRole('button', { name: /add a note there instead/i })[0]);
    await user.clear(screen.getByLabelText(/^note/i));
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(await screen.findByText('Write the note to add')).toBeInTheDocument();
    expect(calls(/\/updates$/)).toHaveLength(0);
  });
});
