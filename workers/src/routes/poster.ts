import { Hono } from 'hono';
import type { Env } from '../index';
import { instanceConfig } from '../instance';
import { generateActiveTasksPosterSvg } from '../services/activePosterService';
import { getCompletedPosterData } from '../services/completedPosterService';
import { getProjectsForUser } from '../services/projectService';
import { generateTiledA4Svgs, generateWallOfDoneSvg } from '../services/wallOfDoneSvgService';

const posterApp = new Hono<{ Bindings: Env }>();

// GET /api/v2/poster/wall-of-done
// Supports ?format=svg, ?format=json, ?tiled=true, ?categories=Cat1,Cat2, ?timeframe=6m|12m|all
posterApp.get('/wall-of-done', async (c) => {
  const userId = c.get('userId');
  const db = c.get('db');

  const format = c.req.query('format') || 'svg';
  const isTiled = c.req.query('tiled') === 'true';
  const timeframe = (c.req.query('timeframe') as '6m' | '12m' | 'all') || '6m';
  const categoriesParam = c.req.query('categories');
  const categories = categoriesParam
    ? categoriesParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const data = await getCompletedPosterData(db, userId, categories, timeframe, {
    workProjects: instanceConfig(c.env).posterWorkProjects,
  });

  if (isTiled) {
    const tiles = generateTiledA4Svgs(data);
    return c.json({
      totalCount: data.totalCount,
      generatedAt: data.generatedAt,
      tiles,
    });
  }

  if (format === 'json') {
    const svg = generateWallOfDoneSvg(data);
    return c.json({
      data,
      svg,
    });
  }

  // Default: raw SVG
  const svg = generateWallOfDoneSvg(data);
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
});

// GET /api/v2/poster/active
// Supports ?categories=Cat1,Cat2, ?format=svg|json, and ?tiled=true
posterApp.get('/active', async (c) => {
  const userId = c.get('userId');
  const db = c.get('db');

  const format = c.req.query('format') || 'svg';
  const isTiled = c.req.query('tiled') === 'true';
  const categoriesParam = c.req.query('categories');
  const categories = categoriesParam
    ? categoriesParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  // The active poster is personal: your tasks across every workspace
  const projects = await getProjectsForUser(db, userId, { assignee: 'me' });

  const svg = generateActiveTasksPosterSvg({
    tasks: projects,
    categories,
  });

  if (isTiled) {
    const { generateTiled4xA4Svgs } = await import('../services/posterSvgService');
    const tiles = generateTiled4xA4Svgs(svg, 'Active Tasks');
    return c.json({
      totalCount: projects.filter((t) => t.status !== 'done').length,
      generatedAt: new Date().toISOString(),
      tiles,
    });
  }

  if (format === 'json') {
    return c.json({
      categories,
      tasks: projects.filter((t) => t.status !== 'done'),
      svg,
    });
  }

  // Default: image/svg+xml
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
});

// GET /api/v2/poster/goals-rhythm
// Supports ?format=svg|json, and ?tiled=true (for 4x A4 life goals poster)
posterApp.get('/goals-rhythm', async (c) => {
  const userId = c.get('userId');
  const db = c.get('db');
  const format = c.req.query('format') || 'svg';
  const isTiled = c.req.query('tiled') === 'true';

  const userGoals = await db
    .select()
    .from((await import('../db/schema')).goals)
    .where((await import('drizzle-orm')).eq((await import('../db/schema')).goals.userId, userId));

  const aims = userGoals.filter((g) => g.type === 'aim');
  const focuses = userGoals.filter((g) => g.type === 'focus');
  const values = userGoals.filter((g) => g.type === 'value');
  const housekeeping = userGoals.filter((g) => g.type === 'housekeeping');

  const { generatePosterSvg, generateTiled4xA4Svgs } = await import('../services/posterSvgService');
  const svg = generatePosterSvg({
    aims: aims as any,
    focuses: focuses as any,
    values: values as any,
    housekeeping: housekeeping as any,
  });

  if (isTiled) {
    const tiles = generateTiled4xA4Svgs(svg, 'Life Goals & Rhythm');
    return c.json({
      totalCount: userGoals.length,
      generatedAt: new Date().toISOString(),
      tiles,
    });
  }

  if (format === 'json') {
    return c.json({
      goals: userGoals,
      svg,
    });
  }

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
});

export default posterApp;
