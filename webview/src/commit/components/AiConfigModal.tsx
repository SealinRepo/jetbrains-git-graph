import { useCallback, useEffect, useState } from "react";
import type { AiConfig, AiProvider } from "../../../../shared/protocol";
import { useCommitStore } from "../../shared/store/commit-store";

interface Props {
  onClose: () => void;
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  vscode: "VS Code (Copilot)",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const PLACEHOLDER_BASE_URL: Record<AiProvider, string> = {
  vscode: "(built-in — no URL needed)",
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

const PLACEHOLDER_MODEL: Record<AiProvider, string> = {
  vscode: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
};

export function AiConfigModal({ onClose }: Props) {
  const { aiConfig, loadAiConfig, saveAiConfig } = useCommitStore();

  const [provider, setProvider] = useState<AiProvider>("vscode");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maxLength, setMaxLength] = useState(200);
  const [language, setLanguage] = useState<"en" | "zh">("en");
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load config lazily if not yet fetched.
  useEffect(() => {
    if (!aiConfig) {
      void loadAiConfig();
    }
  }, [aiConfig, loadAiConfig]);

  // Reflect current config into the form whenever it changes.
  useEffect(() => {
    if (aiConfig) {
      setProvider(aiConfig.provider);
      setBaseUrl(aiConfig.baseUrl);
      setModel(aiConfig.model);
      setMaxLength(aiConfig.maxLength ?? 200);
      setLanguage(aiConfig.language ?? "en");
      setApiKey("");
      setClearKey(false);
    }
  }, [aiConfig]);

  const isVscode = provider === "vscode";

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveAiConfig({
        provider,
        baseUrl,
        model,
        apiKey: apiKey.length > 0 ? apiKey : undefined,
        clearApiKey: clearKey,
        maxLength,
        language,
      });
      onClose();
    } catch {
      // Error toast already shown via the store's error handler; keep modal
      // open so the user can retry.
    } finally {
      setSaving(false);
    }
  };

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [handleEscape]);

  const showHasKeyHint = aiConfig?.hasApiKey && !clearKey;

  return (
    <div className="ai-config-overlay">
      <div
        className="ai-config-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI commit message settings"
      >
        <div className="ai-config-header">
          <h3>AI Commit Message</h3>
          <button
            type="button"
            className="ai-config-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="ai-config-section">
          <span className="ai-config-label">Provider</span>
          <div className="ai-config-radios">
            {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((p) => (
              <label key={p} className="ai-config-radio">
                <input
                  type="radio"
                  name="ai-provider"
                  value={p}
                  checked={provider === p}
                  onChange={() => {
                    setProvider(p);
                    // When switching providers, clear the typed-but-not-saved
                    // API key to avoid accidentally sending it to the wrong
                    // service. Stored key is preserved server-side.
                    setApiKey("");
                    setClearKey(false);
                  }}
                />
                {PROVIDER_LABELS[p]}
              </label>
            ))}
          </div>
        </div>

        <div className="ai-config-section">
          <label className="ai-config-label" htmlFor="ai-base-url">
            Base URL
          </label>
          <input
            id="ai-base-url"
            type="text"
            className="ai-config-input"
            value={baseUrl}
            disabled={isVscode}
            placeholder={PLACEHOLDER_BASE_URL[provider]}
            onChange={(e) => setBaseUrl(e.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="ai-config-section">
          <label className="ai-config-label" htmlFor="ai-model">
            Model
          </label>
          <input
            id="ai-model"
            type="text"
            className="ai-config-input"
            value={model}
            disabled={isVscode}
            placeholder={PLACEHOLDER_MODEL[provider]}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="ai-config-section">
          <label className="ai-config-label" htmlFor="ai-api-key">
            API Key
          </label>
          <input
            id="ai-api-key"
            type="password"
            className="ai-config-input"
            value={apiKey}
            disabled={isVscode}
            placeholder={
              isVscode
                ? "(not used)"
                : showHasKeyHint
                  ? "(stored — enter to replace)"
                  : ""
            }
            onChange={(e) => {
              setApiKey(e.target.value);
              if (clearKey) setClearKey(false);
            }}
            spellCheck={false}
            autoComplete="off"
          />
          {aiConfig?.provider === provider &&
            aiConfig?.hasApiKey &&
            !clearKey && (
              <button
                type="button"
                className="ai-config-clear"
                onClick={() => {
                  setClearKey(true);
                  setApiKey("");
                }}
              >
                Clear stored key
              </button>
            )}
        </div>

        <div className="ai-config-section">
          <label className="ai-config-label" htmlFor="ai-max-length">
            生成长度限制
          </label>
          <input
            id="ai-max-length"
            type="number"
            min={50}
            max={500}
            className="ai-config-input"
            value={maxLength}
            disabled={isVscode}
            onChange={(e) => setMaxLength(Number(e.target.value))}
          />
          <small style={{ opacity: 0.6, fontSize: 11 }}>
            默认 200 字符；AI 提示中已包含长度限制描述，生成时自动遵守
          </small>
        </div>

        <div className="ai-config-section">
          <label className="ai-config-label" htmlFor="ai-language">
            语言
          </label>
          <select
            id="ai-language"
            className="ai-config-input"
            value={language ?? "en"}
            onChange={(e) => setLanguage(e.target.value as "en" | "zh")}
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
        </div>

        <div className="ai-config-footer">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-config-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Reference imported types so the bundler keeps them.
export type { AiConfig };
