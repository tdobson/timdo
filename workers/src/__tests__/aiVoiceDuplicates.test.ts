/**
 * Voice and likely duplicates: when the model proposes a new task, the server looks for similar
 * open tasks in the workspace it would land in, so the review screen can offer "Add as a note
 * there instead". Groq is mocked; the database is node:sqlite with the live schema (and its FTS
 * index), so the lookups are the real similarService ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processVoiceCommand } from '../services/aiService';
import * as projectService from '../services/projectService';
import {
  addSimilarTasks,
  loadVoiceContext,
  resolveProposals,
  SIMILAR_LOOKUPS_PER_COMMAND,
  type VoiceContext,
} from '../services/voiceContextService';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: vi.fn().mockImplementation(async () => ({ text: 'mock transcription' })),
      },
    },
  })),
}));

let mockInvokeResult: any = { summary: 'Nothing', changes: [] };

vi.mock('@langchain/core/prompts', () => ({
  PromptTemplate: {
    fromTemplate: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnValue({
        invoke: vi.fn().mockImplementation(async () => mockInvokeResult),
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

describe('voice and likely duplicates', () => {
  let db: any;
  let raw: any;

  const task = (n: number, project: string, extra: Record<string, any> = {}) =>
    projectService.createProject(db, TIM, {
      id: uuid(n),
      project,
      status: 'do',
      priority: 5,
      size: '**',
      projectId: 'proj-acme-solar',
      ...extra,
    });

  beforeEach(async () => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
    mockInvokeResult = { summary: 'Nothing', changes: [] };
    await task(1, 'Broken offer page', { assigneeId: ROBIN });
    await task(2, 'Order inverter brackets');
    await task(3, 'Renew passport photos', { projectId: 'proj-personal' });
  });

  const ctx = () => loadVoiceContext(db, TIM);
  const resolveWithSimilar = async (changes: any[], c?: VoiceContext) => {
    const context = c ?? (await ctx());
    const { proposals } = resolveProposals(changes, context);
    await addSimilarTasks(proposals, context);
    return proposals;
  };

  it('a proposed task like an open one carries it, with its project and assignee', async () => {
    const [p] = await resolveWithSimilar([
      create({ project: 'Fix the offer page', category: 'Acme Solar' }),
    ]);
    expect(p.similar).toHaveLength(1);
    expect(p.similar![0]).toMatchObject({
      id: uuid(1),
      shortId: uuid(1).slice(0, 8),
      title: 'Broken offer page',
      projectId: 'proj-acme-solar',
      projectName: 'Acme Solar',
      orgName: 'Northstar Workshop',
      assigneeName: 'Jordan Example',
    });
  });

  it('looks in the workspace the task would land in, not the others', async () => {
    // "Passport photos" is in Casey's personal workspace; this lands in Northstar Workshop
    const [shared] = await resolveWithSimilar([
      create({ project: 'Passport photos for the site team', category: 'Acme Solar' }),
    ]);
    expect(shared.similar).toBeUndefined();
    const [personal] = await resolveWithSimilar([
      create({ project: 'Passport photos again', category: 'Personal' }),
    ]);
    expect(personal.similar?.map((s) => s.title)).toEqual(['Renew passport photos']);
  });

  it('a new project still checks the workspace it will be made in', async () => {
    const [p] = await resolveWithSimilar([
      create({ project: 'New passport photos', category: 'Holidays' }),
    ]);
    expect(p).toMatchObject({ isNewProject: true, projectId: null, orgId: 'org-tim' });
    expect(p.similar?.map((s) => s.id)).toEqual([uuid(3)]);
  });

  it('done and deleted tasks are never offered', async () => {
    await projectService.updateProject(db, TIM, uuid(1), { status: 'done' });
    await projectService.deleteProject(db, TIM, uuid(2));
    const proposals = await resolveWithSimilar([
      create({ project: 'Fix the offer page', category: 'Acme Solar' }, 1),
      create({ project: 'Order more inverter brackets', category: 'Acme Solar' }, 2),
    ]);
    expect(proposals.map((p) => p.similar)).toEqual([undefined, undefined]);
  });

  it('nothing is offered for a one-word title or a title with nothing in common', async () => {
    const proposals = await resolveWithSimilar([
      create({ project: 'Offer', category: 'Acme Solar' }, 1),
      create({ project: 'Book the minibus for Saturday', category: 'Acme Solar' }, 2),
    ]);
    expect(proposals.map((p) => p.similar)).toEqual([undefined, undefined]);
  });

  it('only new tasks are checked: updates, epics and projects are not', async () => {
    const proposals = await resolveWithSimilar([
      {
        type: 'update',
        projectId: uuid(2),
        after: { id: uuid(2), project: 'Order inverter brackets now', status: 'do' },
      },
      {
        type: 'createEpic',
        projectId: 'new-epic-placeholder-1',
        after: { project: 'Offer page fixes', category: 'Acme Solar' },
      },
      {
        type: 'createProject',
        projectId: 'new-project-placeholder-9',
        after: { project: 'Offer page work' },
      },
    ]);
    expect(proposals.map((p) => [p.type, p.similar])).toEqual([
      ['update', undefined],
      ['createEpic', undefined],
      ['createProject', undefined],
    ]);
  });

  it(`looks up at most ${SIMILAR_LOOKUPS_PER_COMMAND} new tasks per command`, async () => {
    expect(SIMILAR_LOOKUPS_PER_COMMAND).toBe(5);
    const c = await ctx();
    const findSimilar = vi.fn(c.findSimilar!);
    const changes = Array.from({ length: 7 }, (_, i) =>
      create({ project: `Fix the offer page ${i + 1}`, category: 'Acme Solar' }, i + 1)
    );
    const proposals = await resolveWithSimilar(changes, { ...c, findSimilar });
    expect(findSimilar).toHaveBeenCalledTimes(5);
    expect(proposals.map((p) => !!p.similar)).toEqual([true, true, true, true, true, false, false]);
    // Scoped by the project it lands in, three at most
    expect(findSimilar).toHaveBeenCalledWith({
      title: 'Fix the offer page 1',
      projectId: 'proj-acme-solar',
      limit: 3,
    });
  });

  it('a lookup that fails only means no hint for that task', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = await ctx();
    const findSimilar = vi
      .fn()
      .mockRejectedValueOnce(new Error('D1 is having a moment'))
      .mockImplementation(c.findSimilar!);
    const proposals = await resolveWithSimilar(
      [
        create({ project: 'Fix the offer page', category: 'Acme Solar' }, 1),
        create({ project: 'Order inverter brackets again', category: 'Acme Solar' }, 2),
      ],
      { ...c, findSimilar }
    );
    expect(proposals[0].similar).toBeUndefined();
    expect(proposals[1].similar?.map((s) => s.id)).toEqual([uuid(2)]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a context built without the database gives no hints and no errors', async () => {
    const { findSimilar: _unused, ...plain } = await ctx();
    const [p] = await resolveWithSimilar(
      [create({ project: 'Fix the offer page', category: 'Acme Solar' })],
      plain
    );
    expect(p.similar).toBeUndefined();
  });

  it('only shows tasks the speaker can see', async () => {
    // Jordan is a member of Northstar Workshop only: Casey's personal tasks never appear
    const robin = await loadVoiceContext(db, ROBIN);
    const [p] = await resolveWithSimilar(
      [create({ project: 'Renew passport photos', category: 'Acme Solar' })],
      robin
    );
    expect(p.similar).toBeUndefined();
  });

  it('end to end: the review screen gets the similar tasks on the proposal', async () => {
    mockInvokeResult = {
      summary: 'Added a task to fix the offer page',
      changes: [
        create({ project: 'Fix the offer page', category: 'Acme Solar' }, 1),
        create({ project: 'Book the minibus for Saturday', category: 'Acme Solar' }, 2),
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
      similar: [{ id: uuid(1), title: 'Broken offer page', projectName: 'Acme Solar' }],
    });
    expect(result.proposedChanges[1]).not.toHaveProperty('similar');
    // The result is plain JSON for the client: no functions leak out of the context
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
