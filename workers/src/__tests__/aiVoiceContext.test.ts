/**
 * Voice commands against a real multi-user database: context loading, the prompt the model
 * sees, and resolving its proposals (people, projects, epics, view-only rules).
 * Groq is mocked; the database is node:sqlite with the live schema.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processVoiceCommand } from '../services/aiService';
import * as epicService from '../services/epicService';
import * as projectService from '../services/projectService';
import { loadVoiceContext, matchPerson, resolveProposals } from '../services/voiceContextService';
import { createTestDb, ROBIN, seedCollaboration, STRANGER, TIM } from './helpers/testDb';

let mockTranscript = 'mock transcription';
let mockInvokeResult: any = { summary: 'Nothing', changes: [] };
let lastPrompt = '';

vi.mock('../services/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ai')>();
  const fake = () => ({
    transcriber: { transcribe: vi.fn(async () => mockTranscript) },
    llm: {
      complete: vi.fn(async ({ prompt }: { prompt: string }) => {
        lastPrompt = prompt;
        return mockInvokeResult;
      }),
    },
  });
  return {
    ...actual,
    providersForGroqKey: vi.fn(() => fake()),
    providersFromEnv: vi.fn((env: { GROQ_API_KEY?: string }) => {
      if (!env.GROQ_API_KEY) {
        throw new actual.AiNotConfiguredError(
          'Voice features are not configured: GROQ_API_KEY is not set'
        );
      }
      return fake();
    }),
  };
});

/** The task list the model was shown, parsed back out of the rendered prompt. */
function tasksInPrompt(prompt: string): any[] {
  const marker = 'Current Tasks JSON:';
  return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).trim());
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const audio = () => new File(['x'], 'r.webm', { type: 'audio/webm' });

const create = (after: Record<string, any>, n = 1) => ({
  type: 'create' as const,
  projectId: `new-project-placeholder-${n}`,
  after: {
    id: `new-project-placeholder-${n}`,
    status: 'do',
    priority: 5,
    size: '***',
    ...after,
  },
});

