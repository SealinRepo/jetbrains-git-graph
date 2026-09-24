import { describe, expect, it } from "vitest";
import {
  parseProviderResponse,
  sanitizeGeneratedMessage,
} from "../../../src/ai/responseParsers";

describe("parseProviderResponse", () => {
  it("extracts text from OpenAI-style response payloads", () => {
    const payload = {
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "feat: add commit message helper" },
            ],
          },
        },
      ],
    };

    expect(parseProviderResponse(payload)).toBe(
      "feat: add commit message helper",
    );
  });

  it("extracts text from Anthropic-style response payloads", () => {
    const payload = {
      content: [
        { type: "text", text: "fix: repair empty AI response handling" },
      ],
    };

    expect(parseProviderResponse(payload)).toBe(
      "fix: repair empty AI response handling",
    );
  });
});

describe("sanitizeGeneratedMessage", () => {
  it("rejects empty provider output instead of inventing a fallback commit", () => {
    expect(() => sanitizeGeneratedMessage("", 200, "openai")).toThrow(
      /empty response/i,
    );
  });

  it("strips markdown fences and enforces max length", () => {
    const message = sanitizeGeneratedMessage(
      "```text\nfeat: add helper\n```",
      12,
      "openai",
    );
    expect(message).toBe("feat: add he");
  });

  it("rejects English output when Chinese language is selected", () => {
    expect(() =>
      sanitizeGeneratedMessage("fix: update cache", 200, "openai", "zh"),
    ).toThrow(/Chinese/i);
  });
});
