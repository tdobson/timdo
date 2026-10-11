import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processVoiceCommand, VOICE_PROMPT_TEMPLATE } from '../services/aiService';
import * as botService from '../services/botService';
import * as taskService from '../services/taskService';
import { loadVoiceContext, resolveProposals } from '../services/voiceContextService';
import { createTestDb, ROBIN, seedCollaboration, STRANGER, TIM } from './helpers/testDb';

const voiceState = vi.hoisted(() => ({
  transcript: 'How many tasks did Fixture Relay create today?',
  promptArgs: null as Record<string, unknown> | null,
  invokeResult: { summary: 'Done', changes: [] as unknown[] },
}));

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: vi.fn().mockImplementation(async () => ({ text: voiceState.transcript })),
      },
    },
  })),
}));

vi.mock('@langchain/core/prompts', () => ({
  PromptTemplate: {
    fromTemplate: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnValue({
        invoke: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
          voiceState.promptArgs = args;
          return voiceState.invokeResult;
        }),
      }),
    }),
  },
}));

vi.mock('@langchain/groq', () => ({
  ChatGroq: vi.fn().mockImplementation(() => ({ withStructuredOutput: vi.fn() })),
}));

const audio = () => new File(['fictional audio'], 'voice.webm', { type: 'audio/webm' });

function addBot(raw: any, id: string, name: string, orgId = 'org-md', creatorId = TIM) {
  const suffix = id.slice(4);
  raw
    .prepare(
      "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by) VALUES (?, ?, ?, 'bot', ?, ?)"
    )
    .run(id, `bot+${suffix}@bots.timdo.invalid`, name, orgId, creatorId);
}

async function addTask(db: any, id: string, botId: string, projectId = 'proj-acme-solar') {
  await taskService.createTask(db, botId, {
    id,
    projectId,
    title: `Fictional task ${id}`,
    status: 'do',
    priority: 5,
    size: '***',
    onDuplicate: 'error',
  });
}

function createProposal(assignee: string) {
  return {
    type: 'create' as const,
    projectId: 'new-project-placeholder-1',
    after: {
      id: 'new-project-placeholder-1',
      project: 'File the test report',
      category: 'Acme Solar',
      assignee,
      status: 'do',
      priority: 5,
      size: '***',
    },
  };
}

let db: any;
let raw: any;
let countSpy: any;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  seedCollaboration(raw);
  voiceState.transcript = 'How many tasks did Fixture Relay create today?';
  voiceState.promptArgs = null;
  voiceState.invokeResult = { summary: 'Done', changes: [] };
});

afterEach(() => {
  vi.useRealTimers();
  countSpy?.mockRestore();
  countSpy = undefined;
});