describe('voice commands in shared workspaces', () => {
  let db: any;
  let raw: any;

  beforeEach(async () => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
    mockTranscript = 'mock transcription';
    mockInvokeResult = { summary: 'Nothing', changes: [] };
    lastPrompt = '';
    // A workspace Tim can only view, a second Solfit elsewhere is added per test
    raw.exec(`
      INSERT INTO Organisations (id, name, slug, created_by, is_personal) VALUES
        ('org-club', 'Caving Club', 'caving-club', '${STRANGER}', 0);
      INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES
        ('m5', 'org-club', '${STRANGER}', 'owner'),
        ('m6', 'org-club', '${TIM}', 'viewer');
      INSERT INTO Projects (id, org_id, key, name) VALUES
        ('proj-xebit', 'org-md', 'XEB', 'Xebit Ltd'),
        ('proj-club', 'org-club', 'CLB', 'Club Kit');
      INSERT INTO Goals (id, user_id, type, title) VALUES ('goal-health', '${TIM}', 'aim', 'Be healthy');
    `);
    await projectService.createProject(db, TIM, {
      id: uuid(1),
      project: 'Acme Solar onboarding',
      status: 'do',
      priority: 7,
      size: '**',
      projectId: 'proj-solfit',
      assigneeId: null,
    });
    await projectService.createProject(db, ROBIN, {
      id: uuid(2),
      project: 'Check inverter datasheet',
      status: 'do',
      priority: 6,
      size: '*',
      projectId: 'proj-solfit',
    });
    await projectService.createProject(db, TIM, {
      id: uuid(3),
      project: 'Renew passport',
      status: 'delay',
      priority: 3,
      size: '*',
      category: 'Personal',
    });
    await projectService.createProject(db, STRANGER, {
      id: uuid(4),
      project: 'Count the ropes',
      status: 'do',
      priority: 5,
      size: '*',
      projectId: 'proj-club',
    });
    await epicService.createEpic(db, TIM, {
      id: 'epic-br',
      title: 'Acme Solar',
      projectId: 'proj-solfit',
      status: 'active',
    });
  });

  const ctx = () => loadVoiceContext(db, TIM);

  describe('loadVoiceContext', () => {
    it('loads workspaces with roles, people, projects, tasks, epics and goals', async () => {
      const c = await ctx();
      expect(c.me).toEqual({ id: TIM, name: 'Tim Dobson', email: 'tim@example.com' });
      expect(c.workspaces.map((w) => [w.name, w.role, w.isPersonal])).toEqual([
        ['Tim Dobson', 'owner', true],
        ['Caving Club', 'viewer', false],
        ['Migrating Dragons', 'owner', false],
      ]);
      const md = c.workspaces.find((w) => w.id === 'org-md')!;
      expect(md.members.map((m) => m.name).sort()).toEqual(['Robin Fairweather', 'Tim Dobson']);
      expect(md.projects.map((p) => p.name).sort()).toEqual([
        'Migrating Dragons',
        'Solfit',
        'Xebit Ltd',
      ]);
      expect(c.tasks.map((t) => t.project).sort()).toEqual([
        'Acme Solar onboarding',
        'Check inverter datasheet',
        'Count the ropes',
        'Renew passport',
      ]);
      expect(c.epics.map((e) => e.title)).toEqual(['Acme Solar']);
      expect(c.goals).toEqual([{ id: 'goal-health', title: 'Be healthy' }]);
    });

    it("never shows another person's private workspace", async () => {
      const c = await loadVoiceContext(db, ROBIN);
      expect(c.workspaces.map((w) => w.name).sort()).toEqual(['Migrating Dragons']);
      expect(c.tasks.map((t) => t.project).sort()).toEqual([
        'Acme Solar onboarding',
        'Check inverter datasheet',
      ]);
    });

    it('uses the client task list when it has workspace info, and ignores it otherwise', async () => {
      const fromClient = [
        {
          id: uuid(9),
          project: 'Client copy',
          status: 'do',
          priority: 5,
          size: '*',
          projectId: 'proj-solfit',
        },
      ];
      expect((await loadVoiceContext(db, TIM, fromClient)).tasks.map((t) => t.project)).toEqual([
        'Client copy',
      ]);
      // Old cached shape without projectId, or a project the user can't see: load from the DB
      const stale = [{ id: uuid(9), project: 'Old shape', status: 'do', priority: 5, size: '*' }];
      expect((await loadVoiceContext(db, TIM, stale)).tasks).toHaveLength(4);
      const foreign = [{ ...fromClient[0], projectId: 'proj-stranger' }];
      expect((await loadVoiceContext(db, TIM, foreign)).tasks).toHaveLength(4);
    });
  });

  describe('prompt', () => {
    it('gives the model the user, workspaces with roles, people and compact tasks', async () => {
      await processVoiceCommand({ audioFile: audio(), groqApiKey: 'k', context: await ctx() });
      expect(lastPrompt).toContain('\nTim Dobson <tim@example.com>\n');
      expect(lastPrompt).toContain('Workspace "Migrating Dragons" (shared, your role: owner)');
      expect(lastPrompt).toContain('Robin Fairweather <robin@example.com> member');
      expect(lastPrompt).toContain(
        'Workspace "Caving Club" (shared, your role: viewer, VIEW ONLY)'
      );
      expect(lastPrompt).toContain('Solfit [SOL]');
      expect(lastPrompt).toContain('"Acme Solar" in Solfit');
      const tasks = tasksInPrompt(lastPrompt);
      expect(tasks.find((t: any) => t.project === 'Check inverter datasheet')).toMatchObject({
        category: 'Solfit',
        workspace: 'Migrating Dragons',
        assignee: 'Robin Fairweather',
      });
      expect(tasks.find((t: any) => t.project === 'Acme Solar onboarding').assignee).toBe(
        'unassigned'
      );
      expect(tasks.find((t: any) => t.project === 'Count the ropes').viewOnly).toBe(true);
    });

    it('keeps the original rules and adds the collaboration ones, with no em-dashes', async () => {
      const { VOICE_PROMPT_TEMPLATE } = await import('../services/aiService');
      expect(VOICE_PROMPT_TEMPLATE).toContain('ALWAYS set an awaitUntil date');
      expect(VOICE_PROMPT_TEMPLATE).toContain('DATE PARSING for awaitUntil');
      expect(VOICE_PROMPT_TEMPLATE).toContain(
        'NEVER propose a change to a task, epic or project in a workspace where the user is a viewer'
      );
      expect(VOICE_PROMPT_TEMPLATE).toContain(
        'MUST be the exact name of one of the projects listed above'
      );
      expect(VOICE_PROMPT_TEMPLATE).not.toContain('\u2014');
    });
  });

  describe('assignees', () => {
    it('"for Robin" in Solfit resolves to Robin, with labels for the review screen', async () => {
      mockInvokeResult = {
        summary: 'Added a task for Robin',
        changes: [
          create({
            project: 'Check the inverter datasheet',
            category: 'Solfit',
            assignee: 'Robin',
          }),
        ],
      };
      const result = await processVoiceCommand({
        audioFile: audio(),
        groqApiKey: 'k',
        context: await ctx(),
      });
      expect(result.warnings).toEqual([]);
      expect(result.proposedChanges[0]).toMatchObject({
        type: 'create',
        projectId: 'proj-solfit',
        projectName: 'Solfit',
        orgName: 'Migrating Dragons',
        assigneeId: ROBIN,
        assigneeName: 'Robin Fairweather',
        isNewProject: false,
      });
      expect(result.proposedChanges[0].after).toMatchObject({
        assigneeId: ROBIN,
        assigneeName: 'Robin Fairweather',
        projectId: 'proj-solfit',
        orgName: 'Migrating Dragons',
      });
    });

    it.each([
      ['Robin Fairweather'],
      ['robin fairweather'],
      ['robin@example.com'],
      ['Rob'],
      ['Fairweather'],
      ['Robbin'],
    ])('matches %s to Robin', async (spoken) => {
      const c = await ctx();
      const { proposals } = resolveProposals(
        [create({ project: 'X', category: 'Solfit', assignee: spoken })],
        c
      );
      expect(proposals[0].assigneeId).toBe(ROBIN);
    });

    it.each([['me'], ['myself'], ['mine'], ['Tim'], ['tim@example.com']])(
      '"%s" is the signed-in user',
      async (spoken) => {
        const { proposals } = resolveProposals(
          [create({ project: 'X', category: 'Solfit', assignee: spoken })],
          await ctx()
        );
        expect(proposals[0]).toMatchObject({ assigneeId: TIM, assigneeName: 'Tim Dobson' });
      }
    );

    it('new tasks with no assignee mentioned go to the creator', async () => {
      const { proposals } = resolveProposals(
        [create({ project: 'X', category: 'Solfit' })],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({ assigneeId: TIM, assigneeName: 'Tim Dobson' });
    });

    it('"unassigned" leaves a new task unassigned', async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'X', category: 'Solfit', assignee: 'unassigned' })],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({ assigneeId: null, assigneeName: null });
      expect(warnings).toEqual([]);
    });

    it("someone outside the task's workspace is left unassigned, with a warning", async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'Buy milk', category: 'Personal', assignee: 'Robin' })],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({
        assigneeId: null,
        projectName: 'Personal',
        orgName: 'Tim Dobson',
      });
      expect(warnings).toEqual([
        "Robin Fairweather isn't in the Tim Dobson workspace, so I left it unassigned.",
      ]);
      expect(proposals[0].warnings).toEqual(warnings);
    });

    it('a name nobody has is left unassigned, with a warning', async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'X', category: 'Solfit', assignee: 'Sarah' })],
        await ctx()
      );
      expect(proposals[0].assigneeId).toBeNull();
      expect(warnings[0]).toBe(
        `I couldn't find anyone called "Sarah" in the Migrating Dragons workspace, so I left it unassigned.`
      );
    });

    it('an ambiguous first name is left unassigned and names the candidates', async () => {
      raw.exec(`
        INSERT INTO Users (id, email, name) VALUES ('u-s1', 's1@example.com', 'Sam Smith'), ('u-s2', 's2@example.com', 'Sam Jones');
        INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('m7', 'org-md', 'u-s1', 'member'), ('m8', 'org-md', 'u-s2', 'member');
      `);
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'X', category: 'Solfit', assignee: 'Sam' })],
        await ctx()
      );
      expect(proposals[0].assigneeId).toBeNull();
      expect(warnings[0]).toContain('"Sam" could be Sam Jones or Sam Smith');
    });

    it('reassigning an existing task resolves the new assignee and marks the change', async () => {
      const { proposals } = resolveProposals(
        [
          {
            type: 'update',
            projectId: uuid(2),
            after: {
              id: uuid(2),
              project: 'Check inverter datasheet',
              status: 'do',
              priority: 6,
              size: '*',
              category: 'Solfit',
              assignee: 'me',
            },
          },
        ],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({
        taskId: uuid(2),
        projectId: 'proj-solfit',
        assigneeId: TIM,
        assigneeName: 'Tim Dobson',
        assigneeChanged: true,
      });
      expect(proposals[0].before?.assigneeName).toBe('Robin Fairweather');
    });

    it('an update that echoes the current assignee does not reassign', async () => {
      const { proposals, warnings } = resolveProposals(
        [
          {
            type: 'update',
            projectId: uuid(2),
            after: {
              id: uuid(2),
              project: 'Check inverter datasheet',
              status: 'done',
              priority: 6,
              size: '*',
              category: 'Solfit',
              assignee: 'Robin Fairweather',
            },
          },
          {
            type: 'update',
            projectId: uuid(1),
            after: {
              id: uuid(1),
              project: 'Acme Solar onboarding',
              status: 'done',
              priority: 7,
              size: '**',
              category: 'Solfit',
              assignee: 'unassigned',
            },
          },
        ],
        await ctx()
      );
      expect(warnings).toEqual([]);
      expect(proposals[0].assigneeId).toBeUndefined();
      expect(proposals[0].assigneeChanged).toBe(false);
      expect(proposals[0].assigneeName).toBe('Robin Fairweather');
      expect(proposals[1].assigneeId).toBeUndefined();
      expect('assigneeId' in proposals[1].after!).toBe(false);
    });

    it('an unknown assignee on an update keeps the current one, with a warning', async () => {
      const { proposals, warnings } = resolveProposals(
        [
          {
            type: 'update',
            projectId: uuid(2),
            after: {
              id: uuid(2),
              project: 'Check inverter datasheet',
              status: 'do',
              priority: 6,
              size: '*',
              category: 'Solfit',
              assignee: 'Stranger',
            },
          },
        ],
        await ctx()
      );
      expect(proposals[0].assigneeId).toBeUndefined();
      expect(warnings[0]).toBe(
        "Stranger isn't in the Migrating Dragons workspace, so I didn't change who it's assigned to."
      );
    });
  });

  describe('claim', () => {
    it('claims an unassigned shared task for the signed-in user', async () => {
      const { proposals } = resolveProposals(
        [{ type: 'claim', projectId: uuid(1), after: { assignee: 'me' } }],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({
        type: 'claim',
        taskId: uuid(1),
        assigneeId: TIM,
        assigneeName: 'Tim Dobson',
        projectName: 'Solfit',
        orgName: 'Migrating Dragons',
      });
      expect(proposals[0].after?.project).toBe('Acme Solar onboarding');
    });

    it("notes when the task is someone else's, and drops claims of your own tasks", async () => {
      const { proposals, warnings } = resolveProposals(
        [
          { type: 'claim', projectId: uuid(2), after: { assignee: 'me' } },
          { type: 'claim', projectId: uuid(3), after: { assignee: 'me' } },
        ],
        await ctx()
      );
      expect(proposals).toHaveLength(1);
      expect(warnings).toEqual([
        '"Check inverter datasheet" is assigned to Robin Fairweather at the moment.',
        '"Renew passport" is already yours.',
      ]);
    });
  });

  describe('projects and view-only access', () => {
    it('matches misheard project names to an existing project', async () => {
      const c = await ctx();
      for (const spoken of ['solfit', 'Sol fit', 'Solfitt', 'SOL', 'xebit ltd']) {
        const { proposals, warnings } = resolveProposals(
          [create({ project: 'X', category: spoken })],
          c
        );
        expect(warnings).toEqual([]);
        expect(['proj-solfit', 'proj-xebit']).toContain(proposals[0].projectId);
      }
    });

    it('an unknown project becomes a new personal project, with a warning', async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'Plan the garden', category: 'Allotment' })],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({
        projectId: null,
        projectName: 'Allotment',
        orgName: 'Tim Dobson',
        isNewProject: true,
      });
      expect(warnings[0]).toBe(
        `There's no "Allotment" project yet, so applying "Plan the garden" will create it in your personal workspace.`
      );
    });

    it('no warning when the same command asks for the new project', async () => {
      const { proposals, warnings } = resolveProposals(
        [
          {
            type: 'createProject',
            projectId: 'new-project-placeholder-1',
            after: { project: 'Allotment' },
          },
          create({ project: 'Plan the garden', category: 'Allotment' }, 2),
        ],
        await ctx()
      );
      expect(warnings).toEqual([]);
      expect(proposals[0]).toMatchObject({
        type: 'createProject',
        orgId: 'org-tim',
        isNewProject: true,
      });
      expect(proposals[1]).toMatchObject({ isNewProject: true, projectName: 'Allotment' });
    });

    it('creates a new project in a named shared workspace, and refuses duplicates', async () => {
      const { proposals, warnings } = resolveProposals(
        [
          {
            type: 'createProject',
            projectId: 'p1',
            after: { project: 'Hydrogen', workspace: 'migrating dragons' },
          },
          {
            type: 'createProject',
            projectId: 'p2',
            after: { project: 'solfit', workspace: 'Migrating Dragons' },
          },
          {
            type: 'createProject',
            projectId: 'p3',
            after: { project: 'Rope log', workspace: 'Caving Club' },
          },
        ],
        await ctx()
      );
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        orgId: 'org-md',
        orgName: 'Migrating Dragons',
        projectName: 'Hydrogen',
      });
      expect(warnings).toEqual([
        `There's already a "Solfit" project in Migrating Dragons, so I didn't add another.`,
        `You have view-only access to the Caving Club workspace, so I didn't add the "Rope log" project.`,
      ]);
    });

    it('drops changes to view-only projects, with a warning', async () => {
      const { proposals, warnings } = resolveProposals(
        [
          create({ project: 'Buy rope', category: 'Club Kit' }),
          {
            type: 'update',
            projectId: uuid(4),
            after: {
              id: uuid(4),
              project: 'Count the ropes',
              status: 'done',
              priority: 5,
              size: '*',
              category: 'Club Kit',
            },
          },
          { type: 'delete', projectId: uuid(4) },
          { type: 'claim', projectId: uuid(4), after: { assignee: 'me' } },
          {
            type: 'createEpic',
            projectId: 'new-epic-placeholder-1',
            after: { project: 'Rope audit', category: 'Club Kit' },
          },
        ],
        await ctx()
      );
      expect(proposals).toEqual([]);
      expect(warnings).toEqual([
        `You have view-only access to "Club Kit", so I left out "Buy rope".`,
        `You have view-only access to "Club Kit", so I can't change "Count the ropes".`,
        `You have view-only access to "Club Kit", so I left out the "Rope audit" epic.`,
      ]);
    });

    it('drops changes to tasks it cannot find', async () => {
      const { proposals, warnings } = resolveProposals(
        [{ type: 'delete', projectId: 'no-such-task', after: { project: 'Ghost task' } }],
        await ctx()
      );
      expect(proposals).toEqual([]);
      expect(warnings).toEqual([
        `I couldn't find the task "Ghost task", so I left that change out.`,
      ]);
    });

    it('prefers the workspace the assignee is in when a project name exists twice', async () => {
      raw.exec(
        `INSERT INTO Projects (id, org_id, key, name) VALUES ('proj-solfit-personal', 'org-tim', 'SOP', 'Solfit');`
      );
      const c = await ctx();
      const forRobin = resolveProposals(
        [create({ project: 'X', category: 'Solfit', assignee: 'Robin' })],
        c
      );
      expect(forRobin.proposals[0].projectId).toBe('proj-solfit');
      expect(forRobin.warnings).toEqual([]);
      const forNobody = resolveProposals([create({ project: 'X', category: 'Solfit' })], c);
      expect(forNobody.warnings[0]).toContain(`There's a "Solfit" project in`);
    });

    it('moving a task to another workspace drops an assignee who is not a member there', async () => {
      const { proposals, warnings } = resolveProposals(
        [
          {
            type: 'update',
            projectId: uuid(2),
            after: {
              id: uuid(2),
              project: 'Check inverter datasheet',
              status: 'do',
              priority: 6,
              size: '*',
              category: 'Personal',
            },
          },
        ],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({
        projectId: 'proj-personal',
        assigneeId: null,
        orgName: 'Tim Dobson',
      });
      expect(warnings[0]).toBe(
        "Robin Fairweather isn't in the Tim Dobson workspace, so moving it there leaves it unassigned."
      );
    });

    it('updates keep the current project when no category is given', async () => {
      const { proposals } = resolveProposals(
        [
          {
            type: 'update',
            projectId: uuid(1),
            after: {
              id: uuid(1),
              project: 'Acme Solar onboarding',
              status: 'done',
              priority: 7,
              size: '**',
            },
          },
        ],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({
        projectId: 'proj-solfit',
        projectName: 'Solfit',
        isNewProject: false,
      });
    });
  });

  describe('prompt size', () => {
    it('clips long notes, trims done tasks, and restores clipped notes the model echoes back', async () => {
      const long = 'x'.repeat(400);
      await projectService.updateProject(db, TIM, uuid(1), { notes: long });
      for (let i = 0; i < 105; i++) {
        await projectService.createProject(db, TIM, {
          id: uuid(100 + i),
          project: `Old ${i}`,
          status: 'done',
          priority: 5,
          size: '*',
          category: 'Personal',
          notes: 'long done notes',
        });
      }
      const c = await ctx();
      await processVoiceCommand({ audioFile: audio(), groqApiKey: 'k', context: c });
      const tasks = tasksInPrompt(lastPrompt);
      const onboarding = tasks.find((t: any) => t.id === uuid(1));
      expect(onboarding.notes).toHaveLength(163);
      const done = tasks.filter((t: any) => t.status === 'done');
      expect(done).toHaveLength(100);
      expect(done[0].notes).toBeUndefined();

      const { proposals } = resolveProposals(
        [{ type: 'update', projectId: uuid(1), after: { ...onboarding, status: 'done' } }],
        c
      );
      expect(proposals[0].after?.notes).toBe(long);
    });
  });

  describe('epics and goals', () => {
    it('links a new task to an epic in its project', async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'Draft mockups', category: 'Solfit', epicTitle: 'acme solar' })],
        await ctx()
      );
      expect(warnings).toEqual([]);
      expect(proposals[0]).toMatchObject({ epicId: 'epic-br', epicTitle: 'Acme Solar' });
    });

    it("warns when the epic isn't in that project", async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'X', category: 'Personal', epicTitle: 'Acme Solar' })],
        await ctx()
      );
      expect(proposals[0].epicId).toBeNull();
      expect(warnings[0]).toBe(
        `There's no "Acme Solar" epic in Personal, so the task won't be linked to an epic.`
      );
    });

    it('keeps a pending epic title when the same command creates the epic', async () => {
      const { proposals, warnings } = resolveProposals(
        [
          {
            type: 'createEpic',
            projectId: 'new-epic-placeholder-1',
            after: { project: 'Hydrogen pilot', category: 'Solfit' },
          },
          create({ project: 'Call supplier', category: 'Solfit', epicTitle: 'Hydrogen pilot' }, 2),
        ],
        await ctx()
      );
      expect(warnings).toEqual([]);
      expect(proposals[0]).toMatchObject({
        type: 'createEpic',
        projectId: 'proj-solfit',
        orgName: 'Migrating Dragons',
      });
      expect(proposals[1]).toMatchObject({ epicId: null, epicTitle: 'Hydrogen pilot' });
    });

    it('resolves a life goal by title', async () => {
      const { proposals } = resolveProposals(
        [create({ project: 'Run', category: 'Personal', goalTitle: 'be healthy' })],
        await ctx()
      );
      expect(proposals[0].goalId).toBe('goal-health');
    });
  });

  describe('end to end', () => {
    it('returns the answer to a question, and merges model and resolver warnings', async () => {
      mockInvokeResult = {
        summary: 'Answered a question',
        answer: 'Robin is working on Check inverter datasheet.',
        warnings: ['Club Kit is view-only.'],
        changes: [create({ project: 'Buy rope', category: 'Club Kit' })],
      };
      const result = await processVoiceCommand({
        audioFile: audio(),
        groqApiKey: 'k',
        context: await ctx(),
      });
      expect(result.answer).toBe('Robin is working on Check inverter datasheet.');
      expect(result.proposedChanges).toEqual([]);
      expect(result.warnings).toEqual([
        'Club Kit is view-only.',
        `You have view-only access to "Club Kit", so I left out "Buy rope".`,
      ]);
    });

    it('a resolved proposal can be applied as-is through the projects API service', async () => {
      mockInvokeResult = {
        summary: 'Added a task for Robin',
        changes: [
          create({
            project: 'Check the inverter datasheet',
            category: 'Solfit',
            assignee: 'Robin',
            epicTitle: 'Acme Solar',
          }),
        ],
      };
      const result = await processVoiceCommand({
        audioFile: audio(),
        groqApiKey: 'k',
        context: await ctx(),
      });
      const p = result.proposedChanges[0] as any;
      const created = await projectService.createProject(db, TIM, {
        id: uuid(50),
        project: p.after.project,
        status: p.after.status,
        priority: p.after.priority,
        size: p.after.size,
        projectId: p.projectId,
        assigneeId: p.assigneeId,
        epicId: p.epicId,
      });
      expect(created).toMatchObject({
        assigneeName: 'Robin Fairweather',
        orgName: 'Migrating Dragons',
        epicId: 'epic-br',
      });
    });

    it('returns no changes and no warnings for silence', async () => {
      mockTranscript = '   ';
      const result = await processVoiceCommand({
        audioFile: audio(),
        groqApiKey: 'k',
        context: await ctx(),
      });
      expect(result).toMatchObject({
        summary: 'No speech detected.',
        proposedChanges: [],
        warnings: [],
      });
    });
  });

  describe('matchPerson', () => {
    const people = [
      {
        userId: 'a',
        name: 'Robin Fairweather',
        email: 'robin@example.com',
        role: 'member' as const,
      },
      { userId: 'b', name: 'Tim Dobson', email: 'tim@example.com', role: 'owner' as const },
    ];
    it('handles me words, nobody words and unknowns', () => {
      expect(matchPerson('me', people, 'b').kind).toBe('me');
      expect(matchPerson('Tim Dobson', people, 'b').kind).toBe('me');
      expect(matchPerson('nobody', people, 'b').kind).toBe('nobody');
      expect(matchPerson('no-one', people, 'b').kind).toBe('nobody');
      expect(matchPerson('Zed', people, 'b').kind).toBe('none');
      expect(matchPerson('', people, 'b').kind).toBe('none');
    });
  });
});
