/**
 * Markdown as one line of plain words, for places that show a task's reason in passing: the
 * collapsed card, the search results, the review screens. Tasks created by tools often carry
 * Markdown (a GitHub issue body, a pasted note), and "## Background" or backticks read as noise
 * in a one-line summary.
 */
export function markdownToPlainText(markdown: string | null | undefined): string {
  if (!markdown) {
    return '';
  }
  return (
    markdown
      // Code blocks: keep the code, drop the fences
      .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
      // Images carry nothing to say; links keep their text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Inline HTML
      .replace(/<[^>]+>/g, ' ')
      // Headings, block quotes, list markers and rules at the start of a line
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
      // Emphasis and code ticks
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      // One line
      .replace(/\s+/g, ' ')
      .trim()
  );
}
