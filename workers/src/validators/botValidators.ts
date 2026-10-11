import { z } from 'zod';

export const hasControlCharacters = (value: string) => /\p{Cc}/u.test(value);

const safeName = (label: string, maximum: number) =>
  z
    .string()
    .refine((value) => !hasControlCharacters(value), `${label} cannot contain control characters`)
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, `${label} is required`)
        .max(maximum, `${label} must be ${maximum} characters or fewer`)
    );

export const botCreateSchema = z
  .object({
    name: safeName('Bot name', 80),
    role: z.enum(['member', 'viewer']).default('member'),
    tokenName: safeName('Token name', 60).default('initial'),
  })
  .strict();

export const botUpdateSchema = z
  .object({
    name: safeName('Bot name', 80).optional(),
    role: z.enum(['member', 'viewer']).optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.role !== undefined, {
    message: 'Provide a bot name or role to change',
  });

export const botTokenCreateSchema = z.object({ name: safeName('Token name', 60) }).strict();

export type BotCreateInput = z.infer<typeof botCreateSchema>;
export type BotUpdateInput = z.infer<typeof botUpdateSchema>;
export type BotTokenCreateInput = z.infer<typeof botTokenCreateSchema>;
