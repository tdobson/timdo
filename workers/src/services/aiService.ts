import { z } from 'zod';
import type { Project } from '../../../app/types/project.types';
import { providersForGroqKey, type AiProviders, type StructuredLlm } from './ai';
import { renderPrompt } from './ai/schema';
import {
  compactTasks,
  describeEpics,
  describeWorkspaces,
  resolveProposals,
  type RawChange,
  type VoiceContext,
} from './voiceContextService';

interface ProcessVoiceCommandArgs {
  audioFile: File;
  /** The caller's tasks. Ignored when `context` is given (it carries its own tasks). */
  projects?: Project[];
  /** The transcription and LLM services to use (see ./ai). */
  ai?: AiProviders;
  /** Older callers pass a Groq key instead; that means Groq with the default models. */
  groqApiKey?: string;
  /**
   * What the signed-in user can see and who they work with, from loadVoiceContext().
   * When present, proposals are checked and resolved to ids before they're returned.
   */
  context?: VoiceContext;
}

// Zod schema for a project/task or entity
const projectSchema = z.object({
  id: z
    .string()
    .describe(
      "The unique ID of the project. For new projects, you MUST use a placeholder in the format 'new-project-placeholder-1'."
    ),
  project: z.string().describe('The name of the project or task or epic title.'),
  reason: z.string().optional().describe('The reason for the project.'),
  status: z
    .enum(['do', 'delay', 'done', 'delegate', 'awaiting'])
    .describe('The current status of the project.'),
  priority: z.number().min(1).max(10).describe('The priority of the project from 1 to 10.'),
  size: z
    .enum(['*', '**', '***', '****', '*****'])
    .describe('The size or complexity of the project.'),
  notes: z.string().optional().describe('Any notes for the project.'),
  category: z
    .string()
    .nullable()
    .optional()
    .describe('The high-level category/project area, e.g. "Solfit", "Crew", "Personal".'),
  projectId: z
    .string()
    .nullable()
    .optional()
    .describe('The project ID or key if specified (e.g. "proj-xebit-1", "XEB").'),
  assignee: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Who the task is for: a person\'s name or email as listed under People, "me" for the signed-in user, or "unassigned". Omit when the user does not mention anyone.'
    ),
  workspace: z
    .string()
    .nullable()
    .optional()
    .describe(
      'For createProject only: the workspace to add the project to, if the user names one.'
    ),
  epicTitle: z
    .string()
    .nullable()
    .optional()
    .describe('The title of the linked epic, if mentioned (e.g. "Acme Solar").'),
  goalTitle: z
    .string()
    .nullable()
    .optional()
    .describe('The title of the linked life goal, if mentioned.'),
  statusLastChangedOn: z
    .string()
    .optional()
    .describe('The ISO 8601 datetime string when the status was last changed.'),
  awaitUntil: z
    .string()
    .nullable()
    .optional()
    .describe(
      "When status is 'awaiting', the ISO date (YYYY-MM-DD) when this project should return to 'do'."
    ),
  gmailThreadId: z
    .string()
    .nullable()
    .optional()
    .describe('The Gmail thread ID associated with this project, if any.'),
});

// Zod schema for the expected LLM output
const zodSchema = z.object({
  summary: z
    .string()
    .describe('A concise, human-readable summary of the changes made, to be shown to the user.'),
  answer: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Only when the user asks a question about their tasks (e.g. "What is Robin working on?"): a short, plain answer based on the tasks listed. Omit otherwise.'
    ),
  warnings: z
    .array(z.string())
    .optional()
    .describe(
      'Short, plain explanations of anything you could not do, e.g. a change to a view-only project.'
    ),
  changes: z
    .array(
      z.object({
        type: z
          .enum(['create', 'update', 'delete', 'createEpic', 'createProject', 'claim'])
          .describe(
            'The type of change: "create" (for a new task), "update" (existing task), "delete", "createEpic" (new epic), "createProject" (new project/category), or "claim" (claim unassigned task).'
          ),
        projectId: z
          .string()
          .describe(
            'The ID of the project being changed. For new projects/epics, use new-project-placeholder-N or new-epic-placeholder-N.'
          ),
        after: projectSchema
          .optional()
          .describe('The project data after the change. Omit for deletions.'),
      })
    )
    .describe('An array of changes to be made to projects, epics, or categories.'),
});

