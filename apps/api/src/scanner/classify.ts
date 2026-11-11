import Anthropic from "@anthropic-ai/sdk";
import { HTTP_TIMEOUTS_MS } from "../lib/http.js";

// The SDK's default timeout is ten minutes; a classification is 60 tokens.
const client = new Anthropic({ timeout: HTTP_TIMEOUTS_MS.llm, maxRetries: 2 });

const SYSTEM_PROMPT = `You classify developer community posts for a cloud infrastructure migration platform called infralift.

Classify each post as exactly one of:
- billing_pain: complaints about cloud costs, surprise bills, egress fees, per-seat pricing, usage overages
- migration_interest: asking about alternatives, considering migration, evaluating new platforms, "moved from X to Y"
- platform_complaint: reliability issues, support problems, feature gaps, vendor lock-in, stagnation concerns
- irrelevant: not related to cloud hosting costs, migrations, or platform complaints

Respond with ONLY valid JSON on a single line: {"classification":"...","confidence":"high|medium|low"}`;

export interface Classification {
  classification: "billing_pain" | "migration_interest" | "platform_complaint" | "irrelevant";
  confidence: "high" | "medium" | "low";
}

export async function classify(
  title: string,
  body: string
): Promise<Classification> {
  const truncatedBody = body.slice(0, 500);
  const prompt = `Post title: ${title}\nPost body: ${truncatedBody}`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = JSON.parse(text.trim());

    const validClassifications = [
      "billing_pain",
      "migration_interest",
      "platform_complaint",
      "irrelevant",
    ];
    const validConfidences = ["high", "medium", "low"];

    if (
      validClassifications.includes(parsed.classification) &&
      validConfidences.includes(parsed.confidence)
    ) {
      return parsed as Classification;
    }

    return { classification: "irrelevant", confidence: "low" };
  } catch (err) {
    console.warn(`Classification failed: ${err}`);
    return { classification: "irrelevant", confidence: "low" };
  }
}