describe('voice bot identities', () => {
  it('keeps active bots separate from assignable people and never exposes synthetic email', async () => {
    addBot(raw, 'bot|voice-001', 'Fixture Relay');
    const context = await loadVoiceContext(db, TIM);
    const workspace = context.workspaces.find((item) => item.id === 'org-md')!;

    expect(workspace.members.map((member) => member.name).sort()).toEqual([
      'Casey Example',
      'Jordan Example',
    ]);
    expect(workspace.bots).toEqual([
      { userId: 'bot|voice-001', name: 'Fixture Relay', role: 'member' },
    ]);
    expect(JSON.stringify(context)).not.toContain('bots.timdo.invalid');

    await processVoiceCommand({ audioFile: audio(), groqApiKey: 'fictional-test-key', context });
    const prompt = JSON.stringify(voiceState.promptArgs);
    expect(prompt).toContain('Fixture Relay');
    expect(prompt).toContain('not assignable');
    expect(prompt).not.toContain('bots.timdo.invalid');
  });

  it.each([
    ['exact bot name', 'Fixture Relay'],
    ['fuzzy bot name', 'Fixtur'],
    ['fuzzy full bot name', 'Fixture Relai'],
    ['bot id', 'bot|voice-001'],
    ['a name shared with a human', 'Jordan Example'],
  ])('rejects assignment by %s with a clear warning', async (_label, spoken) => {
    addBot(raw, 'bot|voice-001', 'Fixture Relay');
    addBot(raw, 'bot|voice-002', 'Jordan Example');
    const context = await loadVoiceContext(db, TIM);

    const result = resolveProposals([createProposal(spoken)], context);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].assigneeId).toBeNull();
    expect(result.warnings).toContain("Bots can't be assigned tasks, so I left it unassigned.");
  });

  it('keeps an existing assignment unchanged when a bot is requested', async () => {
    addBot(raw, 'bot|voice-001', 'Fixture Relay');
    await taskService.createTask(db, TIM, {
      id: 'existing-voice-task',
      projectId: 'proj-acme-solar',
      title: 'Existing assigned task',
      status: 'do',
      priority: 5,
      size: '***',
      assigneeId: ROBIN,
      onDuplicate: 'error',
    });
    const context = await loadVoiceContext(db, TIM);

    const result = resolveProposals(
      [
        {
          type: 'update',
          projectId: 'existing-voice-task',
          after: {
            id: 'existing-voice-task',
            project: 'Existing assigned task',
            category: 'Acme Solar',
            assignee: 'Fixture Relay',
            status: 'do',
            priority: 5,
            size: '***',
          },
        },
      ],
      context
    );

    expect(result.proposals[0].assigneeId).toBeUndefined();
    expect(result.proposals[0].assigneeName).toBe('Jordan Example');
    expect(result.proposals[0].assigneeChanged).toBe(false);
    expect(result.warnings).toContain(
      "Bots can't be assigned tasks, so I didn't change who it's assigned to."
    );
  });

  it('continues to resolve a human assignment when a different human is also present', async () => {
    addBot(raw, 'bot|voice-001', 'Fixture Relay');
    const context = await loadVoiceContext(db, TIM);

    const result = resolveProposals([createProposal('Jordan')], context);

    expect(result.proposals[0].assigneeId).toBe(ROBIN);
    expect(result.proposals[0].assigneeName).toBe('Jordan Example');
    expect(result.warnings).toEqual([]);
  });
});

