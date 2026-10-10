import { z } from 'zod';
import { onDuplicateSchema } from './projectValidators';
import { refInputListSchema, refsNotOnUpdate } from './refValidators';

const statusEnum = z.enum(['do', 'delay', 'done', 'delegate', 'awaiting']);
const sizeEnum = z.enum(['*', '**', '***', '****', '*****']);

export const taskCreateSchema = z
  .object({
    projectId: z.string().min(1, 'projectId is required'),
    title: z.string().min(1, 'title is required'),
    reason: z.string().nullable().optional(),
    status: statusEnum.default('do'),
    priority: z.number().int().min(1).max(10).default(5),
    size: sizeEnum.default('***'),
    notes: z.string().nullable().optional(),
    assigneeId: z.string().nullable().optional(),
    epicId: z.string().nullable().optional(),
    awaitUntil: z.string().nullable().optional(),
    gmailThreadId: z.string().nullable().optional(),
    customer: z.string().nullable().optional(),
    tags: z.string().nullable().optional(),
    /** Links to add with the task, in the same batch. One source at most. */
    refs: refInputListSchema.optional(),
    /** When the source ref already has a task: error (409, default), return or report. */
    onDuplicate: onDuplicateSchema,
  })
  .refine(
    (data) => {
      if (data.status === 'awaiting') {
        return data.awaitUntil != null && data.awaitUntil.length > 0;
      }
      return true;
    },
    {
      message: "awaitUntil is required when status is 'awaiting'",
      path: ['awaitUntil'],
    }
  );

export type TaskCreatePayload = z.infer<typeof taskCreateSchema>;

export const taskUpdateSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    reason: z.string().nullable().optional(),
    status: statusEnum.optional(),
    priority: z.number().int().min(1).max(10).optional(),
    size: sizeEnum.optional(),
    notes: z.string().nullable().optional(),
    assigneeId: z.string().nullable().optional(),
    epicId: z.string().nullable().optional(),
    awaitUntil: z.string().nullable().optional(),
    gmailThreadId: z.string().nullable().optional(),
    customer: z.string().nullable().optional(),
    tags: z.string().nullable().optional(),
    isDeleted: z.boolean().optional(),
    statusLastChangedOn: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    refs: refsNotOnUpdate,
    removeRefs: refsNotOnUpdate,
  })
  .refine(
    (data) => {
      if (data.status === 'awaiting') {
        return data.awaitUntil != null && data.awaitUntil.length > 0;
      }
      return true;
    },
    {
      message: "awaitUntil is required when status is 'awaiting'",
      path: ['awaitUntil'],
    }
  );

export type TaskUpdatePayload = z.infer<typeof taskUpdateSchema>;

export const taskAssignSchema = z.object({
  assigneeId: z.string().nullable(),
});
export type TaskAssignPayload = z.infer<typeof taskAssignSchema>;

export const taskUpdateNoteSchema = z.object({
  note: z.string().min(1, 'note is required'),
  gmailThreadId: z.string().nullable().optional(),
});
export type TaskUpdateNotePayload = z.infer<typeof taskUpdateNoteSchema>;

export const taskGoalLinkSchema = z.object({
  goalId: z.string().min(1, 'goalId is required'),
});
export type TaskGoalLinkPayload = z.infer<typeof taskGoalLinkSchema>;

export const taskRelationCreateSchema = z.object({
  targetTaskId: z.string().min(1, 'targetTaskId is required'),
  relation: z.enum(['relates_to', 'blocks', 'blocked_by', 'duplicates']).default('relates_to'),
  reason: z.string().nullable().optional(),
});
export type TaskRelationCreatePayload = z.infer<typeof taskRelationCreateSchema>;