function resolveProviders(args: { ai?: AiProviders; groqApiKey?: string }): AiProviders {
  if (args.ai) {
    return args.ai;
  }
  if (args.groqApiKey) {
    return providersForGroqKey(args.groqApiKey);
  }
  throw new Error('No AI providers were given');
}

const VOICE_PROMPT = `You are an expert project management assistant for an application called TimDo.
Your task is to understand a user's request from a voice transcript and propose changes to their tasks, projects (categories) and epics.

HOW TIMDO IS ORGANISED:
- Workspaces contain projects. Projects contain epics and tasks. A task's "category" is the name of its project.
- Some workspaces are shared. Everyone in a workspace sees all of its projects and tasks.
- Each person has a role in each workspace: owner, admin, member or viewer. Viewers are VIEW ONLY.
- A task can be assigned to any person in its own workspace, and only to them.

THE SIGNED-IN USER (the person speaking):
{me}
"me", "my", "mine", "myself" and "I" mean this person.

WORKSPACES, PROJECTS AND PEOPLE:
{workspaces}

EPICS:
{epics}

You will be given the user's transcript and a JSON array of the tasks they can see. Each task shows its category (project), workspace and assignee.

Your instructions are:
1.  Analyze the transcript to understand the user's intent. The user might want to create, update, or delete one or more tasks, create a new epic, create a new project, assign a task to someone, claim a task, or ask a question about the tasks.
2.  Based on the intent, generate a list of proposed changes:
    -   **Creates (Tasks)**: Use type "create" and provide full task data in "after". Use placeholder IDs like 'new-project-placeholder-1', 'new-project-placeholder-2', etc. Default priority to 5 and size to '***' if not specified. If assignment is mentioned (e.g. "for Robin", "assign to Robin", "assign to me"), set "after.assignee".
    -   **Claim Task**: When the user says "claim task <name>", "claim this", "I'll take <task>", or wants to take ownership of an existing task, use type "claim", set the existing task ID in "projectId", and set "after.assignee" to "me".
    -   **Create Epic**: When the user says "new epic, <title>" or indicates creating a new epic, use type "createEpic" and provide the title in "after.project", the project name in "after.category" (if mentioned), and a placeholder ID like 'new-epic-placeholder-1'.
    -   **Create Project**: Only when the user clearly asks for a new project (e.g. "new project, <name>", "start a project called <name>"), use type "createProject" with the name in "after.project". If they name a workspace for it, put it in "after.workspace".
    -   **Category / Epic / Goal Recognition**:
        - Phrases like "in Solfit", "for Migrating Dragons", "under Personal", or a project name at the start of a sentence (e.g. "Solfit, add a task...") set "after.category".
        - "after.category" MUST be the exact name of one of the projects listed above. Speech-to-text often mishears names, so pick the closest listed project (e.g. "sole fit" is "Solfit"). Only use a name that isn't listed when the user clearly asks for a new project.
        - Phrases like "linked to Acme Solar", "for Acme solar", or mentioning an epic name set "after.epicTitle" to that epic's exact title from the list above.
        - Phrases like "for goal <title>" or linking to a goal set "after.goalTitle".
    -   **Assignment Recognition**:
        - Phrases like "for Robin", "assign to Robin", "give it to robin@example.com", "Robin should..." set "after.assignee" to that person's full name as listed under People.
        - The person must be in the workspace of the task's project. If they aren't, still set "after.assignee" to the name you heard; TimDo will check it and tell the user.
        - "assign to me", "mine", "for myself", "I'll do it" set "after.assignee" to "me".
        - "unassign it", "nobody's doing it" set "after.assignee" to "unassigned".
        - Never change the assignee of a task unless the user asks.
    -   **Updates**: Use type "update" and provide the full updated task data in "after", keeping the task's current category unless the user asks to move it. If status changes, update 'statusLastChangedOn' to current timestamp.
    -   **Deletes**: Use type "delete" and omit the "after" field.
    -   **View-only projects**: NEVER propose a change to a task, epic or project in a workspace where the user is a viewer (marked VIEW ONLY, or "viewOnly": true on a task). Leave it out and explain why in "warnings".
    -   **Questions**: If the user asks about their tasks (e.g. "What's Robin working on?", "What have I got on in Solfit?"), answer in "answer" in one or two short sentences using only the tasks listed (a person is working on the tasks assigned to them that aren't done). Return an empty "changes" array unless they also asked for changes.
3.  You MUST return a JSON object with "changes" (array) and "summary" (string).
4.  The "changes" array should ONLY contain proposed changes. Do not include unchanged tasks.
5.  The "summary" must be a concise, human-readable string (e.g., "Added 1 task for Robin and moved 'Deploy feature X' to done.").
6.  If the request is unclear or unrelated to project management, return empty "changes" array and appropriate summary.
7.  STATUS GUIDE:
    - "do": active, actionable now.
    - "delay": putting off indefinitely, no specific timeframe.
    - "done": completed.
    - "delegate": someone else is handling it.
    - "awaiting": waiting for a specific date before this becomes actionable. ALWAYS set an awaitUntil date (YYYY-MM-DD) when using this status. Use this when the user mentions a concrete future date or time reference (e.g. "not until August", "pick this up in March", "waiting for the 15th", "snooze until next week"). DO NOT use awaiting when no date is mentioned: use "delay" for "someday" items and "do" for things that can start now.
8.  DATE PARSING for awaitUntil:
    - "next week": the Monday of next week
    - "next month": the 1st of next month
    - "in 2 weeks": today + 14 days
    - "August" / "in August": 1st August (current or next year, whichever is in the future)
    - "not until Christmas": 25 December (current or next year)
    - If the date is ambiguous or missing, default to 30 days from now.
    - Past dates mentioned in passing (e.g. "my passport from 2019 needs renewing") are NOT awaitUntil dates. The date must be about the action, not about the task's history.

Current Timestamp: {timestamp}

User's Voice Transcript:
"{transcript}"

Current Tasks JSON:
{projects}
`;

