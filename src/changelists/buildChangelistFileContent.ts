import type { HunkInfo } from "../../shared/types/changelists";

/** A line interval on the new (working tree) side of the diff. */
interface LineRange {
  startLine: number;
  endLine: number;
}

/** The two sides of a single hunk, extracted from its `patchText`. */
interface HunkSides {
  /** 1-based first line of the hunk's old-side span (includes context). */
  oldStart: number;
  /** How many old-side lines the hunk covers (context + removed lines). */
  oldCount: number;
  /** The hunk's new-side lines (context + added lines). */
  newLines: string[];
}

function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return !(a.endLine < b.startLine || b.endLine < a.startLine);
}

/**
 * Pull the old/new sides out of a hunk's raw `patchText`.
 *
 * `patchText` is the `@@ -a,b +c,d @@` header followed by the body lines, each
 * prefixed with `+` / `-` / ` ` (context). The parser in `gitService/hunks.ts`
 * appends bare empty lines verbatim, so an empty string has to be treated as an
 * empty context line too.
 */
function parseHunkSides(hunk: HunkInfo): HunkSides {
  const body = hunk.patchText.split("\n").slice(1);
  let oldCount = 0;
  const newLines: string[] = [];
  for (const line of body) {
    // "\ No newline at end of file" is metadata, not content.
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      oldCount++;
      continue;
    }
    oldCount++;
    newLines.push(line.startsWith(" ") ? line.slice(1) : line);
  }
  return { oldStart: hunk.oldStart, oldCount, newLines };
}

/**
 * Build the file content that contains **only** the changes owned by one
 * changelist: start from the committed version, then splice in just the hunks
 * that changelist owns.
 *
 * This is what makes a list-scoped diff possible without touching the working
 * tree or the git index — the right-hand side of the diff editor is a synthetic
 * document, so the other changelists' lines simply don't exist in it.
 *
 * The hunk→changelist decision is made by the caller's `targetRanges` (i.e. by
 * `getTargetLineRanges`), the very same function that decides what a commit of
 * that changelist would stage. Diff and commit therefore can't disagree.
 *
 * Hunks are atomic, exactly as in `filterPatchByHunks` and `getTargetLineRanges`:
 * a hunk overlapping one owned line is included whole.
 */
export function buildChangelistFileContent(
  headContent: string,
  hunks: HunkInfo[],
  targetRanges: LineRange[],
): string {
  const selected = hunks
    .filter((h) => targetRanges.some((r) => rangesOverlap(h, r)))
    .sort((a, b) => a.oldStart - b.oldStart);

  if (selected.length === 0) return headContent;

  const lines =
    headContent.length === 0
      ? []
      : headContent.replace(/\r?\n$/, "").split(/\r?\n/);

  for (const hunk of selected) {
    const { oldStart, oldCount, newLines } = parseHunkSides(hunk);
    // `oldStart` is 1-based; a hunk starting at 0 can only happen for an empty
    // file, where clamping to 0 is the right thing.
    const from = Math.max(oldStart - 1, 0);
    lines.splice(from, oldCount, ...newLines);
  }

  if (lines.length === 0) return "";

  // Trailing-newline state: normally inherited from the committed version, but a
  // selected hunk carrying "\ No newline at end of file" means the new side
  // ends without one. Getting this wrong shows a bogus last-line change.
  let endsWithNewline = headContent.endsWith("\n");
  for (const hunk of selected) {
    if (hunk.patchText.includes("\\ No newline at end of file")) {
      endsWithNewline = false;
    }
  }

  return lines.join("\n") + (endsWithNewline ? "\n" : "");
}
