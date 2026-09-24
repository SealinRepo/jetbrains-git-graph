import * as vscode from "vscode";
import type {
  AiConfig,
  AiGenerateRequest,
  AiGenerateResponse,
  AiProvider,
} from "../../shared/protocol";

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

/** Cap the diff portion of the prompt to stay within model context windows. */
const DIFF_CHAR_LIMIT = 16_000;
const MAX_OUTPUT_TOKENS = 1024;

interface PersistedConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
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
  ): Promise<AiGenerateResponse> {
    // 1. 优先从改动行注释提取
    const extracted = tryExtractCommentFromDiff(diff);
    if (extracted) {
      const maxLen = cfg.maxLength ?? 200;
      return { message: extracted.trim().slice(0, maxLen) };
    }
    // 2. 无注释或无关键词 → 调 AI（引导生成标志标题 + 截断长度）
    const prompt = buildPrompt(diff, req.prefix, cfg.maxLength ?? 200);
    let res: AiGenerateResponse;
    switch (cfg.provider) {
      case "vscode":
        res = await this.callVscodeLm(cfg.model, prompt);
        break;
      case "anthropic":
        res = await this.callAnthropic(cfg, prompt);
        break;
      case "openai":
        res = await this.callOpenAI(cfg, prompt);
        break;
    }
    return { message: res.message.trim() };
  }

  // ─── Provider implementations ──────────────────────────────────────────

  private async callVscodeLm(
    modelFamily: string,
    prompt: string,
  ): Promise<AiGenerateResponse> {
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

    // Prefer the requested family if specified; otherwise pick the first.
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
    try {
      const response = await model.sendRequest(messages, {}, tokenSource.token);
      let text = "";
      for await (const chunk of response.text) {
        text += String(chunk);
      }
      return { message: text.trim() };
    } finally {
      tokenSource.dispose();
    }
  }

  private async callAnthropic(
    cfg: AiConfig,
    prompt: string,
  ): Promise<AiGenerateResponse> {
    const apiKey = (await this.secrets.get(SECRET_KEY)) ?? "";
    if (!apiKey) {
      throw new Error(
        "No Anthropic API key configured. Open the AI settings to add one.",
      );
    }
    const baseUrl =
      cfg.baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL.anthropic;
    const url = `${baseUrl}/v1/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `Anthropic API ${resp.status} ${resp.statusText}: ${body.slice(0, 300)}`,
      );
    }
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new Error("Anthropic returned an empty response.");
    }
    return { message: text };
  }

  private async callOpenAI(
    cfg: AiConfig,
    prompt: string,
  ): Promise<AiGenerateResponse> {
    const apiKey = (await this.secrets.get(SECRET_KEY)) ?? "";
    if (!apiKey) {
      throw new Error(
        "No OpenAI API key configured. Open the AI settings to add one.",
      );
    }
    const baseUrl =
      cfg.baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL.openai;
    const url = `${baseUrl}/v1/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.4,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `OpenAI API ${resp.status} ${resp.statusText}: ${body.slice(0, 300)}`,
      );
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) {
      throw new Error("OpenAI returned an empty response.");
    }
    return { message: text };
  }
}

/** Assemble the Conventional-Commits prompt sent to every provider. */
function buildPrompt(rawDiff: string, prefix: string, maxLength = 200): string {
  const intro =
    "You write git commit messages in the Conventional Commits style. " +
    "If the change fixes a bug, start with 'fix:'; if it implements a feature/requirement, start with 'feat:'; " +
    "if it addresses a task, start with 'task:'. " +
    "Output ONLY the commit message text — no commentary, no markdown fences, no surrounding quotes. " +
    "Subject line should be ≤72 characters, imperative mood, no trailing period. " +
    `Keep the entire message under ${maxLength} characters (hard limit). ` +
    "Add a blank line + wrapped body (≤72 chars per line) only when it adds clarity. " +
    "Reply in the user's language when the diff/comments suggest one.";

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