/** Prompt text for a caller with no loaded context (tests and older callers). */
const NO_CONTEXT = {
  me: '(unknown)',
  workspaces: '(not provided: use the categories on the tasks)',
  epics: '(not provided)',
};

async function getProjectUpdates(
  transcript: string,
  projects: unknown[],
  llm: StructuredLlm,
  context?: VoiceContext
): Promise<z.infer<typeof zodSchema>> {
  const promptContext = context
    ? {
        me: `${context.me.name} <${context.me.email}>`,
        workspaces: describeWorkspaces(context),
        epics: describeEpics(context),
      }
    : NO_CONTEXT;

  const prompt = renderPrompt(VOICE_PROMPT, {
    transcript,
    projects: JSON.stringify(projects),
    timestamp: new Date().toISOString(),
    ...promptContext,
  });

  return llm.complete({ name: 'voice_command', prompt, schema: zodSchema });
}

/** Exposed for tests: the full prompt template the model sees. */
export const VOICE_PROMPT_TEMPLATE = VOICE_PROMPT;

export async function processVoiceCommand({
  audioFile,
  projects = [],
  ai,
  groqApiKey,
  context,
}: ProcessVoiceCommandArgs) {
  const providers = resolveProviders({ ai, groqApiKey });

  const transcript = await providers.transcriber.transcribe(audioFile);

  if (!transcript.trim()) {
    return {
      transcript: '',
      summary: 'No speech detected.',
      answer: null,
      warnings: [] as string[],
      me: context ? { id: context.me.id, name: context.me.name } : null,
      proposedChanges: [],
    };
  }

  const taskList = context ? compactTasks(context) : projects;
  const {
    summary,
    changes,
    answer,
    warnings: modelWarnings,
  } = await getProjectUpdates(transcript, taskList, providers.llm, context);

  if (context) {
    const { proposals, warnings } = resolveProposals((changes || []) as RawChange[], context);
    return {
      transcript,
      summary,
      answer: answer || null,
      warnings: Array.from(new Set([...(modelWarnings || []), ...warnings])),
      me: { id: context.me.id, name: context.me.name },
      proposedChanges: proposals,
    };
  }

  // No context: the original behaviour, enhancing changes with "before" data
  const proposedChanges = (changes || []).map((change) => {
    const before =
      change.type !== 'create' && change.type !== 'createEpic' && change.type !== 'createProject'
        ? projects.find((p) => p.id === change.projectId) || null
        : null;

    return {
      type: change.type,
      before,
      after: change.after || null,
    };
  });

  return {
    transcript,
    summary,
    answer: answer || null,
    warnings: modelWarnings || [],
    proposedChanges,
  };
}

