import { describe, expect, it, vi } from 'vitest';
import { parseVoiceCommand, processVoiceCommand } from '../services/aiService';

// Mock groq-sdk and @langchain/groq
vi.mock('groq-sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      audio: {
        transcriptions: {
          create: vi.fn().mockResolvedValue({ text: 'mock transcription' }),
        },
      },
    })),
  };
});

let mockInvokeResult: any = {
  summary: 'Processed voice command',
  changes: [],
};

vi.mock('@langchain/core/prompts', () => {
  return {
    PromptTemplate: {
      fromTemplate: vi.fn().mockReturnValue({
        pipe: vi.fn().mockReturnValue({
          invoke: vi.fn().mockImplementation(async () => mockInvokeResult),
        }),
      }),
    },
  };
});

vi.mock('@langchain/groq', () => {
  return {
    ChatGroq: vi.fn().mockImplementation(() => ({
      withStructuredOutput: vi.fn(),
    })),
  };
});

describe('Voice AI Collaboration & Assignment Parsing', () => {
  const mockAudioFile = new File(['mock audio data'], 'test.webm', { type: 'audio/webm' });

  it('parses task creation with teammate assignment ("for Taylor")', async () => {
    mockInvokeResult = {
      summary: 'Created task assigned to Taylor',
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
            category: 'Northstar Workshop',
            projectId: 'proj-northstar-1',
            assignee: 'Taylor Example',
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
    expect(change.after?.category).toBe('Northstar Workshop');
    expect(change.after?.projectId).toBe('proj-northstar-1');
    expect(change.after?.assignee).toBe('Taylor Example');
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
            category: 'Acme Solar',
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
        category: 'Northstar Workshop',
        assignee: 'Casey Example',
      },
    ];

    mockInvokeResult = {
      summary: 'Reassigned Draft investor deck to taylor@example.test',
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
            category: 'Northstar Workshop',
            assignee: 'taylor@example.test',
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
    expect((change.before as any)?.assignee).toBe('Casey Example');
    expect((change.after as any)?.assignee).toBe('taylor@example.test');
  });
});
