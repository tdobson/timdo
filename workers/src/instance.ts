/**
 * Per-instance settings for the API, from [vars] in wrangler.toml (or .dev.vars locally).
 * The defaults are the original timdo.tdobson.net values, so a deployment that sets nothing
 * behaves as before.
 *
 *   INSTANCE_NAME          what the instance calls itself, returned by GET /api/v2/config
 *   APP_URL                the public web address; used for invite links and allowed for CORS
 *   CORS_ORIGINS           comma-separated origins allowed to call the API from a browser
 *                          (default: http://localhost:3000 and APP_URL)
 *   POSTER_WORK_PROJECTS   comma-separated project names shown in the Wall of Done's work
 *                          column, in that order; unset means "projects in shared workspaces"
 *   FEATURES               comma-separated features to switch on: goals, poster, voice, gmail
 *                          (default: all of them). Anything switched off disappears from the
 *                          web app and its API routes answer 404.
 */
export interface InstanceEnv {
  INSTANCE_NAME?: string;
  APP_URL?: string;
  CORS_ORIGINS?: string;
  POSTER_WORK_PROJECTS?: string;
  FEATURES?: string;
}

/** The parts of TimDo an instance can switch off. */
export const FEATURE_NAMES = ['goals', 'poster', 'voice', 'gmail'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, boolean>;

/** What each feature covers, for the "switched off" message. */
export const FEATURE_LABELS: Record<FeatureName, string> = {
  goals: 'Life goals',
  poster: 'Posters',
  voice: 'Voice commands',
  gmail: 'Gmail thread links',
};

export interface InstanceConfig {
  name: string;
  appUrl: string;
  corsOrigins: string[];
  /** Project names for the poster's work column, or null to use the shared-workspace rule. */
  posterWorkProjects: string[] | null;
  features: Features;
}

export function parseFeatures(value: string | undefined): Features {
  const all = Object.fromEntries(FEATURE_NAMES.map((f) => [f, true])) as Features;
  if (value === undefined) {
    return all;
  }
  const wanted = new Set(
    value
      .split(',')
      .map((f) => f.trim().toLowerCase())
      .filter(Boolean)
  );
  return Object.fromEntries(FEATURE_NAMES.map((f) => [f, wanted.has(f)])) as Features;
}

export const DEFAULT_APP_URL = 'https://timdo.tdobson.net';

function list(value: string | undefined): string[] | null {
  if (value === undefined) {
    return null;
  }
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items;
}

export function instanceConfig(env: InstanceEnv | undefined): InstanceConfig {
  env = env ?? {};
  const appUrl = (env.APP_URL?.trim() || DEFAULT_APP_URL).replace(/\/$/, '');
  const corsOrigins = list(env.CORS_ORIGINS) ?? ['http://localhost:3000', appUrl];
  const work = list(env.POSTER_WORK_PROJECTS);
  return {
    name: env.INSTANCE_NAME?.trim() || 'TimDo',
    appUrl,
    corsOrigins: Array.from(new Set(corsOrigins)),
    posterWorkProjects: work && work.length > 0 ? work : null,
    features: parseFeatures(env.FEATURES),
  };
}
