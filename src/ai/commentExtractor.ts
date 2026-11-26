const COMMENT_MARKER =
  /\b(?:bug|fix|task|feature|feat|requirement)\b|需求|任务|功能/i;

/** Extract a source comment from a changed line. */
function extractCommentText(line: string): string | null {
  const trimmed = line.trim();
  let comment: string | null = null;

  if (trimmed.startsWith("//")) {
    comment = trimmed.slice(2);
  } else if (trimmed.startsWith("#")) {
    const text = trimmed.slice(1).trim();
    if (!/^(include|define|pragma)\b/i.test(text)) comment = text;
  } else if (trimmed.startsWith("<!--")) {
    comment = trimmed.slice(4).replace(/-->\s*$/, "");
  } else if (trimmed.startsWith("/*")) {
    comment = trimmed.replace(/^\/\*+/, "").replace(/\*\/\s*$/, "");
  } else if (trimmed.startsWith("*")) {
    comment = trimmed.replace(/^\*+\s?/, "").replace(/\*\/\s*$/, "");
  } else {
    const lineComment = trimmed.indexOf("//");
    const blockComment = trimmed.indexOf("/*");
    const xmlComment = trimmed.indexOf("<!--");
    const commentStart = [lineComment, blockComment, xmlComment]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];

    if (commentStart !== undefined) {
      comment = trimmed.slice(commentStart);
      if (comment.startsWith("//")) comment = comment.slice(2);
      else if (comment.startsWith("<!--")) {
        comment = comment.slice(4).replace(/-->\s*$/, "");
      } else {
        comment = comment.replace(/^\/\*+/, "").replace(/\*\/\s*$/, "");
      }
    }
  }

  return (
    comment
      ?.trim()
      .replace(/^\*+\s*/, "")
      .replace(/\s*\*\/$/, "") || null
  );
}

/** Return the added comment text when it describes a bug, fix, task, or feature. */
export function extractCommitCommentFromDiff(diff: string): string | null {
  for (const rawLine of diff.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    const comment = extractCommentText(line.slice(1));
    if (comment && COMMENT_MARKER.test(comment)) {
      return comment.replace(/\s+/g, " ");
    }
  }
  return null;
}
