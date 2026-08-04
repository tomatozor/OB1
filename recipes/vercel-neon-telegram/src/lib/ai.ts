import { embed, generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { metadataSchema, type ThoughtMetadata } from "./types";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  name: "openrouter",
});
const classifierModel = process.env.OPENROUTER_CLASSIFIER_MODEL ??
  "deepseek/deepseek-v4-pro";

export async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: text,
  });
  return embedding;
}

export async function extractMetadata(
  content: string,
): Promise<ThoughtMetadata> {
  const { object } = await generateObject({
    model: openrouter(classifierModel),
    schema: metadataSchema,
    prompt: `Extract structured metadata from this thought. Be concise.

Thought: "${content}"

Rules:
- people: extract full names mentioned
- action_items: implied tasks or things to do
- dates_mentioned: in YYYY-MM-DD format
- topics: 1-3 short category tags
- type: classify as observation, task, idea, reference, person_note, decision, or meeting_note`,
  });
  return object;
}
