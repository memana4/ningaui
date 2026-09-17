// One agent loop. No planner, no subagents, no orchestrator.
//
// Protocol: the model replies with exactly one JSON object per turn, either
//   {"tool":"name","args":{...}}   or   {"final":"text"}
// Tolerant parsing is deliberate: small local models wrap JSON in prose and
// code fences, so we extract the first balanced object and never trust the wrapper.

import { createTools } from "./tools.js";

export const DEFAULT_LIMITS = { maxSteps: 12, maxMs: 120_000, maxToolMs: 20_000 };

export function buildSystemPrompt({ tools, limits, persona }) {
  return [
    persona || "You are a small agent whose job is API work: read state, change state, keep notes.",
    "",
    "You work in steps. In every step you reply with ONE JSON object and nothing else.",
    'To use a tool:  {"tool":"api_read","args":{"url":"http://api/state"}}',
    'To finish:      {"final":"what you did, in one or two sentences"}',
    "",
    "Tools:",
    tools.spec(),
    "",
    "HOW ACTIONS HAPPEN: api_request is routed by policy, not by you.",
    "- If the policy for that class of action is 'auto', it applies immediately and you get the",
    "  response back in the same step. Those are logged and can be reverted.",
    "- If it is 'confirm', it queues with your rationale and a preview, and a human approves or",
    "  declines it, sometimes long after your run ends. Nothing has been sent yet.",
    "- If it is 'deny', it is refused outright. Do not try to route around it.",
    "Always give a real rationale: it is what the human reads when deciding.",
    "Call list_actions at the start of a run. A declined action tells you what the human did not",
    "want and why; an applied action tells you what the policy already trusts you with.",
    "Use remember/recall freely for your own notes — that is your sandbox, not the world.",
    "",
    `Limits: at most ${limits.maxSteps} steps. Ask for one tool per step.`,
    "Never invent tool results. If a tool errors, read the error and decide what to do next.",
    "Do not explain before acting: the JSON object is your entire reply.",
  ].join("\n");
}

// Extract the first balanced JSON object from arbitrary model text.
export function parseStep(text) {
  if (typeof text !== "string") throw new Error("empty model reply");
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("no JSON object in reply");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const obj = JSON.parse(cleaned.slice(start, i + 1));
        if (typeof obj.final === "string") return { kind: "final", text: obj.final };
        if (typeof obj.tool === "string") return { kind: "tool", name: obj.tool, args: obj.args || {} };
        throw new Error("JSON object has neither tool nor final");
      }
    }
  }
  throw new Error("unbalanced JSON in reply");
}

export async function runAgent({
  task, model, store, actions = null, policy = null, fetchImpl, isAllowed, persona,
  limits = DEFAULT_LIMITS, clock = () => Date.now(),
  onEvent = () => {},
  runId = `run-${Date.now().toString(36)}`,
}) {
  const tools = createTools({ store, actions, policy, fetchImpl, isAllowed, clock, runId });
  const messages = [
    { role: "system", content: buildSystemPrompt({ tools, limits, persona }) },
    { role: "user", content: task },
  ];
  const started = clock();
  let steps = 0;

  const emit = async (type, data) => {
    await store.journal(runId, { type, ...data });
    onEvent({ type, runId, ...data });
  };
  if (policy && policy.beginRun) policy.beginRun();
  await emit("start", { task });

  while (steps < limits.maxSteps) {
    if (clock() - started > limits.maxMs) {
      await emit("stop", { reason: "time budget" });
      return { runId, status: "timeout", steps, messages };
    }
    steps++;

    let reply;
    try {
      reply = await model.complete(messages);
    } catch (err) {
      await emit("model_error", { error: String(err && err.message || err) });
      return { runId, status: "model_error", steps, error: String(err), messages };
    }
    messages.push({ role: "assistant", content: reply });

    let step;
    try {
      step = parseStep(reply);
    } catch (err) {
      // One correction attempt, then stop. Small models loop forever otherwise.
      messages.push({
        role: "user",
        content: `Your reply was not a JSON object (${err.message}). Reply with exactly one JSON object: {"tool":...} or {"final":...}`,
      });
      await emit("parse_error", { error: err.message, reply: reply.slice(0, 400) });
      continue;
    }

    if (step.kind === "final") {
      await emit("final", { text: step.text, steps });
      return { runId, status: "ok", steps, result: step.text, messages };
    }

    await emit("tool_call", { name: step.name, args: step.args });
    let outcome;
    let guard = clock();
    try {
      outcome = await tools.run(step.name, step.args);
      if (clock() - guard > limits.maxToolMs) throw new Error("tool exceeded its time budget");
    } catch (err) {
      outcome = { result: { error: String(err && err.message || err) }, ms: clock() - guard };
    }
    await emit("tool_result", { name: step.name, ms: outcome.ms, result: outcome.result });

    if (outcome.result && outcome.result.finished) {
      await emit("final", { text: outcome.result.summary, steps });
      return { runId, status: "ok", steps, result: outcome.result.summary, messages };
    }

    messages.push({ role: "user", content: `TOOL ${step.name} -> ${JSON.stringify(outcome.result)}` });
  }

  await emit("stop", { reason: "step budget" });
  return { runId, status: "max_steps", steps, messages };
}