describe('today bot task counts in voice context', () => {
  it('does not treat a missing bot row as a zero count', () => {
    expect(VOICE_PROMPT_TEMPLATE).toContain('A missing row is not a zero.');
    expect(VOICE_PROMPT_TEMPLATE).toContain('no visible count for it');
  });

  it.each([
    [
      'ordinary GMT day',
      '2026-01-12T12:00:00.000Z',
      '2026-01-12',
      '2026-01-12T00:00:00.000Z',
      '2026-01-13T00:00:00.000Z',
    ],
    [
      'ordinary BST day',
      '2026-06-01T12:00:00.000Z',
      '2026-06-01',
      '2026-05-31T23:00:00.000Z',
      '2026-06-01T23:00:00.000Z',
    ],
    [
      'the 23-hour spring clock-change day',
      '2026-03-29T12:00:00.000Z',
      '2026-03-29',
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T23:00:00.000Z',
    ],
    [
      'the 25-hour autumn clock-change day',
      '2026-10-25T12:00:00.000Z',
      '2026-10-25',
      '2026-10-24T23:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
    ],
    [
      'UK midnight at the autumn boundary',
      '2026-10-24T23:00:00.000Z',
      '2026-10-25',
      '2026-10-24T23:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
    ],
  ])(
    'requests the inclusive/exclusive Europe/London day window for %s',
    async (_label, now, _day, from, to) => {
      countSpy = vi.spyOn(botService, 'getBotTaskCreationCounts').mockResolvedValue({
        items: [],
        total: 0,
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));

      const context = await loadVoiceContext(db, TIM);

      expect(countSpy).toHaveBeenCalledWith(db, TIM, { from, to, limit: 50 });
      expect(context.botTaskCreationsToday?.localDate).toBe(_day);
    }
  );

  it('includes visible zero-count bots and relevant disabled history, but not private workspaces', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
    raw.exec(`
      INSERT INTO Organisations (id, name, slug, created_by, is_personal)
        VALUES ('org-private', 'Private Workshop', 'private-workshop', '${STRANGER}', 0);
      INSERT INTO OrganisationMembers (id, org_id, user_id, role)
        VALUES ('m-private-owner', 'org-private', '${STRANGER}', 'owner');
      INSERT INTO Projects (id, org_id, key, name)
        VALUES ('proj-private', 'org-private', 'PRV', 'Private Projects');
    `);
    addBot(raw, 'bot|relay-001', 'Fixture Relay');
    addBot(raw, 'bot|quiet-001', 'Fixture Quiet');
    addBot(raw, 'bot|retired-001', 'Fixture Retired');
    addBot(raw, 'bot|private-001', 'Private Fixture Relay', 'org-private', STRANGER);

    await addTask(db, 'relay-task', 'bot|relay-001');
    await addTask(db, 'retired-task', 'bot|retired-001');
    await addTask(db, 'private-task', 'bot|private-001', 'proj-private');
    raw
      .prepare(
        "UPDATE ActivityLog SET summary = 'PRIVATE EVENT SUMMARY' WHERE actor_id = ? AND action = 'created'"
      )
      .run('bot|relay-001');
    raw
      .prepare("UPDATE Users SET disabled_at = '2026-10-25T12:00:00.000Z' WHERE id = ?")
      .run('bot|retired-001');
    raw
      .prepare(
        'INSERT INTO ApiTokens (id, user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?, ?)'
      )
      .run('token-fixture', 'bot|relay-001', 'PRIVATE TOKEN NAME', 'fictional-hash', 'fiction');

    const context = await loadVoiceContext(db, TIM);
    const facts = context.botTaskCreationsToday as any;
    const rows = facts.items as Array<{ botId: string; botName: string; tasksCreated: number }>;

    expect(facts.status).toBe('available');
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ botId: 'bot|relay-001', tasksCreated: 1 }),
        expect.objectContaining({ botId: 'bot|quiet-001', tasksCreated: 0 }),
        expect.objectContaining({ botId: 'bot|retired-001', tasksCreated: 1 }),
      ])
    );
    expect(rows.some((row) => row.botId === 'bot|private-001')).toBe(false);

    await processVoiceCommand({ audioFile: audio(), groqApiKey: 'fictional-test-key', context });
    const prompt = JSON.stringify(voiceState.promptArgs);
    expect(prompt).toContain('Europe/London');
    expect(prompt).toContain('2026-10-24T23:00:00.000Z');
    expect(prompt).toContain('2026-10-26T00:00:00.000Z');
    expect(prompt).toContain('inclusive');
    expect(prompt).toContain('exclusive');
    expect(prompt).toContain('Fixture Quiet');
    expect(prompt).toContain('Fixture Retired');
    expect(prompt).not.toContain('Private Fixture Relay');
    expect(prompt).not.toContain('PRIVATE EVENT SUMMARY');
    expect(prompt).not.toContain('PRIVATE TOKEN NAME');
    expect(prompt).not.toContain('bots.timdo.invalid');
  });

  it('marks failed counts unavailable instead of reporting zero', async () => {
    countSpy = vi
      .spyOn(botService, 'getBotTaskCreationCounts')
      .mockRejectedValue(new Error('PRIVATE DATABASE FAILURE'));

    const context = await loadVoiceContext(db, TIM);
    const facts = context.botTaskCreationsToday as any;

    expect(facts).toMatchObject({ status: 'unavailable', total: null, omitted: null, items: [] });
    await processVoiceCommand({ audioFile: audio(), groqApiKey: 'fictional-test-key', context });
    const prompt = String(voiceState.promptArgs?.botTaskCreations);
    expect(prompt).toContain('unavailable');
    expect(prompt).not.toContain('0 bot');
    expect(prompt).not.toContain('PRIVATE DATABASE FAILURE');
  });

  it('caps prompt rows at 50 and reports the total and omitted count', async () => {
    for (let index = 1; index <= 57; index++) {
      const suffix = String(index).padStart(3, '0');
      addBot(raw, `bot|cap-${suffix}`, `Fixture Bot ${suffix}`);
    }

    const context = await loadVoiceContext(db, TIM);
    const facts = context.botTaskCreationsToday as any;
    expect(facts.items).toHaveLength(50);
    expect(facts.total).toBe(57);
    expect(facts.omitted).toBe(7);

    await processVoiceCommand({ audioFile: audio(), groqApiKey: 'fictional-test-key', context });
    const prompt = String(voiceState.promptArgs?.botTaskCreations);
    expect(prompt).toContain('total rows: 57');
    expect(prompt).toContain('omitted: 7');
    expect(prompt.match(/^- /gm)).toHaveLength(50);
    expect(prompt).not.toContain('Fixture Bot 057');
  });
});
