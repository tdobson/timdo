import { describe, expect, it, vi } from 'vitest';
import { parseVoiceCommand, processVoiceCommand } from '../services/aiService';

let mockInvokeResult: any = {
  summary: 'Processed voice command',
  changes: [],
};
let lastPrompt = '';

vi.mock('../services/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ai')>();
  const fake = () => ({
    transcriber: { transcribe: vi.fn(async () => 'mock transcription') },
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

describe('Voice AI Collaboration & Assignment Parsing', () => {
  const mockAudioFile = new File(['mock audio data'], 'test.webm', { type: 'audio/webm' });

  it('parses task creation with teammate assignment ("for Sarah")', async () => {
    mockInvokeResult = {
      summary: 'Created task assigned to Sarah',
      changes: [
        {
          type: 'create',
          projectId: 'new-project-placeholder-1',
          after: {
            id: 'new-project-placeholder-1',
            project: 'Review OAuth PR',
            status: 'do',
            priority: 8,
            size: '**',
            category: 'XEBIT',
            projectId: 'proj-xebit-1',
            assignee: 'Sarah Jenkins',
          },
        },
      ],
    };

    const result = await processVoiceCommand({
      audioFile: mockAudioFile,
      projects: [],
      groqApiKey: 'mock-key',
    });

    expect(result.proposedChanges).toHaveLength(1);
    const change = result.proposedChanges[0];
    expect(change.type).toBe('create');
    expect(change.after?.project).toBe('Review OAuth PR');
    expect(change.after?.category).toBe('XEBIT');
    expect(change.after?.projectId).toBe('proj-xebit-1');
    expect(change.after?.assignee).toBe('Sarah Jenkins');
  });

  it('parses assignment to current user ("assign to me")', async () => {
    mockInvokeResult = {
      summary: 'Created task assigned to me',
      changes: [
        {
          type: 'create',
          projectId: 'new-project-placeholder-1',
          after: {
            id: 'new-project-placeholder-1',
            project: 'Fix database migration lock',
            status: 'do',
            priority: 9,
            size: '***',
            category: 'Solfit',
            assignee: 'me',
          },
        },
      ],
    };

    const result = await parseVoiceCommand({
      audioFile: mockAudioFile,
      projects: [],
      groqApiKey: 'mock-key',
    });

    expect(result.proposedChanges).toHaveLength(1);
    expect(result.proposedChanges[0].after?.assignee).toBe('me');
  });

  it('parses claiming intent for an existing task ("claim task")', async () => {
    const existingProjects: any[] = [
      {
        id: 'task-1234-abcd',
        project: 'Set up DNS CNAME for staging workers',
        status: 'do',
        priority: 6,
        size: '*',
        category: 'Cloud Infra',
        assignee: null,
      },
    ];

    mockInvokeResult = {
      summary: 'Claimed task Set up DNS CNAME for staging workers',
      changes: [
        {
          type: 'claim',
          projectId: 'task-1234-abcd',
          after: {
            id: 'task-1234-abcd',
            project: 'Set up DNS CNAME for staging workers',
            status: 'do',
            priority: 6,
            size: '*',
            category: 'Cloud Infra',
            assignee: 'me',
          },
        },
      ],
    };

    const result = await processVoiceCommand({
      audioFile: mockAudioFile,
      projects: existingProjects as any,
      groqApiKey: 'mock-key',
    });

    expect(result.proposedChanges).toHaveLength(1);
    const change = result.proposedChanges[0];
    expect(change.type).toBe('claim');
    expect(change.before).toEqual(existingProjects[0]);
    expect(change.after?.assignee).toBe('me');
  });

  it('parses reassigning task to another teammate with update intent', async () => {
    const existingProjects: any[] = [
      {
        id: 'task-5678-efgh',
        project: 'Draft investor deck',
        status: 'do',
        priority: 7,
        size: '****',
        category: 'XEBIT',
        assignee: 'Tim Dobson',
      },
    ];

    mockInvokeResult = {
      summary: 'Reassigned Draft investor deck to sarah@xebit.io',
      changes: [
        {
          type: 'update',
          projectId: 'task-5678-efgh',
          after: {
            id: 'task-5678-efgh',
            project: 'Draft investor deck',
            status: 'do',
            priority: 7,
            size: '****',
            category: 'XEBIT',
            assignee: 'sarah@xebit.io',
          },
        },
      ],
    };

    const result = await processVoiceCommand({
      audioFile: mockAudioFile,
      projects: existingProjects as any,
      groqApiKey: 'mock-key',
    });

    expect(result.proposedChanges).toHaveLength(1);
    const change = result.proposedChanges[0];
    expect(change.type).toBe('update');
    expect((change.before as any)?.assignee).toBe('Tim Dobson');
    expect((change.after as any)?.assignee).toBe('sarah@xebit.io');
  });
});
