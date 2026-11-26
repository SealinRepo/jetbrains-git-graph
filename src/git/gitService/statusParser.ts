export interface PorcelainStatusEntry {
  indexStatus: string;
  workTreeStatus: string;
  path: string;
  oldPath?: string;
}

/** Parse `git status --porcelain=v1 -z` output without path quoting ambiguity. */
export function parsePorcelainV1Z(output: string): PorcelainStatusEntry[] {
  const fields = output.split("\0");
  const entries: PorcelainStatusEntry[] = [];

  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record || record.length < 4) continue;

    const indexStatus = record[0];
    const workTreeStatus = record[1];
    const path = record.slice(3);
    const isRenameOrCopy =
      indexStatus === "R" ||
      workTreeStatus === "R" ||
      indexStatus === "C" ||
      workTreeStatus === "C";
    const oldPath = isRenameOrCopy ? fields[++i] : undefined;

    entries.push({
      indexStatus,
      workTreeStatus,
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
    });
  }

  return entries;
}
