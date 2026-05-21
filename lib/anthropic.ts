import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function anthropic() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  _client = new Anthropic({ apiKey });
  return _client;
}

// Use the latest Claude Haiku for review categorization, fast, cheap, plenty good for this task.
export const REVIEW_MODEL = "claude-haiku-4-5-20251001";
