/**
 * Voice and task refs: the prompt and context the model sees (kinds in use, canonical refs on
 * compact tasks), and how proposed links are checked before the review screen shows them.
 * Groq is mocked; the database is node:sqlite with the live schema.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processVoiceCommand, VOICE_PROMPT_TEMPLATE } from '../services/aiService';
import * as projectService from '../services/projectService';
import * as refService from '../services/refService';
import {
  describeRefKinds,
  loadVoiceContext,
  resolveProposals,
  spokenDigits,
} from '../services/voiceContextService';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

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

const update = (id: string, after: Record<string, any>) => ({
  type: 'update' as const,
  projectId: id,
  after: { id, project: 'Broken offer page', status: 'do', priority: 7, size: '**', ...after },
});

describe('voice and task refs', () => {
  let db: any;
  let raw: any;

  beforeEach(async () => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
    mockInvokeResult = { summary: 'Nothing', changes: [] };
    lastInvokeArgs = null;
    await projectService.createProject(db, TIM, {
      id: uuid(1),
      project: 'Broken offer page',
      status: 'do',
      priority: 7,
      size: '**',
      projectId: 'proj-acme-solar',
    });
    await projectService.createProject(db, TIM, {
      id: uuid(2),
      project: 'Renew passport',
      status: 'do',
      priority: 3,
      size: '*',
      category: 'Personal',
      assigneeId: null,
    });
    for (const [ref, role] of [
      ['https://github.com/acme/widgets/issues/12', 'link'],
      ['forum.post:4411', 'source'],
      ['acme.member:123456', 'reported_by'],
    ] as const) {
      await refService.addRef(db, TIM, uuid(1), { ref, role });
    }
  });

  const ctx = (transcript = '') => loadVoiceContext(db, TIM, transcript);
  const resolve = async (changes: any[]) => resolveProposals(changes, await ctx());

  describe('context', () => {
    it('lists the kinds in use per workspace, with GitHub repositories and an example id', async () => {
      const text = describeRefKinds(await ctx());
      expect(text).toBe(
        '- Northstar Workshop: acme.member (e.g. 123456), forum.post (e.g. 4411), github.issue (acme/widgets)'
      );
    });

    it('says so when no workspace has links yet', async () => {
      raw.exec('DELETE FROM TaskRefs');
      expect(describeRefKinds(await ctx())).toBe('(none yet)');
    });

    it('gives the model the kinds line and canonical refs on tasks, without labels or URLs', async () => {
      await refService.addRef(db, TIM, uuid(1), {
        ref: 'https://forum.example.org/t/offers/99',
        label: 'Jordan Example on the forum',
      });
      await processVoiceCommand({ audioFile: audio(), groqApiKey: 'k', context: await ctx() });
      expect(lastInvokeArgs.refKinds).toContain('github.issue (acme/widgets)');
      expect(lastInvokeArgs.refKinds).not.toContain('forum.example.org');
      const tasks = JSON.parse(lastInvokeArgs.projects);
      expect(tasks.find((t: any) => t.id === uuid(1)).refs).toEqual([
        'forum.post:4411',
        'acme.member:123456',
        'github.issue:acme/widgets#12',
        'url:https://forum.example.org/t/offers/99',
      ]);
      expect(tasks.find((t: any) => t.id === uuid(2)).refs).toBeUndefined();
      expect(lastInvokeArgs.projects).not.toContain('Jordan Example');
      expect(lastInvokeArgs.projects).not.toContain('https://github.com');
    });

    it('done tasks keep their refs so questions about links can be answered', async () => {
      await projectService.updateProject(db, TIM, uuid(1), { status: 'done' });
      await processVoiceCommand({
        audioFile: audio(),
        groqApiKey: 'k',
        context: await ctx('Broken offer page'),
      });
      const done = JSON.parse(lastInvokeArgs.projects).find((t: any) => t.id === uuid(1));
      expect(done.refs).toContain('github.issue:acme/widgets#12');
    });
  });

  describe('prompt', () => {
    it('explains refs, only when explicitly mentioned, with fictional examples and no em-dashes', () => {
      expect(VOICE_PROMPT_TEMPLATE).toContain('{refKinds}');
      expect(VOICE_PROMPT_TEMPLATE).toContain(
        'ONLY add a link when the user explicitly mentions one'
      );
      expect(VOICE_PROMPT_TEMPLATE).toContain('"after.refs"');
      expect(VOICE_PROMPT_TEMPLATE).toContain('"after.removeRefs"');
      expect(VOICE_PROMPT_TEMPLATE).toContain('"reported by member 4411"');
      expect(VOICE_PROMPT_TEMPLATE).toContain('leave the link out and say so in "warnings"');
      expect(VOICE_PROMPT_TEMPLATE).not.toContain('\u2014');
    });

    it('is a valid template: every brace is a variable the service fills in', async () => {
      const { PromptTemplate } =
        await vi.importActual<typeof import('@langchain/core/prompts')>('@langchain/core/prompts');
      const template = PromptTemplate.fromTemplate(VOICE_PROMPT_TEMPLATE);
      expect([...template.inputVariables].sort()).toEqual([
        'epics',
        'me',
        'projects',
        'refKinds',
        'taskSample',
        'timestamp',
        'transcript',
        'workspaces',
      ]);
    });
  });

  describe('links on new tasks', () => {
    it('completes "issue 12 on widgets" and "member four four one one" from what is in use', async () => {
      const { proposals, warnings } = await resolve([
        create({
          project: 'Fix the offer form',
          category: 'Acme Solar',
          refs: [
            { ref: 'github.issue:widgets#12' },
            { ref: 'member:four four one one', role: 'reported-by' },
          ],
        }),
      ]);
      expect(warnings).toEqual([]);
      expect(proposals[0].refs).toEqual([
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
      ]);
      // The raw model output does not leak into the task fields
      expect(proposals[0].after).not.toHaveProperty('refs');
      expect(proposals[0].after).not.toHaveProperty('removeRefs');
    });

    it('accepts pasted URLs and bare strings, and drops duplicates', async () => {
      const { proposals } = await resolve([
        create({
          project: 'Look at PR',
          category: 'Acme Solar',
          refs: [
            'https://github.com/acme/widgets/pull/7',
            { ref: 'github.pr:acme/widgets#7', role: 'link' },
          ],
        }),
      ]);
      expect(proposals[0].refs).toEqual([
        expect.objectContaining({ ref: 'github.pr:acme/widgets#7' }),
      ]);
    });

    it('leaves out an issue whose repository is unknown, saying what was heard', async () => {
      const { proposals, warnings } = await resolve([
        create({
          project: 'Gadget bug',
          category: 'Acme Solar',
          refs: [{ ref: 'github.issue:gadgets#3' }],
        }),
        create(
          { project: 'Passport issue', category: 'Personal', refs: [{ ref: 'github.issue:3' }] },
          2
        ),
      ]);
      expect(proposals.map((p) => p.refs)).toEqual([undefined, undefined]);
      expect(warnings).toEqual([
        "I heard GitHub issue 3 on gadgets but couldn't tell which repository it's in, so I left it out. Paste its URL on the task instead.",
        "I heard GitHub issue 3 but couldn't tell which repository it's in, so I left it out. Paste its URL on the task instead.",
      ]);
    });

    it('uses the only repository in the workspace when none was named', async () => {
      const { proposals } = await resolve([
        create({
          project: 'Widget bug',
          category: 'Acme Solar',
          refs: [{ ref: 'github.issue:#5' }],
        }),
      ]);
      expect(proposals[0].refs?.[0].ref).toBe('github.issue:acme/widgets#5');
    });

    it('flags a full repository nobody links to yet, but keeps it', async () => {
      const { proposals, warnings } = await resolve([
        create({
          project: 'Other repo',
          category: 'Acme Solar',
          refs: ['github.issue:acme/gadgets#9'],
        }),
      ]);
      expect(proposals[0].refs?.[0].ref).toBe('github.issue:acme/gadgets#9');
      expect(warnings).toEqual([
        'No task links to the acme/gadgets repository yet, so check github.issue:acme/gadgets#9 is right before applying.',
      ]);
    });

    it('drops refs it cannot read or place, and flags new kinds', async () => {
      const { proposals, warnings } = await resolve([
        create({
          project: 'Helpdesk follow-up',
          category: 'Acme Solar',
          refs: [
            { ref: 'the forum thing' },
            { ref: 'ticket:55' },
            { ref: 'helpdesk.ticket:55', role: 'about' },
            { ref: 'acme.member:77', role: 'boss' },
          ],
        }),
      ]);
      expect(proposals[0].refs?.map((r) => [r.ref, r.role])).toEqual([
        ['helpdesk.ticket:55', 'about'],
        ['acme.member:77', 'link'],
      ]);
      expect(warnings).toEqual([
        'I couldn\'t make a link out of "the forum thing", so I left it out.',
        'I couldn\'t tell which system "ticket:55" belongs to, so I left that link out.',
        'Nothing in the Northstar Workshop workspace links to helpdesk.ticket yet, so check helpdesk.ticket:55 is right before applying.',
        'I didn\'t recognise "boss" as a role (link, source, reported by or about), so acme.member:77 is added as a plain link.',
      ]);
    });

    it('turns a source another task already has into a plain link, naming that task', async () => {
      const { proposals, warnings } = await resolve([
        create({
          project: 'Offer page again',
          category: 'Acme Solar',
          refs: [{ ref: 'forum.post:4411', role: 'source' }],
        }),
      ]);
      expect(proposals[0].refs).toEqual([
        expect.objectContaining({ ref: 'forum.post:4411', role: 'link' }),
      ]);
      expect(warnings).toEqual([
        'forum.post:4411 is already the source of "Broken offer page", so it\'s added as a plain link instead.',
      ]);
    });

    it('a source in another workspace is no clash', async () => {
      const { proposals, warnings } = await resolve([
        create({
          project: 'Personal copy',
          category: 'Personal',
          refs: [{ ref: 'forum.post:4411', role: 'source' }],
        }),
      ]);
      expect(proposals[0].refs?.[0]).toMatchObject({ ref: 'forum.post:4411', role: 'source' });
      expect(warnings).toEqual([
        'Nothing in the Casey Example workspace links to forum.post yet, so check forum.post:4411 is right before applying.',
      ]);
    });
  });

  describe('links on existing tasks', () => {
    it('skips links the task already has (the model echoing them back)', async () => {
      const { proposals, warnings } = await resolve([
        update(uuid(1), {
          refs: [
            'forum.post:4411',
            'acme.member:123456',
            { ref: 'forum.post:4411', role: 'source' },
            { ref: 'github.issue:acme/widgets#12' },
            { ref: 'github.pr:widgets#7' },
            { ref: 'acme.member:123456', role: 'about' },
          ],
        }),
      ]);
      expect(warnings).toEqual([]);
      // Only what is new: the PR, and the reporter in a role it doesn't have yet
      expect(proposals[0].refs?.map((r) => [r.ref, r.role])).toEqual([
        ['github.pr:acme/widgets#7', 'link'],
        ['acme.member:123456', 'about'],
      ]);
    });

    it('removes links by canonical form, short form or kind and id, with their roles', async () => {
      const { proposals, warnings } = await resolve([
        update(uuid(1), { removeRefs: ['#12', 'forum.post:4411', 'member:123456'] }),
      ]);
      expect(warnings).toEqual([]);
      expect(proposals[0].removeRefs).toEqual([
        { ref: 'github.issue:acme/widgets#12', role: 'link' },
        { ref: 'forum.post:4411', role: 'source' },
        { ref: 'acme.member:123456', role: 'reported_by' },
      ]);
    });

    it('warns about links that are not on the task, or that match more than one', async () => {
      await refService.addRef(db, TIM, uuid(1), { ref: 'github.pr:acme/widgets#12' });
      const { proposals, warnings } = await resolve([
        update(uuid(1), { removeRefs: ['github.issue:acme/widgets#99', '12'] }),
      ]);
      expect(proposals[0].removeRefs).toBeUndefined();
      expect(warnings).toEqual([
        '"Broken offer page" isn\'t linked to "github.issue:acme/widgets#99", so there was nothing to remove.',
        '"12" matches more than one link on "Broken offer page" (github.issue:acme/widgets#12, github.pr:acme/widgets#12), so I didn\'t remove any.',
      ]);
    });

    it('passes a well-formed removal through when the task list has no refs (old client cache)', async () => {
      const c = await ctx();
      c.tasks = c.tasks.map((t) => ({ ...t, refs: undefined }));
      const { proposals } = resolveProposals(
        [update(uuid(1), { removeRefs: ['forum.post:4411', 'what'] })],
        c
      );
      expect(proposals[0].removeRefs).toEqual([{ ref: 'forum.post:4411', role: null }]);
      expect(proposals[0].warnings).toEqual([
        'I couldn\'t tell which link "what" is, so I didn\'t remove it.',
      ]);
    });

    it('never carries links on deletes or claims', async () => {
      const { proposals } = await resolve([
        { type: 'claim', projectId: uuid(2), after: { refs: ['forum.post:1'] } },
        { type: 'delete', projectId: uuid(1), after: { removeRefs: ['forum.post:4411'] } },
      ]);
      expect(proposals.map((p) => [p.type, p.refs, p.removeRefs])).toEqual([
        ['claim', undefined, undefined],
        ['delete', undefined, undefined],
      ]);
    });
  });

  describe('spokenDigits', () => {
    it.each([
      ['four four one one', '4411'],
      ['one-two-three', '123'],
      ['oh seven', '07'],
      ['4411', '4411'],
      ['forty four', 'forty four'],
      ['acme/widgets', 'acme/widgets'],
    ])('%s -> %s', (input, expected) => {
      expect(spokenDigits(input)).toBe(expected);
    });
  });

  it('end to end: refs come back on the proposal for the review screen', async () => {
    mockInvokeResult = {
      summary: 'Added a task linked to issue 12',
      changes: [
        create({
          project: 'Fix the offer form',
          category: 'Acme Solar',
          refs: [{ ref: 'github.issue:widgets#12', role: 'link' }],
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
      refs: [{ ref: 'github.issue:acme/widgets#12', role: 'link' }],
    });
  });
});
