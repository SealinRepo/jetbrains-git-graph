import * as path from "node:path";
import type {
  Changelist,
  ChangelistsFile,
  FileAssignment,
} from "../../shared/types/changelists";

interface IdeaList {
  attributes: Record<string, string>;
  body: string;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(
    /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function decodeXml(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, name: string) => {
      if (name[0] === "#") {
        const codePoint =
          name[1].toLowerCase() === "x"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
      }
      const entities: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      };
      return entities[name.toLowerCase()] ?? entity;
    },
  );
}

function getProjectRelativePath(
  ideaPath: string,
  workspaceRoot: string,
): string | undefined {
  const expanded = ideaPath
    .replace(/^file:\/\/\/?/i, "")
    .replace(/\$PROJECT_DIR\$/g, workspaceRoot)
    .replace(/\$MODULE_DIR\$/g, workspaceRoot);
  const absolute = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspaceRoot, expanded);
  const relative = path.relative(workspaceRoot, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

function getListPaths(body: string, workspaceRoot: string): string[] {
  const paths = new Set<string>();
  for (const match of body.matchAll(/<change\b([^>]*?)\/?>/g)) {
    const attributes = parseAttributes(match[1]);
    const filePath = attributes.afterPath || attributes.beforePath;
    if (!filePath) continue;
    const relativePath = getProjectRelativePath(filePath, workspaceRoot);
    if (relativePath) paths.add(relativePath);
  }
  return [...paths];
}

/** Reads the ChangeListManager component in IDEA's project-level workspace.xml. */
export function parseIdeaChangelists(
  xml: string,
  workspaceRoot: string,
): ChangelistsFile | undefined {
  let componentBody: string | undefined;
  for (const match of xml.matchAll(
    /<component\b([^>]*)>([\s\S]*?)<\/component\s*>/g,
  )) {
    if (parseAttributes(match[1]).name === "ChangeListManager") {
      componentBody = match[2];
      break;
    }
  }
  if (componentBody === undefined) return undefined;

  const ideaLists: IdeaList[] = [];
  for (const match of componentBody.matchAll(
    /<list\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/list\s*>)/g,
  )) {
    ideaLists.push({
      attributes: parseAttributes(match[1]),
      body: match[2] ?? "",
    });
  }
  if (ideaLists.length === 0) return undefined;

  let defaultIndex = ideaLists.findIndex(
    (list) => list.attributes.default?.toLowerCase() === "true",
  );
  if (defaultIndex < 0) {
    defaultIndex = ideaLists.findIndex(
      (list) => list.attributes.name?.toLowerCase() === "changes",
    );
  }
  if (defaultIndex < 0) defaultIndex = 0;

  const ids = new Set<string>();
  const createdAt = Date.now();
  const changelists: Changelist[] = ideaLists.map((list, index) => {
    let id = list.attributes.id?.trim() || crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    return {
      id,
      name: list.attributes.name?.trim() || "Changes",
      comment: list.attributes.comment ?? "",
      isDefault: index === defaultIndex,
      createdAt,
    };
  });
  const defaultChangelistId = changelists[defaultIndex].id;

  const assignments: Record<string, FileAssignment> = {};
  for (let index = 0; index < ideaLists.length; index++) {
    if (index === defaultIndex) continue;
    const changelistId = changelists[index].id;
    for (const filePath of getListPaths(ideaLists[index].body, workspaceRoot)) {
      if (!assignments[filePath]) {
        assignments[filePath] = { changelistId };
      }
    }
  }

  let activeChangelistId = defaultChangelistId;
  const activeOption = [...componentBody.matchAll(/<option\b([^>]*?)\/?>/g)]
    .map((match) => parseAttributes(match[1]))
    .find((attributes) => attributes.name === "ACTIVE_CHANGELIST");
  if (activeOption?.value) {
    const activeList = changelists.find(
      (list) =>
        list.id === activeOption.value || list.name === activeOption.value,
    );
    if (activeList) activeChangelistId = activeList.id;
  }

  return {
    version: 2,
    changelists,
    activeChangelistId,
    defaultChangelistId,
    assignments,
  };
}
