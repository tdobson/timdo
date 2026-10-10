import { z } from 'zod';
import { refInputListSchema, refsNotOnUpdate } from './refValidators';

export const ON_DUPLICATE = ['error', 'return', 'report'] as const;
export type OnDuplicate = (typeof ON_DUPLICATE)[number];

/**
 * What a create does when a `source` ref in `refs` already has a live task in the workspace:
 * `error` (409, the default), `return` (200, that task) or `report` (200, that task with the
 * request's other refs and a note added). Ignored without a source ref.
 */
export const onDuplicateSchema = z
  .enum(ON_DUPLICATE, {
    errorMap: () => ({ message: 'onDuplicate must be error, return or report' }),
  })
  .optional();

const statusEnum = z.enum(['do', 'delay', 'done', 'delegate', 'awaiting']);
const sizeEnum = z.enum(['*', '**', '***', '****', '*****']);

// Forms send '' for "none"; store it as null so it isn't logged as a change or break a foreign key
const optionalText = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().nullable().optional()
);

const projectBaseSchema = z.object({
  project: z.string().min(1),
  reason: z.string().nullable().optional(),
  status: statusEnum.default('do'),
  priority: z.number().int().min(1).max(10).default(5),
  size: sizeEnum.default('***'),
  notes: z.string().nullable().optional(),
  awaitUntil: optionalText,
  gmailThreadId: optionalText,
  category: optionalText,
  customer: optionalText,
  tags: optionalText,
  epicId: optionalText,
  goalId: optionalText,
  /** Explicit project (workspace-scoped). Takes precedence over `category`. */
  projectId: z.string().optional(),
  /** Defaults to the creator. null = unassigned. */
  assigneeId: optionalText,
});

export const projectCreateSchema = projectBaseSchema
  .extend({
    /** Links to add with the task, in the same batch. One source at most. */
    refs: refInputListSchema.optional(),
    onDuplicate: onDuplicateSchema,
  })
  .refine(
    (data) => {
      // When status is 'awaiting', awaitUntil must be a non-null, non-empty string
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
export type ProjectCreatePayload = z.infer<typeof projectCreateSchema>;

export const projectUpdateSchema = projectBaseSchema.partial().extend({
  updatedAt: z.string().datetime().optional(),
  statusLastChangedOn: z.string().datetime().optional(),
  isDeleted: z.boolean().optional(),
  refs: refsNotOnUpdate,
  removeRefs: refsNotOnUpdate,
});
export type ProjectUpdatePayload = z.infer<typeof projectUpdateSchema>;

export const projectUpdateBatchSchema = z.array(
  z.object({
    id: z.string(),
    priority: z.number().int().min(1).max(10),
    status: statusEnum,
  })
);
export type ProjectUpdateBatchPayload = z.infer<typeof projectUpdateBatchSchema>;

export const projectUpdateCreateSchema = z.object({
  note: z.string().min(1),
  gmailThreadId: z.string().nullable().optional(),
});
export type ProjectUpdateCreatePayload = z.infer<typeof projectUpdateCreateSchema>;

export const projectMergeSchema = z.object({
  sourceId: z.string().uuid(),
});
export type ProjectMergePayload = z.infer<typeof projectMergeSchema>;