// Alias for backwards/spec compatibility
export const parseVoiceCommand = processVoiceCommand;

interface ParseOnboardingProjectsArgs {
  audioFile: File;
  ai?: AiProviders;
  groqApiKey?: string;
}

const onboardingProjectSchema = z.object({
  project: z.string().describe('The name/title of the project'),
  reason: z.string().describe('Why this project matters to the user'),
  priority: z
    .number()
    .min(1)
    .max(10)
    .default(5)
    .describe('Priority from 1-10, default 5 if not mentioned'),
  size: z
    .enum(['*', '**', '***', '****', '*****'])
    .default('***')
    .describe('Size/complexity in stars, default *** if not mentioned'),
  status: z
    .enum(['do', 'delay', 'delegate', 'done', 'awaiting'])
    .default('do')
    .describe('Project status, default do if not mentioned'),
  notes: z.string().optional().describe('Any additional notes or context'),
  awaitUntil: z
    .string()
    .nullable()
    .optional()
    .describe(
      "When status is 'awaiting', the ISO date (YYYY-MM-DD) when this project should return to 'do'."
    ),
  gmailThreadId: z
    .string()
    .nullable()
    .optional()
    .describe('The Gmail thread ID associated with this project, if any.'),
});

const onboardingOutputSchema = z.object({
  projects: z
    .array(onboardingProjectSchema)
    .describe('Array of parsed project objects from the transcript'),
});

export async function parseOnboardingProjects({
  audioFile,
  ai,
  groqApiKey,
}: ParseOnboardingProjectsArgs) {
  const providers = resolveProviders({ ai, groqApiKey });

  const transcript = await providers.transcriber.transcribe(audioFile);

  if (!transcript.trim()) {
    return {
      transcript: '',
      projects: [],
    };
  }

  const prompt = renderPrompt(
    `You are an onboarding assistant for TimDo, a project management app.
Your task is to parse a user's voice recording where they describe their projects.

The user has been asked to list their 5 most important projects using this format:
"New project: [name]
 Reason: [why it matters]
 Priority: [1-10]
 Stars: [1-5 stars for size]
 Notes: [any details]"

However, users may not follow this format exactly. Be flexible and extract:
- project: The project name/title (REQUIRED)
- reason: Why it matters (REQUIRED)
- priority: 1-10 scale (default 5 if not mentioned)
- size: *, **, ***, ****, or ***** (default *** if not mentioned)
- status: do, delay, delegate, done, or awaiting (default "do" if not mentioned). Use "awaiting" only when the user mentions a specific date this should wait until.
- notes: Any additional context (optional)
- awaitUntil: When status is "awaiting", the ISO date (YYYY-MM-DD) when it should return to "do".

Date parsing for awaitUntil:
- "next week" → Monday of next week
- "next month" → 1st of next month
- "in 2 weeks" → today + 14 days
- "August" / "in August" → 1st August of current/next year (whichever is future)
- Ambiguous → default to 30 days from now

Extract as many projects as you can identify. The goal is 5 projects, but extract what you find.
Be generous in parsing - if you hear something that sounds like a project, include it.

Transcript:
"{transcript}"
`,
    { transcript }
  );

  const result = await providers.llm.complete({
    name: 'onboarding_projects',
    prompt,
    schema: onboardingOutputSchema,
  });

  return {
    transcript,
    projects: result.projects,
  };
}
