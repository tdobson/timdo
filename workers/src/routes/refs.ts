import { Hono } from 'hono';
import type { Env } from '../index';
import { canonicalRef, parseRef } from '../lib/refs';

const refsApp = new Hono<{ Bindings: Env }>();

// GET /api/v2/refs/parse?input=...&kind= - how an input would be understood, without saving.
// Always 200 ({ ok, value } or { ok: false, error }) so live previews stay simple.
refsApp.get('/parse', (c) => {
  const result = parseRef(c.req.query('input') ?? '', c.req.query('kind') || undefined);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error });
  }
  const { kind, ref, url, label } = result.value;
  return c.json({
    ok: true,
    value: { kind, ref, canonical: canonicalRef(result.value), url, label },
  });
});

export default refsApp;
