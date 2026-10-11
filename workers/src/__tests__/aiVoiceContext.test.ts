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

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: vi.fn().mockImplementation(async () => ({ text: mockTranscript })),
      },
    },
  })),
}));

let mockTranscript = 'mock transcription';
let mockInvokeResult: any = { summary: 'Nothing', changes: [] };
let lastInvokeArgs: any = null;

vi.mock('@langchain/core/prompts', () => ({
  PromptTemplate: {
    fromTemplate: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnValue({
        invoke: vi.fn().mockImplementation(async (args: any) => {
          lastInvokeArgs = args;
          return mockInvokeResult;
        }),
      }),
    }),
  },
}));

vi.mock('@langchain/groq', () => ({
  ChatGroq: vi.fn().mockImplementation(() => ({ withStructuredOutput: vi.fn() })),
}));

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
    lastInvokeArgs = null;
    // A workspace Casey can only view, a second Acme Solar elsewhere is added per test
    raw.exec(`
      INSERT INTO Organisations (id, name, slug, created_by, is_personal) VALUES
        ('org-club', 'Example Club', 'example-club', '${STRANGER}', 0);
      INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES
        ('m5', 'org-club', '${STRANGER}', 'owner'),
        ('m6', 'org-club', '${TIM}', 'viewer');
      INSERT INTO Projects (id, org_id, key, name) VALUES
        ('proj-northstar-labs', 'org-md', 'NSL', 'Northstar Labs'),
        ('proj-club', 'org-club', 'CLB', 'Club Kit');
      INSERT INTO Goals (id, user_id, type, title) VALUES ('goal-health', '${TIM}', 'aim', 'Be healthy');
    `);
    await projectService.createProject(db, TIM, {
      id: uuid(1),
      project: 'Acme Solar onboarding',
      status: 'do',
      priority: 7,
      size: '**',
      projectId: 'proj-acme-solar',
      assigneeId: null,
    });
    await projectService.createProject(db, ROBIN, {
      id: uuid(2),
      project: 'Check inverter datasheet',
      status: 'do',
      priority: 6,
      size: '*',
      projectId: 'proj-acme-solar',
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
      projectId: 'proj-acme-solar',
      status: 'active',
    });
  });

  const ctx = (transcript = '') => loadVoiceContext(db, TIM, transcript);

  describe('loadVoiceContext', () => {
    it('loads workspaces with roles, people, projects, tasks, epics and goals', async () => {
      const c = await ctx();
      expect(c.me).toEqual({ id: TIM, name: 'Casey Example', email: 'casey@example.test' });
      expect(c.workspaces.map((w) => [w.name, w.role, w.isPersonal])).toEqual([
        ['Casey Example', 'owner', true],
        ['Example Club', 'viewer', false],
        ['Northstar Workshop', 'owner', false],
      ]);
      const md = c.workspaces.find((w) => w.id === 'org-md')!;
      expect(md.members.map((m) => m.name).sort()).toEqual(['Casey Example', 'Jordan Example']);
      expect(md.projects.map((p) => p.name).sort()).toEqual([
        'Acme Solar',
        'Northstar Labs',
        'Northstar Workshop',
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
      expect(c.workspaces.map((w) => w.name).sort()).toEqual(['Northstar Workshop']);
      expect(c.tasks.map((t) => t.project).sort()).toEqual([
        'Acme Solar onboarding',
        'Check inverter datasheet',
      ]);
    });

    it('selects task content from the database rather than accepting a client task list', async () => {
      const fromClient = [
        {
          id: uuid(9),
          project: 'Client copy',
          status: 'do',
          priority: 5,
          size: '*',
          projectId: 'proj-acme-solar',
        },
      ];
      const context = await loadVoiceContext(db, TIM, 'Client copy');
      expect(context.tasks.map((task) => task.project)).not.toContain(fromClient[0].project);
      expect(context.tasks.map((task) => task.project)).toEqual(
        expect.arrayContaining([
          'Acme Solar onboarding',
          'Check inverter datasheet',
          'Count the ropes',
          'Renew passport',
        ])
      );
    });
  });

  describe('prompt', () => {
    it('gives the model the user, workspaces with roles, people and compact tasks', async () => {
      await processVoiceCommand({ audioFile: audio(), groqApiKey: 'k', context: await ctx() });
      expect(lastInvokeArgs.me).toBe('Casey Example <casey@example.test>');
      expect(lastInvokeArgs.workspaces).toContain(
        'Workspace "Northstar Workshop" (shared, your role: owner)'
      );
      expect(lastInvokeArgs.workspaces).toContain('Jordan Example <jordan@example.test> member');
      expect(lastInvokeArgs.workspaces).toContain(
        'Workspace "Example Club" (shared, your role: viewer, VIEW ONLY)'
      );
      expect(lastInvokeArgs.workspaces).toContain('Acme Solar [ACS]');
      expect(lastInvokeArgs.epics).toContain('"Acme Solar" in Acme Solar');
      const tasks = JSON.parse(lastInvokeArgs.projects);
      expect(tasks.find((t: any) => t.project === 'Check inverter datasheet')).toMatchObject({
        category: 'Acme Solar',
        workspace: 'Northstar Workshop',
        assignee: 'Jordan Example',
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
    it('"for Jordan" in Acme Solar resolves to Jordan, with labels for the review screen', async () => {
      mockInvokeResult = {
        summary: 'Added a task for Jordan',
        changes: [
          create({
            project: 'Check the inverter datasheet',
            category: 'Acme Solar',
            assignee: 'Jordan',
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
        projectId: 'proj-acme-solar',
        projectName: 'Acme Solar',
        orgName: 'Northstar Workshop',
        assigneeId: ROBIN,
        assigneeName: 'Jordan Example',
        isNewProject: false,
      });
      expect(result.proposedChanges[0].after).toMatchObject({
        assigneeId: ROBIN,
        assigneeName: 'Jordan Example',
        projectId: 'proj-acme-solar',
        orgName: 'Northstar Workshop',
      });
    });

    it.each([
      ['Jordan Example'],
      ['jordan example'],
      ['jordan@example.test'],
      ['Jor'],
      ['Jordan E'],
      ['Jordn'],
    ])('matches %s to Jordan', async (spoken) => {
      const c = await ctx();
      const { proposals } = resolveProposals(
        [create({ project: 'X', category: 'Acme Solar', assignee: spoken })],
        c
      );
      expect(proposals[0].assigneeId).toBe(ROBIN);
    });

    it.each([['me'], ['myself'], ['mine'], ['Casey'], ['casey@example.test']])(
      '"%s" is the signed-in user',
      async (spoken) => {
        const { proposals } = resolveProposals(
          [create({ project: 'X', category: 'Acme Solar', assignee: spoken })],
          await ctx()
        );
        expect(proposals[0]).toMatchObject({ assigneeId: TIM, assigneeName: 'Casey Example' });
      }
    );

    it('new tasks with no assignee mentioned go to the creator', async () => {
      const { proposals } = resolveProposals(
        [create({ project: 'X', category: 'Acme Solar' })],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({ assigneeId: TIM, assigneeName: 'Casey Example' });
    });

    it('"unassigned" leaves a new task unassigned', async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'X', category: 'Acme Solar', assignee: 'unassigned' })],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({ assigneeId: null, assigneeName: null });
      expect(warnings).toEqual([]);
    });

    it("someone outside the task's workspace is left unassigned, with a warning", async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'Buy milk', category: 'Personal', assignee: 'Jordan' })],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({
        assigneeId: null,
        projectName: 'Personal',
        orgName: 'Casey Example',
      });
      expect(warnings).toEqual([
        "Jordan Example isn't in the Casey Example workspace, so I left it unassigned.",
      ]);
      expect(proposals[0].warnings).toEqual(warnings);
    });

    it('a name nobody has is left unassigned, with a warning', async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'X', category: 'Acme Solar', assignee: 'Sarah' })],
        await ctx()
      );
      expect(proposals[0].assigneeId).toBeNull();
      expect(warnings[0]).toBe(
        `I couldn't find anyone called "Sarah" in the Northstar Workshop workspace, so I left it unassigned.`
      );
    });

    it('an ambiguous first name is left unassigned and names the candidates', async () => {
      raw.exec(`
        INSERT INTO Users (id, email, name) VALUES ('u-s1', 's1@example.com', 'Sam Smith'), ('u-s2', 's2@example.com', 'Sam Jones');
        INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('m7', 'org-md', 'u-s1', 'member'), ('m8', 'org-md', 'u-s2', 'member');
      `);
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'X', category: 'Acme Solar', assignee: 'Sam' })],
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
              category: 'Acme Solar',
              assignee: 'me',
            },
          },
        ],
        await ctx()
      );
      expect(proposals[0]).toMatchObject({
        taskId: uuid(2),
        projectId: 'proj-acme-solar',
        assigneeId: TIM,
        assigneeName: 'Casey Example',
        assigneeChanged: true,
      });
      expect(proposals[0].before?.assigneeName).toBe('Jordan Example');
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
              category: 'Acme Solar',
              assignee: 'Jordan Example',
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
              category: 'Acme Solar',
              assignee: 'unassigned',
            },
          },
        ],
        await ctx()
      );
      expect(warnings).toEqual([]);
      expect(proposals[0].assigneeId).toBeUndefined();
      expect(proposals[0].assigneeChanged).toBe(false);
      expect(proposals[0].assigneeName).toBe('Jordan Example');
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
              category: 'Acme Solar',
              assignee: 'Stranger',
            },
          },
        ],
        await ctx()
      );
      expect(proposals[0].assigneeId).toBeUndefined();
      expect(warnings[0]).toBe(
        "Stranger isn't in the Northstar Workshop workspace, so I didn't change who it's assigned to."
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
        assigneeName: 'Casey Example',
        projectName: 'Acme Solar',
        orgName: 'Northstar Workshop',
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
        '"Check inverter datasheet" is assigned to Jordan Example at the moment.',
        '"Renew passport" is already yours.',
      ]);
    });
  });

  describe('projects and view-only access', () => {
    it('matches misheard project names to an existing project', async () => {
      const c = await ctx();
      for (const spoken of ['acme solar', 'Acme-Solar', 'Acme Solarr', 'ACS', 'northstar labs']) {
        const { proposals, warnings } = resolveProposals(
          [create({ project: 'X', category: spoken })],
          c
        );
        expect(warnings).toEqual([]);
        expect(['proj-acme-solar', 'proj-northstar-labs']).toContain(proposals[0].projectId);
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
        orgName: 'Casey Example',
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
            after: { project: 'Hydrogen', workspace: 'Northstar Workshop' },
          },
          {
            type: 'createProject',
            projectId: 'p2',
            after: { project: 'Acme Solar', workspace: 'Northstar Workshop' },
          },
          {
            type: 'createProject',
            projectId: 'p3',
            after: { project: 'Rope log', workspace: 'Example Club' },
          },
        ],
        await ctx()
      );
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        orgId: 'org-md',
        orgName: 'Northstar Workshop',
        projectName: 'Hydrogen',
      });
      expect(warnings).toEqual([
        `There's already a "Acme Solar" project in Northstar Workshop, so I didn't add another.`,
        `You have view-only access to the Example Club workspace, so I didn't add the "Rope log" project.`,
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
        `I couldn't find the task "Ghost task" in the selected task sample, so I left that change out. Mention a listed task title or id instead.`,
      ]);
    });

    it('prefers the workspace the assignee is in when a project name exists twice', async () => {
      raw.exec(
        `INSERT INTO Projects (id, org_id, key, name) VALUES ('proj-acme-solar-personal', 'org-tim', 'SOP', 'Acme Solar');`
      );
      const c = await ctx();
      const forRobin = resolveProposals(
        [create({ project: 'X', category: 'Acme Solar', assignee: 'Jordan' })],
        c
      );
      expect(forRobin.proposals[0].projectId).toBe('proj-acme-solar');
      expect(forRobin.warnings).toEqual([]);
      const forNobody = resolveProposals([create({ project: 'X', category: 'Acme Solar' })], c);
      expect(forNobody.warnings[0]).toContain(`There's a "Acme Solar" project in`);
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
        orgName: 'Casey Example',
      });
      expect(warnings[0]).toBe(
        "Jordan Example isn't in the Casey Example workspace, so moving it there leaves it unassigned."
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
        projectId: 'proj-acme-solar',
        projectName: 'Acme Solar',
        isNewProject: false,
      });
    });
  });

  describe('prompt size', () => {
    it('SQL-clips prompt bodies and includes matching Done tasks within the bounded sample', async () => {
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
      const context = await ctx('Acme Solar onboarding old');
      await processVoiceCommand({ audioFile: audio(), groqApiKey: 'k', context });
      const tasks = JSON.parse(lastInvokeArgs.projects);
      const onboarding = tasks.find((task: any) => task.id === uuid(1));
      const done = tasks.filter((task: any) => task.status === 'done');
      expect(context.tasks.length).toBeLessThanOrEqual(150);
      expect(tasks.length).toBeLessThanOrEqual(150);
      expect(onboarding.notes).toHaveLength(163);
      expect(done).toHaveLength(105);
      expect(done[0].notes).toBeUndefined();
      expect(lastInvokeArgs.projects).not.toContain(long);
    });
  });

  describe('epics and goals', () => {
    it('links a new task to an epic in its project', async () => {
      const { proposals, warnings } = resolveProposals(
        [create({ project: 'Draft mockups', category: 'Acme Solar', epicTitle: 'acme solar' })],
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
            after: { project: 'Hydrogen pilot', category: 'Acme Solar' },
          },
          create(
            { project: 'Call supplier', category: 'Acme Solar', epicTitle: 'Hydrogen pilot' },
            2
          ),
        ],
        await ctx()
      );
      expect(warnings).toEqual([]);
      expect(proposals[0]).toMatchObject({
        type: 'createEpic',
        projectId: 'proj-acme-solar',
        orgName: 'Northstar Workshop',
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
        answer: 'Jordan is working on Check inverter datasheet.',
        warnings: ['Club Kit is view-only.'],
        changes: [create({ project: 'Buy rope', category: 'Club Kit' })],
      };
      const result = await processVoiceCommand({
        audioFile: audio(),
        groqApiKey: 'k',
        context: await ctx(),
      });
      expect(result.answer).toBe('Jordan is working on Check inverter datasheet.');
      expect(result.proposedChanges).toEqual([]);
      expect(result.warnings).toEqual([
        'Club Kit is view-only.',
        `You have view-only access to "Club Kit", so I left out "Buy rope".`,
      ]);
    });

    it('a resolved proposal can be applied as-is through the projects API service', async () => {
      mockInvokeResult = {
        summary: 'Added a task for Jordan',
        changes: [
          create({
            project: 'Check the inverter datasheet',
            category: 'Acme Solar',
            assignee: 'Jordan',
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
        assigneeName: 'Jordan Example',
        orgName: 'Northstar Workshop',
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
        name: 'Jordan Example',
        email: 'jordan@example.test',
        role: 'member' as const,
      },
      { userId: 'b', name: 'Casey Example', email: 'casey@example.test', role: 'owner' as const },
    ];
    it('handles me words, nobody words and unknowns', () => {
      expect(matchPerson('me', people, 'b').kind).toBe('me');
      expect(matchPerson('Casey Example', people, 'b').kind).toBe('me');
      expect(matchPerson('nobody', people, 'b').kind).toBe('nobody');
      expect(matchPerson('no-one', people, 'b').kind).toBe('nobody');
      expect(matchPerson('Zed', people, 'b').kind).toBe('none');
      expect(matchPerson('', people, 'b').kind).toBe('none');
    });
  });
});
