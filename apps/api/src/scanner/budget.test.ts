import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DAILY_TOKEN_CAP,
  LlmBudget,
  LlmBudgetExceeded,
  createMemoryUsageStore,
  dailyTokenCapFromEnv,
} from "./budget.js";

// A Messages API response as the SDK returns it (shape from the API reference:
// content blocks plus usage.input_tokens / usage.output_tokens).
const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: h.create };
  },
}));
const { classify } = await import("./classify.js");

function messageResponse(text: string, input_tokens: number, output_tokens: number) {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens, output_tokens },
  };
}

const day = (iso: string) => () => new Date(iso);

describe("LlmBudget", () => {
  it("allows calls up to the cap and refuses the one that would pass it", async () => {
    const budget = new LlmBudget(1000, createMemoryUsageStore(), day("2026-11-14T10:00:00Z"));
    await budget.assertRoomFor(400);
    await budget.record(900);
    await expect(budget.assertRoomFor(100)).resolves.toBeUndefined();
    const err = await budget.assertRoomFor(101).catch((e) => e);
    expect(err).toBeInstanceOf(LlmBudgetExceeded);
    expect(err.message).toMatch(/2026-11-14 is spent \(900 of 1000 tokens\).*SCANNER_LLM_DAILY_TOKENS/);
  });

  it("starts again on the next UTC day", async () => {
    const store = createMemoryUsageStore();
    await new LlmBudget(1000, store, day("2026-11-14T23:59:00Z")).record(1000);
    await expect(new LlmBudget(1000, store, day("2026-11-14T23:59:30Z")).assertRoomFor(1)).rejects.toBeInstanceOf(LlmBudgetExceeded);
    await expect(new LlmBudget(1000, store, day("2026-11-15T00:00:01Z")).assertRoomFor(1)).resolves.toBeUndefined();
  });
});

describe("dailyTokenCapFromEnv", () => {
  it("defaults when unset and refuses a value that is not a positive whole number", () => {
    expect(dailyTokenCapFromEnv(undefined)).toBe(DEFAULT_DAILY_TOKEN_CAP);
    expect(dailyTokenCapFromEnv("50000")).toBe(50000);
    for (const bad of ["0", "-5", "1.5", "lots"]) expect(() => dailyTokenCapFromEnv(bad)).toThrow(/positive whole number/);
  });
});

describe("classify under a budget", () => {
  beforeEach(() => h.create.mockReset());

  it("records the tokens the response says it used", async () => {
    h.create.mockResolvedValue(messageResponse('{"classification":"billing_pain","confidence":"high"}', 180, 12));
    const budget = new LlmBudget(10_000);
    expect(await classify("Our Vercel bill tripled", "egress fees again", budget)).toEqual({
      classification: "billing_pain",
      confidence: "high",
    });
    expect(await budget.usedToday()).toBe(192);
  });

  it("refuses before calling the model once the day's budget is spent, and does not swallow the refusal", async () => {
    const budget = new LlmBudget(300);
    await budget.record(290);
    await expect(classify("title", "body", budget)).rejects.toBeInstanceOf(LlmBudgetExceeded);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("still reads an answer it cannot parse as irrelevant, and still counts its tokens", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.create.mockResolvedValue(messageResponse("I think this is about billing.", 150, 9));
    const budget = new LlmBudget(10_000);
    await expect(classify("t", "b", budget)).resolves.toEqual({ classification: "irrelevant", confidence: "low" });
    expect(await budget.usedToday()).toBe(159);
  });
});
