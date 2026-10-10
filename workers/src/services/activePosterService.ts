import {
  mapAndCleanTaskCategoryAndTitle,
  normalizeCategory,
  sizeToNumeric,
} from './completedPosterService';
import { escapeXml } from './posterSvgService';

export interface ActivePosterTask {
  id: string;
  project: string;
  reason?: string | null;
  status: string;
  priority?: number | null;
  size?: string | null;
  category?: string | null;
  awaitUntil?: string | null;
  notes?: string | null;
  [key: string]: any;
}

export interface ActiveTasksPosterData {
  tasks: ActivePosterTask[];
  categories?: string[];
  user?: string;
}

// A2 dimensions in mm / user units
export const POSTER_WIDTH = 420;
export const POSTER_HEIGHT = 594;
export const POSTER_VIEWBOX = `0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}`;

const MARGIN_X = 8;
const MARGIN_Y = 8;
const CONTENT_WIDTH = 404;
const CONTENT_HEIGHT = 578;
const BORDER_RADIUS = 6;

// Sizing stars helper matching classic PrintableSvgPoster
function renderStars(sizeNum: number): string {
  if (sizeNum <= 0) return '';
  const count = Math.min(Math.max(sizeNum, 1), 5);
  return '★'.repeat(count);
}

function getStarClass(sizeNum: number): string {
  if (sizeNum === 1) return 'star-light';
  if (sizeNum <= 3) return 'star-dark';
  return 'star-black';
}

function formatAwaitUntil(dateStr?: string | null): string {
  if (!dateStr) return '';
  const dt = new Date(dateStr);
  if (isNaN(dt.getTime())) return dateStr;
  return dt
    .toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: '2-digit',
    })
    .replace('Sept', 'Sep');
}

/**
 * Truncate text cleanly if longer than maxLength
 */
function truncateText(str: string | null | undefined, maxLen: number): string {
  if (!str) return '';
  const trimmed = str.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + '…';
}

/**
 * Word wrap text into up to maxLines lines, truncating the final line if necessary
 */
function wrapLines(
  str: string | null | undefined,
  maxCharsPerLine: number,
  maxLines: number = 2
): string[] {
  if (!str) return [];
  const words = str.trim().split(/\s+/);
  if (words.length === 0 || !words[0]) return [];

  const lines: string[] = [];
  let currentLine = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!currentLine) {
      currentLine = word;
    } else if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length === maxLines - 1) {
        // Collect all remaining words into the last line and truncate cleanly
        const rest = words.slice(i).join(' ');
        lines.push(truncateText(rest, maxCharsPerLine));
        return lines;
      }
    }
  }

  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Render up to 2 wrapped SVG text lines using tspans
 */
function renderWrappedText(
  lines: string[],
  x: number | string,
  startY: number,
  lineHeight: number = 5.2
): string {
  if (lines.length === 0) return '';
  if (lines.length === 1) {
    return `<tspan x="${x}">${escapeXml(lines[0])}</tspan>`;
  }
  return lines
    .map((line, idx) => {
      const y = startY + idx * lineHeight;
      return `<tspan x="${x}" y="${y.toFixed(1)}">${escapeXml(line)}</tspan>`;
    })
    .join('');
}

/**
 * Generate the active tasks A2 poster:
 * - DO table (Dark header #333) with Project, Reason, Bigness, Next first step / Notes
 * - AWAITING table (Medium header #888) with 2 columns (Project, Returns)
 * - DELAY table (Medium-dark header #666) with 2 columns (Project, Reason)
 * - NO DONE section (done belongs on Wall of Done)
 * - Descending priority order (10 down to 1)
 * - Supports category filtering
 */
