import { z } from 'zod';
import {
  CONTROL_ERROR,
  hasControlChars,
  LABEL_CONTROL_ERROR,
  MAX_KIND_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_REF_LENGTH,
  normaliseRole,
  PARSE_ERROR,
  ROLE_ERROR,
} from '../lib/refs';

/**
 * A ref as callers send it. `ref` is a URL or `kind:ref` (or a bare id with `kind`); the
 * service parses it, so messages here only cover shape. Role accepts "reported-by" too.
 */
export const refInputSchema = z.object({
  ref: z
    .string({ required_error: PARSE_ERROR, invalid_type_error: PARSE_ERROR })
    .trim()
    .min(1, PARSE_ERROR)
    .max(
      MAX_REF_LENGTH,
      `That is too long: ids and URLs can be ${MAX_REF_LENGTH} characters at most`
    ),
  kind: z
    .string()
    .trim()
    .max(
      MAX_KIND_LENGTH,
      `That kind is too long: kinds can be ${MAX_KIND_LENGTH} characters at most`
    )
    .optional(),
  role: z
    .string()
    .optional()
    .transform((r, ctx) => {
      const role = normaliseRole(r);
      if (!role) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: ROLE_ERROR });
        return z.NEVER;
      }
      return role;
    }),
  label: z
    .string()
    .trim()
    .max(MAX_LABEL_LENGTH, `Labels can be ${MAX_LABEL_LENGTH} characters at most`)
    .refine((l) => !hasControlChars(l), LABEL_CONTROL_ERROR)
    .optional(),
  url: z
    .string()
    .trim()
    .refine((u) => !hasControlChars(u), CONTROL_ERROR)
    .refine((u) => /^https?:\/\/\S+$/i.test(u), 'The url must start with http:// or https://')
    .optional(),
});
export type RefInputPayload = z.infer<typeof refInputSchema>;

/** Refs are not a PUT field: say so rather than let zod drop them and answer 200. */
export const REFS_ON_PUT_ERROR =
  'Add links with POST /tasks/:id/refs and remove them with DELETE /tasks/:id/refs (PUT does not change links)';
export const refsNotOnUpdate = z
  .unknown()
  .optional()
  .refine((v) => v === undefined, REFS_ON_PUT_ERROR);

/** Up to 20 refs on a create. */
export const refInputListSchema = z.array(refInputSchema).max(20, 'At most 20 links per task');

/** zValidator hook: answer with the first problem as a sentence, `{ error }`, like the rest of the refs API. */
export function sentenceOnError(
  result: { success: boolean; error?: z.ZodError },
  c: { json: (body: unknown, status: 400) => Response }
) {
  if (!result.success) {
    return c.json({ error: result.error?.issues[0]?.message ?? PARSE_ERROR }, 400);
  }
}
