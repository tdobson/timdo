import type { CompletedPosterData, CompletedPosterItem } from './completedPosterService';
import { escapeXml } from './posterSvgService';

// Overall banner dimensions: 2 A4 wide x 3 A4 tall
// Standard A4 at 96 DPI: 210mm x 297mm -> ~793.7px x 1122.5px
// 2 A4 width = 1587.4 -> 1587 px
// 3 A4 height = 3367.5 -> 3368 px
export const MASTER_BANNER_WIDTH = 1587;
export const MASTER_BANNER_HEIGHT = 3368;
export const MASTER_BANNER_VIEWBOX = `0 0 ${MASTER_BANNER_WIDTH} ${MASTER_BANNER_HEIGHT}`;

export const A4_SHEET_WIDTH = MASTER_BANNER_WIDTH / 2; // 793.5 px (~210mm)
export const A4_SHEET_HEIGHT = MASTER_BANNER_HEIGHT / 3; // 1122.67 px (~297mm)

// Margins & column layout
const MARGIN_LEFT = 35;
const MARGIN_RIGHT = 35;
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 40;
const COLUMN_GAP = 25;
const USABLE_WIDTH = MASTER_BANNER_WIDTH - MARGIN_LEFT - MARGIN_RIGHT - COLUMN_GAP * 3;
const COLUMN_WIDTH = USABLE_WIDTH / 4; // ~346px per column

const TIER_HEIGHT = MASTER_BANNER_HEIGHT / 3; // 1122.67 px
const TIER_PADDING_TOP = 25;
const TIER_PADDING_BOTTOM = 25;
const HEADER_HEIGHT = 45;
const OVERFLOW_NOTICE_HEIGHT = 36;

export interface A4Tile {
  sheetIndex: number;
  label: string;
  tier: number;
  colOffset: number;
  svg: string;
}

/**
 * Truncates text to max length with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '…';
}

/**
 * Word wrap text into up to maxLines lines, truncating the final line if necessary
 */