export function generateActiveTasksPosterSvg(data: ActiveTasksPosterData): string {
  const { tasks = [], categories, user } = data;

  // 1. Filter out 'done' status (only active momentum: do, awaiting, delay)
  const validStatuses = new Set(['do', 'awaiting', 'delay']);
  const activeOnly = tasks.filter((t) => validStatuses.has(t.status));

  // 2. Map and clean title/category for tasks
  const processed = activeOnly.map((t) => {
    const { title, category } = mapAndCleanTaskCategoryAndTitle({
      project: t.project,
      category: t.category,
    });
    return {
      id: t.id,
      title,
      reason: t.reason || '',
      status: t.status,
      priority: typeof t.priority === 'number' ? t.priority : 5,
      sizeNum: sizeToNumeric(t.size),
      size: t.size,
      awaitUntil: t.awaitUntil,
      notes: t.notes || '',
      category,
    };
  });

  // 3. Category filtering if specified
  const normalizedCats =
    categories && categories.length > 0
      ? categories.map((c) => normalizeCategory(c).toLowerCase())
      : null;

  const filtered = normalizedCats
    ? processed.filter((t) => normalizedCats.includes((t.category || '').toLowerCase()))
    : processed;

  // Partition by status and sort in descending priority order
  const doTasks = filtered
    .filter((t) => t.status === 'do')
    .sort((a, b) => b.priority - a.priority || b.sizeNum - a.sizeNum);

  const awaitingTasks = filtered
    .filter((t) => t.status === 'awaiting')
    .sort((a, b) => {
      if (a.awaitUntil && b.awaitUntil) {
        const timeA = new Date(a.awaitUntil).getTime();
        const timeB = new Date(b.awaitUntil).getTime();
        if (timeA !== timeB) return timeA - timeB;
      }
      return b.priority - a.priority || b.sizeNum - a.sizeNum;
    });

  const delayTasks = filtered
    .filter((t) => t.status === 'delay')
    .sort((a, b) => b.priority - a.priority || b.sizeNum - a.sizeNum);

  // Priority cutoff for single A2 sheet to prevent crowding:
  // With max 24 DO tasks, 12 Awaiting, and 12 Delay, each item gets generous vertical space
  // (15.5mm row height for DO, 13.5mm for two-column sections) with full multi-line wrapping without overlapping.
  // Full backlogs can be printed across 4x A4 tiles via the tiled export.
  const MAX_DO_ON_A2 = 24;
  const MAX_AWAITING_ON_A2 = 14;
  const MAX_DELAY_ON_A2 = 14;

  const displayDoTasks = doTasks.slice(0, MAX_DO_ON_A2);
  const displayAwaitingTasks = awaitingTasks.slice(0, MAX_AWAITING_ON_A2);
  const displayDelayTasks = delayTasks.slice(0, MAX_DELAY_ON_A2);

  // Row heights and text styling for clean readability and generous vertical breathing room
  const doRowHeight = 15.5;
  const twoColRowHeight = 13.5;
  const textLineHeight = 5.6;
  const twoColTextLineHeight = 5.2;

  let currentY = 45;
  const sectionContentX = MARGIN_X + 5;
  const sectionContentWidth = CONTENT_WIDTH - 10;

  let sectionsSvg = '';

  // -------------------------------------------------------------
  // 1. DO SECTION
  // -------------------------------------------------------------
  if (displayDoTasks.length > 0) {
    const doStartY = currentY;
    const titleBarHeight = 22;
    const headerHeight = 14;

    const remainingDoCount = doTasks.length - displayDoTasks.length;
    const doTitleExtra =
      remainingDoCount > 0 ? ` (TOP ${displayDoTasks.length} OF ${doTasks.length})` : '';

    let doContentSvg = `
    <!-- DO Section Title -->
    <rect x="${MARGIN_X}" y="${currentY}" width="${CONTENT_WIDTH}" height="${titleBarHeight}" fill="#333" />
    <text x="210" y="${currentY + titleBarHeight / 2 + 1}" class="section-title">DO${doTitleExtra}</text>`;
    currentY += titleBarHeight + 5;

    const headerY = currentY;
    doContentSvg += `
    <rect x="${sectionContentX}" y="${headerY}" width="${sectionContentWidth}" height="${headerHeight}" fill="#f0f0f0" />
    <text x="18" y="${headerY + 9}" class="header">PROJECT</text>
    <text x="145" y="${headerY + 9}" class="header">REASON</text>
    <text x="254" y="${headerY + 9}" class="header">BIGNESS</text>
    <text x="292" y="${headerY + 9}" class="header">NEXT FIRST STEP / NOTES</text>`;
    currentY += headerHeight;

    for (let i = 0; i < displayDoTasks.length; i++) {
      const task = displayDoTasks[i];
      const rowY = currentY;
      const rowBg = i % 2 === 0 ? '#ffffff' : '#f8f8f8';
      const projectLines = wrapLines(task.title, 34, 2);
      const reasonLines = wrapLines(task.reason, 26, 2);
      const notesLines = wrapLines(task.notes, 34, 2);
      const starStr = renderStars(task.sizeNum);
      const starClass = getStarClass(task.sizeNum);

      const firstLineY = projectLines.length === 1 ? rowY + 9.5 : rowY + 6.0;
      const reasonFirstLineY = reasonLines.length === 1 ? rowY + 9.5 : rowY + 6.0;
      const notesFirstLineY = notesLines.length === 1 ? rowY + 9.5 : rowY + 6.0;

      doContentSvg += `
      <rect x="${sectionContentX}" y="${rowY}" width="${sectionContentWidth}" height="${doRowHeight}" fill="${rowBg}" />
      <text x="18" y="${firstLineY.toFixed(1)}" class="content">${renderWrappedText(projectLines, 18, firstLineY, textLineHeight)}</text>
      <text x="145" y="${reasonFirstLineY.toFixed(1)}" class="content-reason">${renderWrappedText(reasonLines, 145, reasonFirstLineY, textLineHeight)}</text>
      <text x="254" y="${(rowY + 9.5).toFixed(1)}" class="${starClass}">${starStr}</text>
      <text x="292" y="${notesFirstLineY.toFixed(1)}" class="content-notes">${renderWrappedText(notesLines, 292, notesFirstLineY, textLineHeight)}</text>
      <line x1="${sectionContentX}" y1="${rowY + doRowHeight}" x2="${sectionContentX + sectionContentWidth}" y2="${rowY + doRowHeight}" stroke="#ddd" stroke-width="0.3" />`;

      currentY += doRowHeight;
    }

    currentY += 8;
    const doTotalHeight = currentY - doStartY;
    sectionsSvg += `
    <rect x="${MARGIN_X}" y="${doStartY}" width="${CONTENT_WIDTH}" height="${doTotalHeight}" fill="#fff" stroke="#666" stroke-width="0.8" rx="4" />
    ${doContentSvg}`;
  }

  // -------------------------------------------------------------
  // 2. AWAITING SECTION (2 Columns: Project | Returns)
  // -------------------------------------------------------------
  if (awaitingTasks.length > 0) {
    const awaitingStartY = currentY;
    const titleBarHeight = 20;
    const headerHeight = 13;
    const colGutter = 6;
    const colWidth = (sectionContentWidth - colGutter) / 2;
    const col1X = sectionContentX;
    const col2X = sectionContentX + colWidth + colGutter;

    let awaitingContentSvg = `
    <!-- AWAITING Section Title -->
    <rect x="${MARGIN_X}" y="${currentY}" width="${CONTENT_WIDTH}" height="${titleBarHeight}" fill="#888" />
    <text x="210" y="${currentY + titleBarHeight / 2 + 1}" class="section-title">AWAITING</text>`;
    currentY += titleBarHeight + 5;

    const headerY = currentY;
    awaitingContentSvg += `
    <rect x="${col1X}" y="${headerY}" width="${colWidth}" height="${headerHeight}" fill="#f0f0f0" />
    <text x="${col1X + 4}" y="${headerY + 9}" class="header">PROJECT</text>
    <text x="${col1X + colWidth - 48}" y="${headerY + 9}" class="header">RETURNS</text>

    <rect x="${col2X}" y="${headerY}" width="${colWidth}" height="${headerHeight}" fill="#f0f0f0" />
    <text x="${col2X + 4}" y="${headerY + 9}" class="header">PROJECT</text>
    <text x="${col2X + colWidth - 48}" y="${headerY + 9}" class="header">RETURNS</text>`;
    currentY += headerHeight;

    const itemsStartY = currentY;
    const half = Math.ceil(awaitingTasks.length / 2);
    const col1Tasks = awaitingTasks.slice(0, half);
    const col2Tasks = awaitingTasks.slice(half);
    const maxRows = Math.max(col1Tasks.length, col2Tasks.length);

    for (let i = 0; i < maxRows; i++) {
      const rowY = itemsStartY + i * twoColRowHeight;
      const rowBg = i % 2 === 0 ? '#ffffff' : '#f8f8f8';

      // Column 1
      if (i < col1Tasks.length) {
        const t = col1Tasks[i];
        const projLines = wrapLines(t.title, 36, 2);
        const returnStr = formatAwaitUntil(t.awaitUntil);
        const firstLineY = projLines.length === 1 ? rowY + 8.5 : rowY + 5.5;

        awaitingContentSvg += `
        <rect x="${col1X}" y="${rowY}" width="${colWidth}" height="${twoColRowHeight}" fill="${rowBg}" />
        <text x="${col1X + 4}" y="${firstLineY.toFixed(1)}" class="content">${renderWrappedText(projLines, col1X + 4, firstLineY, twoColTextLineHeight)}</text>
        <text x="${col1X + colWidth - 48}" y="${(rowY + 8.5).toFixed(1)}" class="content-reason">${escapeXml(returnStr)}</text>
        <line x1="${col1X}" y1="${rowY + twoColRowHeight}" x2="${col1X + colWidth}" y2="${rowY + twoColRowHeight}" stroke="#ddd" stroke-width="0.3" />`;
      }

      // Column 2
      if (i < col2Tasks.length) {
        const t = col2Tasks[i];
        const projLines = wrapLines(t.title, 36, 2);
        const returnStr = formatAwaitUntil(t.awaitUntil);
        const firstLineY = projLines.length === 1 ? rowY + 8.5 : rowY + 5.5;

        awaitingContentSvg += `
        <rect x="${col2X}" y="${rowY}" width="${colWidth}" height="${twoColRowHeight}" fill="${rowBg}" />
        <text x="${col2X + 4}" y="${firstLineY.toFixed(1)}" class="content">${renderWrappedText(projLines, col2X + 4, firstLineY, twoColTextLineHeight)}</text>
        <text x="${col2X + colWidth - 48}" y="${(rowY + 8.5).toFixed(1)}" class="content-reason">${escapeXml(returnStr)}</text>
        <line x1="${col2X}" y1="${rowY + twoColRowHeight}" x2="${col2X + colWidth}" y2="${rowY + twoColRowHeight}" stroke="#ddd" stroke-width="0.3" />`;
      }
    }

    currentY = itemsStartY + maxRows * twoColRowHeight + 10;
    const awaitingTotalHeight = currentY - awaitingStartY;

    sectionsSvg += `
    <rect x="${MARGIN_X}" y="${awaitingStartY}" width="${CONTENT_WIDTH}" height="${awaitingTotalHeight}" fill="#fff" stroke="#888" stroke-width="0.8" rx="4" />
    <line x1="${col1X + colWidth + colGutter / 2}" y1="${headerY}" x2="${col1X + colWidth + colGutter / 2}" y2="${currentY - 10}" stroke="#888" stroke-width="0.8" />
    ${awaitingContentSvg}`;
  }

  // -------------------------------------------------------------
  // 3. DELAY SECTION (2 Columns: Project | Reason)
  // -------------------------------------------------------------
  if (delayTasks.length > 0) {
    const delayStartY = currentY;
    const titleBarHeight = 20;
    const headerHeight = 13;
    const colGutter = 6;
    const colWidth = (sectionContentWidth - colGutter) / 2;
    const col1X = sectionContentX;
    const col2X = sectionContentX + colWidth + colGutter;

    const remainingDelayCount = delayTasks.length - displayDelayTasks.length;
    const delayTitleExtra =
      remainingDelayCount > 0 ? ` (TOP ${displayDelayTasks.length} OF ${delayTasks.length})` : '';

    let delayContentSvg = `
    <!-- DELAY Section Title -->
    <rect x="${MARGIN_X}" y="${currentY}" width="${CONTENT_WIDTH}" height="${titleBarHeight}" fill="#666" />
    <text x="210" y="${currentY + titleBarHeight / 2 + 1}" class="section-title">DELAY${delayTitleExtra}</text>`;
    currentY += titleBarHeight + 5;

    const headerY = currentY;
    delayContentSvg += `
    <rect x="${col1X}" y="${headerY}" width="${colWidth}" height="${headerHeight}" fill="#f0f0f0" />
    <text x="${col1X + 4}" y="${headerY + 9}" class="header">PROJECT</text>
    <text x="${col1X + 108}" y="${headerY + 9}" class="header">REASON</text>

    <rect x="${col2X}" y="${headerY}" width="${colWidth}" height="${headerHeight}" fill="#f0f0f0" />
    <text x="${col2X + 4}" y="${headerY + 9}" class="header">PROJECT</text>
    <text x="${col2X + 108}" y="${headerY + 9}" class="header">REASON</text>`;
    currentY += headerHeight;

    const itemsStartY = currentY;
    const half = Math.ceil(displayDelayTasks.length / 2);
    const col1Tasks = displayDelayTasks.slice(0, half);
    const col2Tasks = displayDelayTasks.slice(half);
    const maxRows = Math.max(col1Tasks.length, col2Tasks.length);

    for (let i = 0; i < maxRows; i++) {
      const rowY = itemsStartY + i * twoColRowHeight;
      const rowBg = i % 2 === 0 ? '#ffffff' : '#f8f8f8';

      // Column 1
      if (i < col1Tasks.length) {
        const t = col1Tasks[i];
        const projLines = wrapLines(t.title, 26, 2);
        const reasonLines = wrapLines(t.reason, 22, 2);
        const firstLineY = projLines.length === 1 ? rowY + 8.5 : rowY + 5.5;
        const reasonFirstLineY = reasonLines.length === 1 ? rowY + 8.5 : rowY + 5.5;

        delayContentSvg += `
        <rect x="${col1X}" y="${rowY}" width="${colWidth}" height="${twoColRowHeight}" fill="${rowBg}" />
        <text x="${col1X + 4}" y="${firstLineY.toFixed(1)}" class="content">${renderWrappedText(projLines, col1X + 4, firstLineY, twoColTextLineHeight)}</text>
        <text x="${col1X + 108}" y="${reasonFirstLineY.toFixed(1)}" class="content-reason">${renderWrappedText(reasonLines, col1X + 108, reasonFirstLineY, twoColTextLineHeight)}</text>
        <line x1="${col1X}" y1="${rowY + twoColRowHeight}" x2="${col1X + colWidth}" y2="${rowY + twoColRowHeight}" stroke="#ddd" stroke-width="0.3" />`;
      }

      // Column 2
      if (i < col2Tasks.length) {
        const t = col2Tasks[i];
        const projLines = wrapLines(t.title, 26, 2);
        const reasonLines = wrapLines(t.reason, 22, 2);
        const firstLineY = projLines.length === 1 ? rowY + 8.5 : rowY + 5.5;
        const reasonFirstLineY = reasonLines.length === 1 ? rowY + 8.5 : rowY + 5.5;

        delayContentSvg += `
        <rect x="${col2X}" y="${rowY}" width="${colWidth}" height="${twoColRowHeight}" fill="${rowBg}" />
        <text x="${col2X + 4}" y="${firstLineY.toFixed(1)}" class="content">${renderWrappedText(projLines, col2X + 4, firstLineY, twoColTextLineHeight)}</text>
        <text x="${col2X + 108}" y="${reasonFirstLineY.toFixed(1)}" class="content-reason">${renderWrappedText(reasonLines, col2X + 108, reasonFirstLineY, twoColTextLineHeight)}</text>
        <line x1="${col2X}" y1="${rowY + twoColRowHeight}" x2="${col2X + colWidth}" y2="${rowY + twoColRowHeight}" stroke="#ddd" stroke-width="0.3" />`;
      }
    }

    currentY = itemsStartY + maxRows * twoColRowHeight + 8;
    const delayTotalHeight = currentY - delayStartY;

    sectionsSvg += `
    <rect x="${MARGIN_X}" y="${delayStartY}" width="${CONTENT_WIDTH}" height="${delayTotalHeight}" fill="#fff" stroke="#666" stroke-width="0.8" rx="4" />
    <line x1="${col1X + colWidth + colGutter / 2}" y1="${headerY}" x2="${col1X + colWidth + colGutter / 2}" y2="${currentY - 8}" stroke="#666" stroke-width="0.8" />
    ${delayContentSvg}`;
  }

  const categorySub =
    categories && categories.length > 0 ? ` [${categories.join(' & ').toUpperCase()}]` : '';
  const userName = user?.trim();
  const heading = userName ? `${userName.toUpperCase()}'S PROJECTS` : 'ACTIVE TASKS';
  const fullTitle = `${heading}${categorySub}`;

  // Outer Boundary
  // Calculate dynamic title underline based on text width estimate (~6.8mm per char at 11px Arial bold)
  const estimatedTitleWidth = Math.min(fullTitle.length * 6.8, CONTENT_WIDTH - 40);
  const underlineX1 = Math.max(210 - estimatedTitleWidth / 2 - 8, MARGIN_X + 15);
  const underlineX2 = Math.min(210 + estimatedTitleWidth / 2 + 8, MARGIN_X + CONTENT_WIDTH - 15);

  return `<svg width="${POSTER_WIDTH}mm" height="${POSTER_HEIGHT}mm" viewBox="${POSTER_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" style="background-color: #ffffff;" role="img">
  <title>${escapeXml(fullTitle)}</title>
  <defs>
    <style>
      .title {
        font-family: Arial, sans-serif;
        font-size: 11px;
        font-weight: bold;
        text-anchor: middle;
        fill: #000;
        letter-spacing: 0.8px;
      }
      .border {
        fill: none;
        stroke: #333;
        stroke-width: 1.5;
        rx: ${BORDER_RADIUS};
      }
      .section-title {
        font-family: Arial, sans-serif;
        font-size: 14px;
        font-weight: bold;
        fill: #fff;
        text-anchor: middle;
        dominant-baseline: middle;
      }
      .header {
        font-family: Arial, sans-serif;
        font-size: 6.5px;
        font-weight: bold;
        fill: #000;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }
      .content {
        font-family: Arial, sans-serif;
        font-size: 6px;
        font-weight: 500;
        fill: #000;
      }
      .content-reason {
        font-family: Arial, sans-serif;
        font-size: 5.4px;
        fill: #444;
        font-style: italic;
      }
      .content-notes {
        font-family: Arial, sans-serif;
        font-size: 5.2px;
        fill: #555;
      }
      .star-light { fill: #ccc; font-size: 7px; }
      .star-dark { fill: #666; font-size: 7px; }
      .star-black { fill: #000; font-size: 7px; font-weight: bold; }
    </style>
  </defs>

  <!-- Outer Boundary -->
  <rect x="${MARGIN_X}" y="${MARGIN_Y}" width="${CONTENT_WIDTH}" height="${CONTENT_HEIGHT}" class="border" />

  <!-- Main Title -->
  <text x="210" y="30" class="title">${escapeXml(fullTitle)}</text>
  <line x1="${underlineX1.toFixed(1)}" y1="36" x2="${underlineX2.toFixed(1)}" y2="36" stroke="#333" stroke-width="1" />

  <!-- Active Status Tables -->
  ${sectionsSvg}
</svg>`;
}
