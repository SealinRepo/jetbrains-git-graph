import { describe, expect, it } from "vitest";
import { parseIdeaChangelists } from "../../../../src/changelists/ideaChangelists";

describe("parseIdeaChangelists", () => {
  const root = "C:\\repo";

  it("parses IDEA lists, active list and project-relative file assignments", () => {
    const state = parseIdeaChangelists(
      `<project>
        <component name="ChangeListManager">
          <list default="true" id="default-id" name="Changes" comment="" />
          <list id="feature-id" name="Feature &amp; Fix" comment="work">
            <change beforePath="$PROJECT_DIR$/src/old.ts" beforeDir="false"
              afterPath="$PROJECT_DIR$/src/new.ts" afterDir="false" />
            <change afterPath="$PROJECT_DIR$/src/new.ts" afterDir="false" />
            <change afterPath="$PROJECT_DIR$/../outside.ts" afterDir="false" />
          </list>
          <option name="ACTIVE_CHANGELIST" value="feature-id" />
        </component>
      </project>`,
      root,
    );

    expect(
      state?.changelists.map(({ id, name, comment, isDefault }) => ({
        id,
        name,
        comment,
        isDefault,
      })),
    ).toEqual([
      {
        id: "default-id",
        name: "Changes",
        comment: "",
        isDefault: true,
      },
      {
        id: "feature-id",
        name: "Feature & Fix",
        comment: "work",
        isDefault: false,
      },
    ]);
    expect(state?.activeChangelistId).toBe("feature-id");
    expect(state?.assignments).toEqual({
      "src/new.ts": { changelistId: "feature-id" },
    });
  });

  it("returns undefined when IDEA changelist configuration is absent", () => {
    expect(parseIdeaChangelists("<project />", root)).toBeUndefined();
  });
});