function wrapLines(
  str: string | null | undefined,
  maxCharsPerLine: number,
  maxLines = 2
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
        const rest = words.slice(i).join(' ');
        lines.push(truncate(rest, maxCharsPerLine));
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
 * Renders solid black signal micro-bars for task challenge/size (1 to 5)
 * Size 1 to 5 bars, solid black filled with 0.5px rounded corners
 */
export function generateSignalMicroBarsSvg(x: number, y: number, size: number): string {
  const activeBars = Math.max(1, Math.min(5, size));
  const barWidth = 2.4;
  const barGap = 1.4;
  const totalHeight = 13;
  let barsSvg = '';

  for (let i = 0; i < activeBars; i++) {
    // Bars grow progressively taller from 3.5px to 13px
    const h = 3.5 + i * 2.375;
    const barX = x + i * (barWidth + barGap);
    const barY = y + (totalHeight - h);
    barsSvg += `<rect x="${barX.toFixed(2)}" y="${barY.toFixed(
      2
    )}" width="${barWidth}" height="${h.toFixed(2)}" rx="0.5" fill="#000000" />`;
  }

  return barsSvg;
}

/**
 * Renders a single task item inside a column lane with larger typography and multi-line wrapping
 */
function renderTaskItem(
  item: CompletedPosterItem,
  x: number,
  y: number,
  width: number
): { svg: string; height: number } {
  let itemSvg = '';
  const itemTop = y;

  // Signal micro-bars at top left
  const signalSvg = generateSignalMicroBarsSvg(x, y + 2, item.size);
  itemSvg += signalSvg;

  // Title on Line 1 & Line 2 if long
  const titleX = x + 23;
  const dateStr = `${item.dateDay}${item.dateSuffix} ${item.dateMonthYear.split(' ')[0]}`;
  const maxTitleChars = width > 320 ? 30 : 25;
  const titleLines = wrapLines(item.title, maxTitleChars, 2);

  // Date on the top right
  const dateRightX = x + width;
  itemSvg += `<text x="${dateRightX.toFixed(2)}" y="${(y + 12).toFixed(
    2
  )}" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="11.5" font-weight="600" fill="#666666">${escapeXml(
    dateStr
  )}</text>`;

  let currentY = y + 12;
  // Render wrapped title lines (14px font, bold)
  for (let i = 0; i < titleLines.length; i++) {
    const lineY = currentY + i * 16;
    itemSvg += `<text x="${titleX.toFixed(2)}" y="${lineY.toFixed(
      2
    )}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="14" font-weight="700" fill="#000000">${escapeXml(
      titleLines[i]
    )}</text>`;
  }
  currentY += (titleLines.length - 1) * 16 + 8;

  // Sub-row: Optional Reason, Epic tag, or Aim capsule
  const hasLine2 = !!(item.reason || item.epicTitle || item.goalTitle);

  if (hasLine2) {
    currentY += 8;
    let badgeX = titleX;

    if (item.epicTitle) {
      const epicClean = escapeXml(truncate(item.epicTitle.toUpperCase(), 22));
      const epicBadgeWidth = Math.min(150, epicClean.length * 7.2 + 12);
      itemSvg += `<g transform="translate(${badgeX.toFixed(2)}, ${(currentY - 11).toFixed(2)})">`;
      itemSvg += `<rect x="0" y="0" width="${epicBadgeWidth}" height="15" fill="#F0F0F0" rx="2" />`;
      itemSvg += `<rect x="0" y="0" width="3" height="15" fill="#000000" />`;
      itemSvg += `<text x="7" y="11" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="9.5" font-weight="700" fill="#111111">${epicClean}</text>`;
      itemSvg += `</g>`;
      badgeX += epicBadgeWidth + 8;
    }

    if (item.goalTitle && badgeX + 90 < x + width) {
      const icon = item.goalIcon ? `${item.goalIcon} ` : '';
      const goalClean = escapeXml(truncate(`${icon}${item.goalTitle}`, 24));
      const goalBadgeWidth = Math.min(160, goalClean.length * 6.5 + 12);
      itemSvg += `<g transform="translate(${badgeX.toFixed(2)}, ${(currentY - 11).toFixed(2)})">`;
      itemSvg += `<rect x="0" y="0" width="${goalBadgeWidth}" height="15" fill="#FFFFFF" stroke="#CCCCCC" stroke-width="0.8" rx="7.5" />`;
      itemSvg += `<text x="7" y="11" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="9" font-weight="600" fill="#444444">${goalClean}</text>`;
      itemSvg += `</g>`;
      badgeX += goalBadgeWidth + 8;
    }

    if (item.reason && !item.epicTitle && !item.goalTitle) {
      const reasonLines = wrapLines(item.reason, maxTitleChars + 6, 2);
      for (let rIdx = 0; rIdx < reasonLines.length; rIdx++) {
        itemSvg += `<text x="${titleX.toFixed(2)}" y="${(currentY + rIdx * 13).toFixed(
          2
        )}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="11" fill="#666666" font-style="italic">${escapeXml(
          reasonLines[rIdx]
        )}</text>`;
      }
      currentY += (reasonLines.length - 1) * 13;
    }

    currentY += 8;
  } else {
    currentY += 6;
  }

  // Subtle separator line
  itemSvg += `<line x1="${titleX.toFixed(2)}" y1="${currentY.toFixed(2)}" x2="${(x + width).toFixed(
    2
  )}" y2="${currentY.toFixed(2)}" stroke="#EAEAEA" stroke-width="0.75" />`;

  return {
    svg: itemSvg,
    height: currentY - itemTop + 8,
  };
}

interface RenderedTaskItem {
  item: CompletedPosterItem;
  svg: string;
  height: number;
}

interface ColumnLayout {
  visibleItems: RenderedTaskItem[];
  omittedCount: number;
  footerY: number | null;
}

function layoutColumnItems(
  items: CompletedPosterItem[],
  x: number,
  startY: number,
  width: number,
  maxY: number
): ColumnLayout {
  const measuredItems: RenderedTaskItem[] = [];
  let currentY = startY;

  for (const item of items) {
    const { svg, height } = renderTaskItem(item, x, currentY, width);
    if (currentY + height > maxY) {
      const availableHeight = maxY - startY;
      const visibleItems: RenderedTaskItem[] = [];
      let usedHeight = 0;

      for (const measuredItem of measuredItems) {
        if (usedHeight + measuredItem.height + OVERFLOW_NOTICE_HEIGHT > availableHeight) {
          break;
        }
        visibleItems.push(measuredItem);
        usedHeight += measuredItem.height;
      }

      return {
        visibleItems,
        omittedCount: items.length - visibleItems.length,
        footerY: startY + usedHeight,
      };
    }

    measuredItems.push({ item, svg, height });
    currentY += height;
  }

  return { visibleItems: measuredItems, omittedCount: 0, footerY: null };
}

function renderOverflowNotice(
  x: number,
  y: number,
  shownCount: number,
  omittedCount: number,
  tierIdx: number,
  colIdx: number
): string {
  const totalCount = shownCount + omittedCount;
  const taskLabel = totalCount === 1 ? 'task' : 'tasks';
  return `<g data-overflow-notice="true" data-tier-index="${tierIdx}" data-column-index="${colIdx}" data-shown-count="${shownCount}" data-omitted-count="${omittedCount}"><text x="${x.toFixed(
    2
  )}" y="${(y + 13).toFixed(
    2
  )}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="11" font-weight="700" fill="#444444">Showing ${shownCount} of ${totalCount} ${taskLabel} (${omittedCount} omitted)</text><text x="${x.toFixed(
    2
  )}" y="${(y + 28).toFixed(
    2
  )}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="11" fill="#666666">See Done in TimDo for the full list.</text></g>`;
}

/**
 * Returns column header title for a specific column and tier
 */
function getColumnHeader(
  colIdx: number,
  tierIdx: number,
  previousItems: RenderedTaskItem[],
  currentItems: RenderedTaskItem[]
): string {
  if (colIdx < 3) {
    return tierIdx === 0 ? 'PERSONAL WORKSPACE' : 'PERSONAL WORKSPACE (CONT.)';
  }
  if (tierIdx === 0) {
    return 'OTHER WORKSPACES';
  }

  const previousCategory = previousItems[previousItems.length - 1]?.item.category.trim();
  const currentCategory = currentItems[0]?.item.category.trim();
  if (
    previousCategory &&
    currentCategory &&
    previousCategory.toLowerCase() === currentCategory.toLowerCase()
  ) {
    return `OTHER WORKSPACES: ${currentCategory.toUpperCase()} (CONT.)`;
  }

  return 'OTHER WORKSPACES (CONT.)';
}

/**
 * Generates the full master banner SVG string (0 0 1587 3368)
 */
export function generateWallOfDoneSvg(data: CompletedPosterData): string {
  const columnLayouts: ColumnLayout[][] = [];

  for (let tierIdx = 0; tierIdx < 3; tierIdx++) {
    const tierTop = tierIdx * TIER_HEIGHT;
    const headerY = tierTop + MARGIN_TOP + 5;
    const startY = headerY + HEADER_HEIGHT;
    const maxY = tierTop + TIER_HEIGHT - MARGIN_BOTTOM;
    const tierLayouts: ColumnLayout[] = [];

    for (let colIdx = 0; colIdx < 4; colIdx++) {
      const colX = MARGIN_LEFT + colIdx * (COLUMN_WIDTH + COLUMN_GAP);
      const items = data.tiers[tierIdx]?.columns[colIdx] || [];
      tierLayouts.push(layoutColumnItems(items, colX, startY, COLUMN_WIDTH, maxY));
    }

    columnLayouts.push(tierLayouts);
  }

  let bodySvg = '';

  // Background
  bodySvg += `<rect x="0" y="0" width="${MASTER_BANNER_WIDTH}" height="${MASTER_BANNER_HEIGHT}" fill="#FFFFFF" />`;

  // Draw 3 tiers
  for (let tierIdx = 0; tierIdx < 3; tierIdx++) {
    const tierTop = tierIdx * TIER_HEIGHT;

    // Aligned Refresher Header bar across all 4 columns
    const headerY = tierTop + MARGIN_TOP + 5;

    for (let colIdx = 0; colIdx < 4; colIdx++) {
      const colX = MARGIN_LEFT + colIdx * (COLUMN_WIDTH + COLUMN_GAP);
      const currentColumnLayout = columnLayouts[tierIdx][colIdx];
      const previousItems = tierIdx > 0 ? columnLayouts[tierIdx - 1][colIdx].visibleItems : [];
      const headerTitle = getColumnHeader(
        colIdx,
        tierIdx,
        previousItems,
        currentColumnLayout.visibleItems
      );

      // Category Header with 2px underline rule
      bodySvg += `<text x="${colX.toFixed(2)}" y="${(headerY + 12).toFixed(
        2
      )}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="12" font-weight="900" letter-spacing="1.5" fill="#000000">${escapeXml(
        headerTitle
      )}</text>`;
      bodySvg += `<line x1="${colX.toFixed(2)}" y1="${(headerY + 18).toFixed(2)}" x2="${(
        colX + COLUMN_WIDTH
      ).toFixed(2)}" y2="${(headerY + 18).toFixed(2)}" stroke="#000000" stroke-width="2" />`;

      // Render complete task rows and report any items that do not fit
      for (const renderedItem of currentColumnLayout.visibleItems) {
        bodySvg += `<g data-task-id="${escapeXml(renderedItem.item.id)}" data-tier-index="${tierIdx}">${renderedItem.svg}</g>`;
      }

      if (currentColumnLayout.omittedCount > 0 && currentColumnLayout.footerY !== null) {
        bodySvg += renderOverflowNotice(
          colX,
          currentColumnLayout.footerY,
          currentColumnLayout.visibleItems.length,
          currentColumnLayout.omittedCount,
          tierIdx,
          colIdx
        );
      }
    }

    // Tier boundary guideline (for physical cutting and alignment)
    if (tierIdx < 2) {
      const boundaryY = (tierIdx + 1) * TIER_HEIGHT;
      bodySvg += `<line x1="10" y1="${boundaryY.toFixed(2)}" x2="${(
        MASTER_BANNER_WIDTH - 10
      ).toFixed(2)}" y2="${boundaryY.toFixed(
        2
      )}" stroke="#CCCCCC" stroke-width="0.75" stroke-dasharray="4,4" />`;
      bodySvg += `<text x="${(MASTER_BANNER_WIDTH / 2).toFixed(2)}" y="${(boundaryY - 4).toFixed(
        2
      )}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="8" fill="#999999" letter-spacing="2">TIER ${
        tierIdx + 1
      } / TIER ${tierIdx + 2} CUT &amp; JOIN LINE</text>`;
    }
  }

  // Vertical center join line (between Left Sheets 1,3,5 and Right Sheets 2,4,6)
  const centerX = MASTER_BANNER_WIDTH / 2;
  bodySvg += `<line x1="${centerX.toFixed(2)}" y1="10" x2="${centerX.toFixed(2)}" y2="${(
    MASTER_BANNER_HEIGHT - 10
  ).toFixed(2)}" stroke="#CCCCCC" stroke-width="0.75" stroke-dasharray="4,4" />`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MASTER_BANNER_VIEWBOX}" width="${MASTER_BANNER_WIDTH}" height="${MASTER_BANNER_HEIGHT}">
  <style>
    text { user-select: none; }
  </style>
  ${bodySvg}
</svg>`;
}

/**
 * Generates 6 discrete A4 SVGs with registration marks for standard printing
 */
export function generateTiledA4Svgs(data: CompletedPosterData): A4Tile[] {
  const masterSvg = generateWallOfDoneSvg(data);
  const tiles: A4Tile[] = [];

  const tierNames = ['Tier 1', 'Tier 2', 'Tier 3'];
  const sideNames = ['Left', 'Right'];

  let sheetCount = 1;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 2; col++) {
      const sheetIndex = sheetCount++;
      const originX = col * A4_SHEET_WIDTH;
      const originY = row * A4_SHEET_HEIGHT;
      const label = `Sheet ${sheetIndex} of 6 (${tierNames[row]} - ${sideNames[col]})`;

      // Registration crosshairs and sheet tags on corners
      let regMarks = '';
      const regTag = `+ P${sheetIndex}`;
      regMarks += `<text x="15" y="20" font-family="-apple-system, sans-serif" font-size="9" font-weight="700" fill="#888888">${regTag} [${label}]</text>`;
      regMarks += `<text x="${A4_SHEET_WIDTH - 15}" y="20" text-anchor="end" font-family="-apple-system, sans-serif" font-size="9" font-weight="700" fill="#888888">${regTag}</text>`;
      regMarks += `<text x="15" y="${A4_SHEET_HEIGHT - 15}" font-family="-apple-system, sans-serif" font-size="9" font-weight="700" fill="#888888">${regTag}</text>`;
      regMarks += `<text x="${A4_SHEET_WIDTH - 15}" y="${A4_SHEET_HEIGHT - 15}" text-anchor="end" font-family="-apple-system, sans-serif" font-size="9" font-weight="700" fill="#888888">${regTag}</text>`;

      // Extract inner content without XML declaration or wrapping svg tags
      const innerContent = masterSvg
        .replace(/<\?xml.*?\?>/, '')
        .replace(/<svg[^>]*>/, '')
        .replace(new RegExp('</' + 'svg>', 'g'), '');

      // Clip path / sub-viewbox for this A4 sheet
      const tileSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${A4_SHEET_WIDTH} ${A4_SHEET_HEIGHT}" width="${A4_SHEET_WIDTH}" height="${A4_SHEET_HEIGHT}">
  <style>
    text { user-select: none; }
  </style>
  <rect x="0" y="0" width="${A4_SHEET_WIDTH}" height="${A4_SHEET_HEIGHT}" fill="#FFFFFF" />
  <!-- Nested content shifted to local A4 origin -->
  <g transform="translate(-${originX.toFixed(2)}, -${originY.toFixed(2)})">
    ${innerContent}
  </g>
  ${regMarks}
</svg>`;

      tiles.push({
        sheetIndex,
        label,
        tier: row + 1,
        colOffset: col,
        svg: tileSvg,
      });
    }
  }

  return tiles;
}
