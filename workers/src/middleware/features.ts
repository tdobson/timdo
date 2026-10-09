import type { Context, Next } from 'hono';
import type { Env } from '../index';
import { FEATURE_LABELS, instanceConfig, type FeatureName } from '../instance';

/** Answers 404 with a plain message when the instance has switched the feature off. */
export function requireFeature(feature: FeatureName) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (!instanceConfig(c.env).features[feature]) {
      return c.json({ error: `${FEATURE_LABELS[feature]} are switched off on this instance` }, 404);
    }
    return next();
  };
}
