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
 */
export interface InstanceEnv {
  INSTANCE_NAME?: string;
  APP_URL?: string;
  CORS_ORIGINS?: string;
  POSTER_WORK_PROJECTS?: string;
}

export interface InstanceConfig {
  name: string;
  appUrl: string;
  corsOrigins: string[];
  /** Project names for the poster's work column, or null to use the shared-workspace rule. */
  posterWorkProjects: string[] | null;
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
  };
}
