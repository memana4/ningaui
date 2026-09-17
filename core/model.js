// Model adapters. Two, deliberately:
//   nano   — Chrome's built-in Prompt API (Gemini Nano). On-device, no key, no network.
//   openai — any OpenAI-compatible /chat/completions endpoint: local Ollama or llama.cpp,
//            or a private hosted model. The key never leaves chrome.storage.local.
//
// Both go through the same complete(messages) -> string contract, so the loop is
// model-agnostic and a test can substitute a scripted model.

export function createNanoModel({ LanguageModel, systemPrompt }) {
  let session = null;
  return {
    name: "nano",
    async complete(messages) {
      if (!LanguageModel) throw new Error("Chrome Prompt API unavailable on this device");
      if (!session) {
        session = await LanguageModel.create({ systemPrompt: messages[0].content });
      }
      const turns = messages.slice(1).map((m) => (m.role === "assistant" ? `ASSISTANT: ${m.content}` : m.content));
      return await session.prompt(turns.join("\n\n"));
    },
  };
}

export function createOpenAIModel({ fetchImpl, baseUrl, apiKey, model, temperature = 0, maxTokens = 800 }) {
  return {
    name: `openai:${model}`,
    async complete(messages) {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      });
      if (!res.ok) throw new Error(`model endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      const text = choice && (choice.message?.content ?? choice.text);
      if (typeof text !== "string") throw new Error("model endpoint returned no text");
      return text;
    },
  };
}

export async function pickModel({ config, fetchImpl, LanguageModel }) {
  if (config.backend === "openai" && config.baseUrl && config.model) {
    return createOpenAIModel({ fetchImpl, ...config });
  }
  if (config.backend === "nano" || (!config.baseUrl && LanguageModel)) {
    return createNanoModel({ LanguageModel, systemPrompt: "" });
  }
  throw new Error("no model available: configure an OpenAI-compatible endpoint or use Chrome's built-in model");
}
