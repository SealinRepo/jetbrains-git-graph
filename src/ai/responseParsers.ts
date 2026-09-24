import type { AiProvider } from "../../shared/protocol";

function collectTextCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextCandidates(item));
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const hits: string[] = [];

    for (const [key, child] of Object.entries(obj)) {
      if (
        key === "text" ||
        key === "content" ||
        key === "output_text" ||
        key === "message" ||
        key === "choices" ||
        key === "delta" ||
        key === "completion"
      ) {
        hits.push(...collectTextCandidates(child));
      }
    }

    return hits;
  }

  return [];
}

export function parseProviderResponse(data: unknown): string | null {
  const texts = collectTextCandidates(data)
    .map((text) => text.replace(/\r\n/g, "\n").trim())
    .filter((text) => text.length > 0);

  return texts[0] ?? null;
}

export function parseProviderError(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const obj = data as Record<string, unknown>;

  const direct =
    typeof obj.error === "string"
      ? obj.error
      : typeof obj.message === "string"
        ? obj.message
        : null;
  if (direct?.trim()) {
    return direct.trim();
  }

  const nestedError = obj.error;
  if (nestedError && typeof nestedError === "object") {
    const errorObj = nestedError as Record<string, unknown>;
    for (const key of ["message", "error", "code", "type"]) {
      const value = errorObj[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  return null;
}

export function sanitizeGeneratedMessage(
  raw: string | null | undefined,
  maxLength = 200,
  provider?: AiProvider,
  language: "en" | "zh" = "en",
): string {
  const text = raw?.replace(/\r\n/g, "\n").trim() ?? "";
  if (!text) {
    const providerHint = provider ? ` (${provider})` : "";
    throw new Error(
      `AI provider returned an empty response${providerHint}. Check the selected model, base URL, and API key configuration.`,
    );
  }

  const cleaned = text
    .replace(/^```(?:diff|text|markdown)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .replace(/^['"`]+/, "")
    .replace(/['"`]+$/, "")
    .trim();

  if (!cleaned) {
    throw new Error(
      `AI provider returned a blank message${provider ? ` for ${provider}` : ""}.`,
    );
  }

  if (language === "zh") {
    const messageWithoutType = cleaned.replace(/^\s*([a-z]+\s*:)\s*/i, "");
    const hasChinese = /[\u4e00-\u9fff]/.test(messageWithoutType);
    const hasEnglish = /[A-Za-z]/.test(messageWithoutType);
    if (!hasChinese && hasEnglish) {
      throw new Error(
        "AI returned English text while the configured language is Chinese. Please retry with a Chinese-capable model or switch language settings.",
      );
    }
  }

  return cleaned.slice(0, Math.max(maxLength, 1));
}
