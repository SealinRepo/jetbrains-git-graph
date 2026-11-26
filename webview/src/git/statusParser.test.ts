import { describe, expect, it } from "vitest";
import { parsePorcelainV1Z } from "../../../src/git/gitService/statusParser";

describe("parsePorcelainV1Z", () => {
  it("returns filenames with spaces without adding quotes", () => {
    const path = String.raw`src\views\example\vxeTableEdit\index copy.vue`;

    expect(parsePorcelainV1Z(`?? ${path}\0`)).toEqual([
      {
        indexStatus: "?",
        workTreeStatus: "?",
        path,
      },
    ]);
  });

  it("reads destination and source paths for renames", () => {
    expect(
      parsePorcelainV1Z("R  src/new name.vue\0src/old name.vue\0"),
    ).toEqual([
      {
        indexStatus: "R",
        workTreeStatus: " ",
        path: "src/new name.vue",
        oldPath: "src/old name.vue",
      },
    ]);
  });
});
