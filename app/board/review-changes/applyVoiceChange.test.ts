import type { VoiceProposal } from '../../../components/VoiceCommand/voiceTypes';
import {
  applyAsNote,
  applyVoiceChange,
  newApplySession,
  noteTextFor,
  similarOf,
  VoiceApplyError,
  type VoiceProposalWithRefs,
  type VoiceProposalWithSimilar,
} from './applyVoiceChange';

const API = 'https://worker.example.com/api/v2';
const fetchMock = jest.fn();
global.fetch = fetchMock as any;

const ok = (body: unknown = {}) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });
const fail = (status: number, body: unknown) =>
  Promise.resolve({ ok: false, status, json: async () => body });

function calls() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init.method,
    body: init.body ? JSON.parse(init.body) : undefined,
  }));
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
}

const before = {
  id: 'task-1',
  userId: 'alex',
  project: 'Acme Solar onboarding',
  status: 'do' as const,
  priority: 7,
  size: '**' as const,
  projectId: 'proj-acme',
  projectName: 'Acme',
  assigneeId: null,
  assigneeName: null,
  epicId: null,
  isDeleted: false,
  createdAt: '',
  updatedAt: '',
};

describe('applyVoiceChange', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
  });

  it('creates a task with the resolved projectId, assigneeId and epicId', async () => {
    fetchMock.mockReturnValue(ok({ id: 'new' }));
    const change: VoiceProposal = {
      type: 'create',
      before: null,
      after: {
        project: 'Check inverter datasheet',
        status: 'do',
        priority: 6,
        size: '*',
        notes: null as any,
      },
      projectId: 'proj-acme',
      projectName: 'Acme',
      orgName: 'Acme',
      assigneeId: 'robin',
      assigneeName: 'Robin Fairweather',
      epicId: 'epic-acme',
    };
    const outcome = await applyVoiceChange(change, 'tok', newApplySession(), 'alex');
    expect(lastCall()).toEqual({
      url: `${API}/projects`,
      method: 'POST',
      body: {
        project: 'Check inverter datasheet',
        status: 'do',
        priority: 6,
        size: '*',
        projectId: 'proj-acme',
        assigneeId: 'robin',
        epicId: 'epic-acme',
      },
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(outcome.message).toBe('Added "Check inverter datasheet" in Acme for Robin Fairweather');
  });

  it('sends assigneeId null for an unassigned task, and the category for a new project', async () => {
    fetchMock.mockReturnValue(ok());
    await applyVoiceChange(
      {
        type: 'create',
        before: null,
        after: { project: 'Plan the garden', status: 'awaiting' },
        projectId: null,
        projectName: 'Allotment',
        isNewProject: true,
        assigneeId: null,
      },
      'tok',
      newApplySession()
    );
    const { body } = lastCall();
    expect(body.assigneeId).toBeNull();
    expect(body.category).toBe('Allotment');
    expect(body.projectId).toBeUndefined();
    // Awaiting always needs a date: falls back to 30 days out
    expect(body.awaitUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('links tasks to epics and projects created earlier in the same review', async () => {
    const session = newApplySession();
    fetchMock.mockReturnValueOnce(ok({ id: 'proj-new' }));
    await applyVoiceChange(
      {
        type: 'createProject',
        before: null,
        after: { project: 'Hydrogen' },
        orgId: 'org-acme',
        orgName: 'Acme',
        projectName: 'Hydrogen',
        isNewProject: true,
      },
      'tok',
      session
    );
    expect(lastCall()).toEqual({
      url: `${API}/organisations/org-acme/projects`,
      method: 'POST',
      body: { name: 'Hydrogen' },
    });

    fetchMock.mockReturnValueOnce(ok({ id: 'epic-new' }));
    await applyVoiceChange(
      {
        type: 'createEpic',
        before: null,
        after: { project: 'Pilot' },
        projectId: null,
        projectName: 'Hydrogen',
        isNewProject: true,
      },
      'tok',
      session
    );
    expect(lastCall().body).toEqual({ title: 'Pilot', status: 'active', projectId: 'proj-new' });

    fetchMock.mockReturnValueOnce(ok());
    await applyVoiceChange(
      {
        type: 'create',
        before: null,
        after: { project: 'Call supplier' },
        projectId: null,
        projectName: 'Hydrogen',
        isNewProject: true,
        epicTitle: 'pilot',
      },
      'tok',
      session
    );
    expect(lastCall().body).toMatchObject({ projectId: 'proj-new', epicId: 'epic-new' });
  });

  it('updates only what changed, and reassigns with PUT', async () => {
    fetchMock.mockReturnValue(ok());
    await applyVoiceChange(
      {
        type: 'update',
        before: before as any,
        after: { project: 'Acme Solar onboarding', status: 'done', priority: 7, size: '**' },
        taskId: 'task-1',
        projectId: 'proj-acme',
        assigneeId: 'robin',
        assigneeChanged: true,
      },
      'tok',
      newApplySession()
    );
    const { url, method, body } = lastCall();
    expect(url).toBe(`${API}/projects/task-1`);
    expect(method).toBe('PUT');
    // Only the changed fields go to the API
    expect(body).toEqual({ status: 'done', assigneeId: 'robin' });
  });

  it('moves a task by projectId and leaves the assignee alone when unchanged', async () => {
    fetchMock.mockReturnValue(ok());
    await applyVoiceChange(
      {
        type: 'update',
        before: before as any,
        after: { project: 'Acme Solar onboarding', status: 'do' },
        taskId: 'task-1',
        projectId: 'proj-personal',
      },
      'tok',
      newApplySession()
    );
    expect(lastCall().body).toEqual({ projectId: 'proj-personal' });
  });

  it('makes no call when nothing changed', async () => {
    const outcome = await applyVoiceChange(
      {
        type: 'update',
        before: before as any,
        after: { project: 'Acme Solar onboarding', status: 'do', priority: 7 },
        taskId: 'task-1',
        projectId: 'proj-acme',
      },
      'tok',
      newApplySession()
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.message).toBe('"Acme Solar onboarding" was already up to date');
  });

  it('claims with PUT { assigneeId: me }', async () => {
    fetchMock.mockReturnValue(ok());
    const outcome = await applyVoiceChange(
      { type: 'claim', before: before as any, after: null, taskId: 'task-1', assigneeId: 'alex' },
      'tok',
      newApplySession(),
      'alex'
    );
    expect(lastCall()).toEqual({
      url: `${API}/projects/task-1`,
      method: 'PUT',
      body: { assigneeId: 'alex' },
    });
    expect(outcome.message).toBe('"Acme Solar onboarding" is yours now');
  });

  it('deletes with DELETE', async () => {
    fetchMock.mockReturnValue(ok());
    await applyVoiceChange(
      { type: 'delete', before: before as any, after: null, taskId: 'task-1' },
      'tok',
      newApplySession()
    );
    expect(lastCall()).toEqual({
      url: `${API}/projects/task-1`,
      method: 'DELETE',
      body: undefined,
    });
  });

  it("throws the API's own message on 403", async () => {
    fetchMock.mockReturnValue(fail(403, { error: 'You have view-only access to "Acme"' }));
    const promise = applyVoiceChange(
      { type: 'claim', before: before as any, after: null, taskId: 'task-1', assigneeId: 'alex' },
      'tok',
      newApplySession()
    );
    await expect(promise).rejects.toBeInstanceOf(VoiceApplyError);
    await expect(promise).rejects.toMatchObject({
      status: 403,
      message: 'You have view-only access to "Acme"',
    });
  });

  it('gives a readable message when the API sends none', async () => {
    fetchMock.mockReturnValue(fail(400, { success: false, error: { issues: [] } }));
    await expect(
      applyVoiceChange(
        { type: 'create', before: null, after: { project: 'X' } },
        'tok',
        newApplySession()
      )
    ).rejects.toMatchObject({ message: `Couldn't add "X": some of the details weren't valid.` });
  });

  describe('links', () => {
    const issue = {
      ref: 'github.issue:acme/widgets#12',
      role: 'link' as const,
      kind: 'github.issue',
      url: 'https://github.com/acme/widgets/issues/12',
      label: 'GitHub issue acme/widgets#12',
    };
    const reporter = { ref: 'acme.member:4411', role: 'reported_by' as const };
    const source = { ref: 'forum.post:4411', role: 'source' as const };
    const sentry = {
      ref: 'sentry.issue:123456',
      role: 'link' as const,
      kind: 'sentry.issue',
      url: 'https://acme.sentry.io/issues/123456/',
      label: 'Offer form failure',
    };

    it.each(['create', 'update'] as const)(
      'preserves resolved URL and label metadata when applying a %s',
      async (type) => {
        fetchMock.mockReturnValue(ok({ id: 'task-new', created: true }));
        await applyVoiceChange(
          {
            type,
            before: type === 'update' ? (before as any) : null,
            after: { project: before.project, status: before.status },
            taskId: type === 'update' ? before.id : undefined,
            projectId: before.projectId,
            refs: [sentry],
          },
          'tok',
          newApplySession()
        );
        expect(calls()).toHaveLength(1);
        const expected = {
          ref: sentry.ref,
          role: sentry.role,
          url: sentry.url,
          label: sentry.label,
        };
        expect(type === 'create' ? lastCall().body.refs : [lastCall().body]).toEqual([expected]);
      }
    );

    it('creates the task with its selected refs atomically and does not add them afterwards', async () => {
      fetchMock.mockReturnValue(ok({ id: 'task-new', created: true }));
      const change: VoiceProposalWithRefs = {
        type: 'create',
        before: null,
        after: { project: 'Fix the offer form', status: 'do', priority: 5, size: '***' },
        projectId: 'proj-acme',
        projectName: 'Acme',
        refs: [issue, reporter, source],
      };
      const outcome = await applyVoiceChange(change, 'tok', newApplySession(), 'alex');
      expect(calls()).toEqual([
        {
          url: `${API}/projects`,
          method: 'POST',
          body: {
            project: 'Fix the offer form',
            status: 'do',
            priority: 5,
            size: '***',
            projectId: 'proj-acme',
            refs: [
              {
                ref: 'github.issue:acme/widgets#12',
                role: 'link',
                url: issue.url,
                label: issue.label,
              },
              { ref: 'acme.member:4411', role: 'reported_by' },
              { ref: 'forum.post:4411', role: 'source' },
            ],
          },
        },
      ]);
      // The API's default onDuplicate policy is error.
      expect(calls()[0].body.onDuplicate).toBeUndefined();
      expect(outcome).toEqual({
        message: 'Added "Fix the offer form" in Acme (3 links added)',
        problems: [],
      });
    });

    it('surfaces a structured source conflict and the existing task without retrying refs', async () => {
      fetchMock.mockReturnValue(
        fail(409, {
          error: 'forum.post:4411 is already the source of 3f2a91c0 "Broken offer page"',
          taskId: '3f2a91c0-0000-0000-0000-000000000000',
          task: {
            id: '3f2a91c0-0000-0000-0000-000000000000',
            project: 'Broken offer page',
            projectName: 'Acme',
            canEdit: true,
          },
        })
      );
      const change: VoiceProposalWithRefs = {
        type: 'create',
        before: null,
        after: { project: 'Fix the offer form' },
        projectId: 'proj-acme',
        refs: [source],
      };

      await expect(applyVoiceChange(change, 'tok', newApplySession())).rejects.toMatchObject({
        status: 409,
        message: 'forum.post:4411 is already the source of 3f2a91c0 "Broken offer page"',
        existingTask: {
          id: '3f2a91c0-0000-0000-0000-000000000000',
          shortId: '3f2a91c0',
          title: 'Broken offer page',
          projectName: 'Acme',
          canEdit: true,
        },
      });
      expect(calls()).toEqual([
        {
          url: `${API}/projects`,
          method: 'POST',
          body: expect.objectContaining({ refs: [{ ref: 'forum.post:4411', role: 'source' }] }),
        },
      ]);
    });

    it('does not report a created task when the API returns created false', async () => {
      fetchMock.mockReturnValue(
        ok({
          id: '3f2a91c0-0000-0000-0000-000000000000',
          project: 'Broken offer page',
          projectName: 'Acme',
          created: false,
        })
      );
      const change: VoiceProposalWithRefs = {
        type: 'create',
        before: null,
        after: { project: 'Fix the offer form' },
        projectId: 'proj-acme',
        refs: [source],
      };

      await expect(applyVoiceChange(change, 'tok', newApplySession())).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('No new task was created'),
        existingTask: {
          id: '3f2a91c0-0000-0000-0000-000000000000',
          shortId: '3f2a91c0',
          title: 'Broken offer page',
        },
      });
      expect(calls()).toHaveLength(1);
      expect(calls()[0].url).toBe(`${API}/projects`);
    });

    it('updates the task, then removes and adds links with URL-encoded refs', async () => {
      fetchMock.mockReturnValue(ok());
      const change: VoiceProposalWithRefs = {
        type: 'update',
        before: before as any,
        after: { project: 'Acme Solar onboarding', status: 'done', priority: 7, size: '**' },
        taskId: 'task-1',
        projectId: 'proj-acme',
        refs: [reporter],
        removeRefs: [
          { ref: 'github.issue:acme/widgets#12', role: 'link' },
          { ref: 'forum.post:4411', role: null },
        ],
      };
      const outcome = await applyVoiceChange(change, 'tok', newApplySession());
      expect(calls().map((c) => [c.method, c.url])).toEqual([
        ['PUT', `${API}/projects/task-1`],
        ['DELETE', `${API}/tasks/task-1/refs?ref=github.issue%3Aacme%2Fwidgets%2312&role=link`],
        ['DELETE', `${API}/tasks/task-1/refs?ref=forum.post%3A4411`],
        ['POST', `${API}/tasks/task-1/refs`],
      ]);
      expect(outcome.message).toBe('Updated "Acme Solar onboarding" (1 link added, 2 removed)');
    });

    it('changes only the links when nothing else changed', async () => {
      fetchMock.mockReturnValue(ok());
      const outcome = await applyVoiceChange(
        {
          type: 'update',
          before: before as any,
          after: { project: 'Acme Solar onboarding', status: 'do', priority: 7 },
          taskId: 'task-1',
          projectId: 'proj-acme',
          refs: [issue],
        } as VoiceProposalWithRefs,
        'tok',
        newApplySession()
      );
      expect(calls().map((c) => c.method)).toEqual(['POST']);
      expect(outcome.message).toBe('Updated the links on "Acme Solar onboarding" (1 link added)');
    });

    it('reports a link that fails without undoing the task change, and ignores one already gone', async () => {
      fetchMock
        .mockReturnValueOnce(ok())
        .mockReturnValueOnce(fail(404, { error: "That link isn't on this task" }))
        .mockReturnValueOnce(
          fail(409, {
            error: 'forum.post:4411 is already the source of 3f2a91c0 "Broken offer page"',
            taskId: '3f2a91c0-0000',
          })
        )
        .mockReturnValueOnce(fail(500, {}));
      const outcome = await applyVoiceChange(
        {
          type: 'update',
          before: before as any,
          after: { project: 'Acme Solar onboarding', status: 'done' },
          taskId: 'task-1',
          projectId: 'proj-acme',
          removeRefs: [{ ref: 'github.issue:acme/widgets#12', role: 'link' }],
          refs: [{ ref: 'forum.post:4411', role: 'source' }, reporter],
        } as VoiceProposalWithRefs,
        'tok',
        newApplySession()
      );
      expect(outcome).toEqual({
        message: 'Updated "Acme Solar onboarding"',
        problems: [
          'forum.post:4411 is already the source of 3f2a91c0 "Broken offer page"',
          "Couldn't link acme.member:4411",
        ],
      });
    });

    it('adds no links when the task change fails', async () => {
      fetchMock.mockReturnValue(fail(403, { error: 'You have view-only access to "Acme"' }));
      await expect(
        applyVoiceChange(
          {
            type: 'update',
            before: before as any,
            after: { project: 'Acme Solar onboarding', status: 'done' },
            taskId: 'task-1',
            refs: [issue],
          } as VoiceProposalWithRefs,
          'tok',
          newApplySession()
        )
      ).rejects.toMatchObject({ status: 403 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never touches links on a delete', async () => {
      fetchMock.mockReturnValue(ok());
      await applyVoiceChange(
        {
          type: 'delete',
          before: before as any,
          after: null,
          taskId: 'task-1',
          refs: [issue],
        } as VoiceProposalWithRefs,
        'tok',
        newApplySession()
      );
      expect(calls().map((c) => c.method)).toEqual(['DELETE']);
    });
  });
});

describe('adding a new task as a note on an existing one', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
  });

  const target = {
    id: 'task-offer',
    shortId: 'task-off',
    title: 'Broken offer page',
    projectName: 'Acme',
    orgName: 'Acme',
    assigneeName: 'Robin Fairweather',
  };

  const change: VoiceProposalWithSimilar = {
    type: 'create',
    before: null,
    after: {
      project: 'Fix the offer page',
      reason: "Members can't book",
      notes: '  Seen on the forum  ',
      status: 'do',
      priority: 8,
      size: '**',
    },
    projectId: 'proj-acme',
    projectName: 'Acme',
    assigneeId: 'robin',
    refs: [
      {
        ref: 'forum.post:4411',
        role: 'link',
        kind: 'forum.post',
        url: null,
        label: 'forum.post:4411',
      },
    ],
    similar: [target],
  };

  it('the note is the title, reason and notes, a line each, trimmed', () => {
    expect(noteTextFor(change)).toBe("Fix the offer page\nMembers can't book\nSeen on the forum");
    expect(noteTextFor({ ...change, after: { project: 'Fix the offer page', notes: null } })).toBe(
      'Fix the offer page'
    );
  });

  it('similarOf gives the matches for a create and nothing for other changes', () => {
    expect(similarOf(change)).toEqual([target]);
    expect(similarOf({ ...change, type: 'update' } as VoiceProposalWithSimilar)).toEqual([]);
    expect(similarOf({ ...change, similar: undefined })).toEqual([]);
    expect(similarOf({ ...change, similar: [target, { id: 7 } as any, null as any] })).toEqual([
      target,
    ]);
  });

  it('posts a note to the existing task, then its links, and creates nothing', async () => {
    fetchMock.mockReturnValue(ok({ id: 'note-1' }));
    const outcome = await applyAsNote(change, target, 'tok');
    expect(calls()).toEqual([
      {
        url: `${API}/projects/task-offer/updates`,
        method: 'POST',
        body: { note: "Fix the offer page\nMembers can't book\nSeen on the forum" },
      },
      {
        url: `${API}/tasks/task-offer/refs`,
        method: 'POST',
        body: { ref: 'forum.post:4411', role: 'link', label: 'forum.post:4411' },
      },
    ]);
    expect(outcome).toEqual({
      message: 'Added a note to "Broken offer page" (1 link added)',
      problems: [],
    });
  });

  it('preserves URL and label metadata on links added with a note instead', async () => {
    fetchMock.mockReturnValue(ok({ id: 'note-1' }));
    await applyAsNote(
      {
        ...change,
        refs: [
          {
            ref: 'sentry.issue:123456',
            role: 'link',
            kind: 'sentry.issue',
            url: 'https://acme.sentry.io/issues/123456/',
            label: 'Offer form failure',
          },
        ],
      },
      target,
      'tok'
    );
    expect(calls()).toHaveLength(2);
    expect(lastCall().body).toEqual({
      ref: 'sentry.issue:123456',
      role: 'link',
      url: 'https://acme.sentry.io/issues/123456/',
      label: 'Offer form failure',
    });
  });

  it('without links it is one request', async () => {
    fetchMock.mockReturnValue(ok({ id: 'note-1' }));
    const outcome = await applyAsNote({ ...change, refs: [] }, target, 'tok');
    expect(calls().map((c) => c.url)).toEqual([`${API}/projects/task-offer/updates`]);
    expect(outcome.message).toBe('Added a note to "Broken offer page"');
  });

  it('a task that has gone, or that you can only view, gets a plain message', async () => {
    fetchMock.mockReturnValue(fail(404, { error: 'Project not found or access denied' }));
    await expect(applyAsNote(change, target, 'tok')).rejects.toMatchObject({
      status: 404,
      message: '"Broken offer page" isn\'t there any more, or you can\'t add notes to it.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a link that fails is reported, and the note still counts', async () => {
    fetchMock
      .mockReturnValueOnce(ok({ id: 'note-1' }))
      .mockReturnValueOnce(fail(409, { error: 'forum.post:4411 is already linked' }));
    const outcome = await applyAsNote(change, target, 'tok');
    expect(outcome).toEqual({
      message: 'Added a note to "Broken offer page"',
      problems: ['forum.post:4411 is already linked'],
    });
  });

  it('refuses an empty note', async () => {
    await expect(
      applyAsNote({ ...change, after: { project: '  ' } }, target, 'tok')
    ).rejects.toBeInstanceOf(VoiceApplyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
