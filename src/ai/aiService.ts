import * as vscode from "vscode";
import type {
  AiConfig,
  AiGenerateRequest,
  AiGenerateResponse,
  AiProvider,
} from "../../shared/protocol";
import {
  parseProviderError,
  sanitizeGeneratedMessage,
} from "./responseParsers";

const CONFIG_KEY = "aiConfig.v1";
/** Use full publisher id to avoid collisions with other extensions. */
const SECRET_KEY = "zjqtzzc.make-git-great-again.aiApiKey";

const DEFAULT_BASE_URL: Record<AiProvider, string> = {
  vscode: "",
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

const DEFAULT_MODEL: Record<AiProvider, string> = {
  vscode: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
};

const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
const MAX_REQUEST_TIMEOUT_SECONDS = 600;
/** Cap the diff portion of the prompt to stay within model context windows. */
const DIFF_CHAR_LIMIT = 16_000;
const MAX_OUTPUT_TOKENS = 8192;

function getRequestHeaders(baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/zjqtzzc/jetbrains-git-graph";
    headers["X-Title"] = "JetGit";
  }

  return headers;
}

interface PersistedConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
}

function normalizeRequestTimeoutSeconds(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_REQUEST_TIMEOUT_SECONDS;
  return Math.min(
    MAX_REQUEST_TIMEOUT_SECONDS,
    Math.max(1, Math.round(value as number)),
  );
}

export interface SetConfigInput {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  /** 当非空时替换存储的 API Key */
  apiKey?: string;
  /** 当为 true 时删除存储的 API Key */
  clearApiKey?: boolean;
  /** 生成长度限制，默认 200 */
  maxLength?: number;
  /** AI 请求超时秒数，默认 30 */
  requestTimeoutSeconds?: number;
  /** AI 请求语言：en / zh，默认 en */
  language?: "en" | "zh";
}

