import { describe, expect, it, vi } from 'vitest';
import { parseVoiceCommand } from '../services/aiService';

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
  summary: 'Created task',
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

describe('Voice AI Hierarchy Parsing', () => {
  it('parses category and epic from natural speech', async () => {
    mockInvokeResult = {
      summary: 'Created 1 new project',
      changes: [
        {
          type: 'create',
          projectId: 'new-project-placeholder-1',
          after: {
            id: 'new-project-placeholder-1',
            project: 'draft design mockups',
            status: 'do',
            priority: 5,
            size: '***',
            category: 'Acme Solar',
            epicTitle: 'Acme Solar',
          },
        },
      ],
    };

    const mockAudioFile = new File(['mock audio data'], 'test.webm', { type: 'audio/webm' });
    const result = await parseVoiceCommand({
      audioFile: mockAudioFile,
      projects: [],
      groqApiKey: 'mock-key',
    });

    expect(result.proposedChanges).toHaveLength(1);
    expect(result.proposedChanges[0].after?.category).toBe('Acme Solar');
    expect(result.proposedChanges[0].after?.epicTitle).toBe('Acme Solar');
    expect(result.proposedChanges[0].after?.project).toBe('draft design mockups');
  });

  it('parses create epic intent', async () => {
    mockInvokeResult = {
      summary: 'Created 1 new epic',
      changes: [
        {
          type: 'createEpic',
          projectId: 'new-epic-placeholder-1',
          after: {
            id: 'new-epic-placeholder-1',
            project: 'Get Acme Solar Live',
            status: 'do',
            priority: 5,
            size: '***',
            category: 'Acme Solar',
          },
        },
      ],
    };

    const mockAudioFile = new File(['mock audio data'], 'test.webm', { type: 'audio/webm' });
    const result = await parseVoiceCommand({
      audioFile: mockAudioFile,
      projects: [],
      groqApiKey: 'mock-key',
    });

    expect(result.proposedChanges).toHaveLength(1);
    expect(result.proposedChanges[0].type).toBe('createEpic');
    expect(result.proposedChanges[0].after?.project).toBe('Get Acme Solar Live');
    expect(result.proposedChanges[0].after?.category).toBe('Acme Solar');
  });

  it('parses goal and category links', async () => {
    mockInvokeResult = {
      summary: 'Created task for goal',
      changes: [
        {
          type: 'create',
          projectId: 'new-project-placeholder-1',
          after: {
            id: 'new-project-placeholder-1',
            project: 'Run 5k marathon prep',
            status: 'do',
            priority: 7,
            size: '****',
            category: 'Personal',
            goalTitle: 'Maintain Physical Health',
          },
        },
      ],
    };

    const mockAudioFile = new File(['mock audio data'], 'test.webm', { type: 'audio/webm' });
    const result = await parseVoiceCommand({
      audioFile: mockAudioFile,
      projects: [],
      groqApiKey: 'mock-key',
    });

    expect(result.proposedChanges).toHaveLength(1);
    expect(result.proposedChanges[0].after?.category).toBe('Personal');
    expect(result.proposedChanges[0].after?.goalTitle).toBe('Maintain Physical Health');
  });
});