export class AiService {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly globalState: vscode.Memento,
  ) {}

  async getConfig(): Promise<AiConfig> {
    const raw = this.globalState.get<PersistedConfig>(CONFIG_KEY);
    const provider: AiProvider = raw?.provider ?? "vscode";
    const apiKey =
      provider === "vscode" ? "" : ((await this.secrets.get(SECRET_KEY)) ?? "");
    return {
      provider,
      baseUrl: raw?.baseUrl ?? DEFAULT_BASE_URL[provider],
      model: raw?.model ?? DEFAULT_MODEL[provider],
      hasApiKey: apiKey.length > 0,
      maxLength: this.globalState.get("aiConfig.maxLength") ?? 200,
      requestTimeoutSeconds: normalizeRequestTimeoutSeconds(
        this.globalState.get("aiConfig.requestTimeoutSeconds"),
      ),
      language:
        (this.globalState.get("aiConfig.language") as
          | "en"
          | "zh"
          | undefined) ?? "en",
    };
  }

  async setConfig(input: SetConfigInput): Promise<AiConfig> {
    const persisted: PersistedConfig = {
      provider: input.provider,
      baseUrl: input.baseUrl.trim(),
      model: input.model.trim(),
    };
    await this.globalState.update(CONFIG_KEY, persisted);
    await this.globalState.update("aiConfig.maxLength", input.maxLength ?? 200);
    await this.globalState.update(
      "aiConfig.requestTimeoutSeconds",
      normalizeRequestTimeoutSeconds(input.requestTimeoutSeconds),
    );
    await this.globalState.update("aiConfig.language", input.language ?? "en");
    if (input.clearApiKey) {
      await this.secrets.delete(SECRET_KEY);
    } else if (input.apiKey !== undefined && input.apiKey.length > 0) {
      await this.secrets.store(SECRET_KEY, input.apiKey);
    }
    return this.getConfig();
  }

  /**
   * Generate a commit message from a pre-computed diff.
   * The diff is fetched on the webview side via the protocol command
   * `aiGenerateCommitMessage` (which calls `gitService.getWorkingTreeDiff`);
   * here we only handle prompt construction + the actual model call.
   */
  async generate(
    cfg: AiConfig,
    diff: string,
    req: AiGenerateRequest,
    onChunk?: (chunk: string) => void,
  ): Promise<AiGenerateResponse> {
    // 1. 优先从改动行注释提取
    const extracted = tryExtractCommentFromDiff(diff);
    if (extracted) {
      const maxLen = cfg.maxLength ?? 200;
      return { message: extracted.trim().slice(0, maxLen) };
    }
    // 2. 无注释或无关键词 → 调 AI（引导生成标志标题 + 截断长度）
    const prompt = buildPrompt(
      diff,
      req.prefix,
      cfg.maxLength ?? 200,
      cfg.language ?? "en",
    );
    const requestTimeoutSeconds = normalizeRequestTimeoutSeconds(
      cfg.requestTimeoutSeconds,
    );
    const requestSignal = AbortSignal.timeout(requestTimeoutSeconds * 1000);
    let res: AiGenerateResponse;
    switch (cfg.provider) {
      case "vscode":
        res = await this.callVscodeLm(
          cfg.model,
          prompt,
          requestTimeoutSeconds,
          requestSignal,
          cfg.language ?? "en",
          onChunk,
        );
        break;
      case "anthropic":
        res = await this.callAnthropic(cfg, prompt, requestSignal, onChunk);
        break;
      case "openai":
        res = await this.callOpenAI(cfg, prompt, requestSignal, onChunk);
        break;
    }
    return {
      message: sanitizeGeneratedMessage(
        res.message,
        cfg.maxLength ?? 200,
        cfg.provider,
        cfg.language ?? "en",
      ),
    };
  }

  // ─── Provider implementations ──────────────────────────────────────────

  private async callVscodeLm(
    modelFamily: string,
    prompt: string,
    requestTimeoutSeconds: number,
    requestSignal: AbortSignal,
    language: "en" | "zh",
    onChunk?: (chunk: string) => void,
  ): Promise<AiGenerateResponse> {
    if (requestSignal.aborted) {
      throw new Error(
        `AI request timed out after ${requestTimeoutSeconds} seconds.`,
      );
    }

    let models: vscode.LanguageModelChat[];
    try {
      models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    } catch (err) {
      throw new Error(
        `Failed to query Copilot models: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const model =
      (modelFamily &&
        models.find((m) =>
          m.family?.toLowerCase().startsWith(modelFamily.toLowerCase()),
        )) ||
      models[0];
    if (!model) {
      throw new Error(
        "No GitHub Copilot chat model is available. " +
          "Sign in to GitHub Copilot and ensure at least one chat model is enabled.",
      );
    }

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const tokenSource = new vscode.CancellationTokenSource();
    const cancelRequest = () => tokenSource.cancel();
    requestSignal.addEventListener("abort", cancelRequest, { once: true });
    if (requestSignal.aborted) cancelRequest();
    try {
      const response = await model.sendRequest(messages, {}, tokenSource.token);
      let text = "";
      for await (const chunk of response.text) {
        const part = String(chunk);
        text += part;
        onChunk?.(part);
      }
      if (requestSignal.aborted) {
        throw new Error(
          `AI request timed out after ${requestTimeoutSeconds} seconds.`,
        );
      }
      return {
        message: sanitizeGeneratedMessage(text, undefined, "vscode", language),
      };
    } catch (err) {
      if (requestSignal.aborted) {
        throw new Error(
          `AI request timed out after ${requestTimeoutSeconds} seconds.`,
        );
      }
      throw err;
    } finally {
      requestSignal.removeEventListener("abort", cancelRequest);
      tokenSource.dispose();
    }
  }

  private async callAnthropic(
    cfg: AiConfig,
    prompt: string,
    requestSignal: AbortSignal,
    onChunk?: (chunk: string) => void,
  ): Promise<AiGenerateResponse> {
    let streamedText = "";

    const apiKey = (await this.secrets.get(SECRET_KEY)) ?? "";
    const baseUrl = cfg.baseUrl.trim();
    if (!apiKey) {
      throw new Error(
        "No Anthropic API key configured. Open the AI settings to add one.",
      );
    }
    const url = baseUrl.endsWith("/v1")
      ? `${baseUrl}/messages`
      : `${baseUrl}/v1/messages`;
    try {
      const headers = getRequestHeaders(baseUrl);
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers.accept = "text/event-stream";

      const resp = await fetch(url, {
        method: "POST",
        headers,
        signal: requestSignal,
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(
          `Anthropic API ${resp.status} ${resp.statusText}: ${body.slice(0, 300)}`,
        );
      }
      if (!resp.body) throw new Error("Anthropic response had no stream body.");
      for await (const event of readServerSentEvents(resp.body)) {
        if (event.event === "error") {
          throw new Error(
            parseProviderError(JSON.parse(event.data)) ?? event.data,
          );
        }
        if (event.event !== "content_block_delta") continue;
        const data = JSON.parse(event.data) as {
          delta?: { type?: string; text?: string };
        };
        const chunk =
          data.delta?.type === "text_delta" ? (data.delta.text ?? "") : "";
        if (!chunk) continue;
        streamedText += chunk;
        onChunk?.(chunk);
      }
      if (!streamedText.trim()) {
        throw new Error(
          `Anthropic returned an empty response. Check the configured base URL and model (${cfg.baseUrl} / ${cfg.model}).`,
        );
      }
      return { message: streamedText };
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error(String(err));
      if (requestSignal.aborted) {
        throw new Error(
          `Anthropic request timed out after ${normalizeRequestTimeoutSeconds(cfg.requestTimeoutSeconds)} seconds.`,
        );
      }
      throw normalized;
    }
  }

  private async callOpenAI(
    cfg: AiConfig,
    prompt: string,
    requestSignal: AbortSignal,
    onChunk?: (chunk: string) => void,
  ): Promise<AiGenerateResponse> {
    let streamedText = "";

    const apiKey = (await this.secrets.get(SECRET_KEY)) ?? "";
    if (!apiKey) {
      throw new Error(
        "No OpenAI API key configured. Open the AI settings to add one.",
      );
    }
    const baseUrl = cfg.baseUrl.trim();
    const url = baseUrl.endsWith("/v1")
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;
    const requestBody = {
      model: cfg.model,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
    };
    let finishReason: string | undefined;
    try {
      const headers = getRequestHeaders(baseUrl);
      headers.authorization = `Bearer ${apiKey}`;
      headers.accept = "text/event-stream";

      const resp = await fetch(url, {
        method: "POST",
        headers,
        signal: requestSignal,
        body: JSON.stringify({ ...requestBody, stream: true }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(
          `OpenAI API ${resp.status} ${resp.statusText}: ${body.slice(0, 300)}`,
        );
      }
      if (!resp.body) {
        throw new Error("OpenAI-compatible response had no stream body.");
      }
      for await (const event of readServerSentEvents(resp.body)) {
        if (event.data.trim() === "[DONE]") break;
        const data = JSON.parse(event.data) as {
          choices?: Array<{
            delta?: { content?: unknown };
            finish_reason?: unknown;
          }>;
        };
        const providerError = parseProviderError(data);
        if (providerError) throw new Error(providerError);
        const choice = data.choices?.[0];
        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const content = choice?.delta?.content;
        const chunk =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((part) => {
                    if (!part || typeof part !== "object") return "";
                    const text = (part as { text?: unknown }).text;
                    return typeof text === "string" ? text : "";
                  })
                  .join("")
              : "";
        if (!chunk) continue;
        streamedText += chunk;
        onChunk?.(chunk);
      }
      if (!streamedText.trim()) {
        const finishHint =
          finishReason === "length"
            ? ` The model exhausted the ${requestBody.max_completion_tokens}-token completion budget before producing visible text; reasoning tokens may count toward this limit.`
            : finishReason
              ? ` Provider finish_reason="${finishReason}".`
              : "";
        throw new Error(
          `The configured OpenAI-compatible provider returned an empty stream. Check the base URL and model (${cfg.baseUrl} / ${cfg.model}).${finishHint}`,
        );
      }
      return { message: streamedText };
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error(String(err));
      if (requestSignal.aborted) {
        throw new Error(
          `OpenAI-compatible provider request timed out after ${normalizeRequestTimeoutSeconds(cfg.requestTimeoutSeconds)} seconds.`,
        );
      }
      throw normalized;
    }
  }
}

interface ServerSentEvent {
  event: string;
  data: string;
}

async function* readServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseEvent = (block: string): ServerSentEvent | null => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value =
        separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    return data.length > 0 ? { event, data: data.join("\n") } : null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const separator = buffer.match(/\r?\n\r?\n/);
        if (!separator || separator.index === undefined) break;
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const event = parseEvent(block);
        if (event) yield event;
      }
      if (done) break;
    }
    if (buffer) {
      const event = parseEvent(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Assemble the Conventional-Commits prompt sent to every provider. */
function buildPrompt(
  rawDiff: string,
  prefix: string,
  maxLength = 200,
  language: "en" | "zh" = "en",
): string {
  const intro =
    "You write git commit messages in the Conventional Commits style. " +
    "If the change fixes a bug, start with 'fix:'; if it implements a feature/requirement, start with 'feat:'; " +
    "if it addresses a task, start with 'task:'. " +
    "Output ONLY the commit message text — no commentary, no markdown fences, no surrounding quotes. " +
    "Subject line should be ≤72 characters, imperative mood, no trailing period. " +
    `Keep the entire message under ${maxLength} characters (hard limit). ` +
    "Add a blank line + wrapped body (≤72 chars per line) only when it adds clarity. " +
    "Strictly follow the selected language: " +
    (language === "zh"
      ? "Return the entire commit message in Simplified Chinese only. Do not write English subject/body. The conventional type prefix like 'fix:' or 'feat:' is allowed, but the rest of the message must be Chinese; if the diff is in English, still translate it into Chinese."
      : "Return the entire commit message in English only. Do not write Chinese subject/body.");

  const prefixPart = prefix.trim()
    ? `The user already started a draft below; treat it as a hint and refine or extend it:\n\n${prefix.trim()}\n\n`
    : "";

  const trimmed =
    rawDiff.length > DIFF_CHAR_LIMIT
      ? `${rawDiff.slice(0, DIFF_CHAR_LIMIT)}\n\n[diff truncated — ${rawDiff.length - DIFF_CHAR_LIMIT} more chars omitted]`
      : rawDiff;

  return `${intro}\n\n${prefixPart}Here is the working-tree diff (unified format) to summarize:\n\n\`\`\`diff\n${trimmed}\n\`\`\``;
}

/** 提取改动行中的注释文本（去注释符、首尾空白）。 */
function extractCommentText(line: string): string | null {
  // 行注释 // ...
  const idx = line.indexOf("//");
  if (idx !== -1) return line.slice(idx + 2);
  // # ...（排除 #include / #define / #pragma）
  const hashIdx = line.indexOf("#");
  if (hashIdx !== -1) {
    const after = line.slice(hashIdx + 1).trim();
    if (after.length > 0 && !/^\s*(include|define|pragma)\b/i.test(after)) {
      return after;
    }
  }
  // 块注释 /* ... */（单行内）
  const block = line.match(/\/\*([^*]*?)\*\//);
  if (block) return block[1];
  // XML/HTML <!-- ... -->
  const xml = line.match(/<!--(.*?)-->/);
  if (xml) return xml[1];
  // Javadoc /** ... */
  const jdoc = line.match(/\/\*\*([^*]*?)\*\//);
  if (jdoc) return jdoc[1];
  return null;
}

/** 从 diff 文本中查找本次改动行的注释；若含关键词则直接返回。 */
function tryExtractCommentFromDiff(text: string): string | null {
  const keywords = ["bug", "fix", "task", "需求", "任务", "功能"];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // 只看新增/修改行（+ 开头，除 +++ 头）
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const content = line.slice(1);
    const comment = extractCommentText(content);
    if (!comment) continue;
    const lower = comment.toLowerCase();
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) {
      return comment.trim().replace(/\s+/g, " ");
    }
  }
  return null;
}
