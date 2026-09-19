// Asking a model what one region is, and refusing to accept an answer that is
// not one. This is the "structured classification needs its own path" half of
// the pin: `completeSimple` exposes no response schema, so the schema is
// enforced here instead of trusted to the model.
//
// The parser is strict on purpose. A missing confidence is a rejected answer,
// not a default, because a default confidence would quietly turn "I could not
// tell" into a role the human never confirmed.

import { type RegionReading, type RegionRole, REGION_ROLES } from "./sketch-compile";

/**
 * Cap on crops per compile. A sketch is a handful of shapes; anything beyond this
 * is treated as unread, which asks the human rather than spending without bound.
 */
export const MAX_SKETCH_CROPS = 24;

/** One line per role, so the answer vocabulary is the same for every crop. */
export const REGION_ROLE_GUIDE: Record<RegionRole, string> = {
  process: "a step, screen, component or plain box in a flow",
  decision: "a branch, choice or condition, usually drawn as a diamond",
  terminator: "a start or end point, usually a rounded or pill shape",
  data: "stored data, a database, a file or an input",
  note: "an annotation or aside rather than a step in the flow",
  group: "a container or section holding other shapes",
  unknown: "you genuinely cannot tell",
};

export function buildRegionPrompt(): string {
  const roles = REGION_ROLES.map((role) => `- ${role}: ${REGION_ROLE_GUIDE[role]}`).join("\n");
  return (
    "The image is a crop of one shape from a hand-drawn sketch, drawn in ink.\n" +
    'Answer with a single JSON object and nothing else: {"role":"...","label":"...","confidence":0.0}\n' +
    `Roles:\n${roles}\n` +
    "Rules:\n" +
    "- label is the text written inside the shape, exactly as written. Use \"\" when the shape has no text.\n" +
    "- confidence is how sure you are of the role, from 0 to 1. It is required.\n" +
    "- If you cannot tell what the shape is, answer unknown. Never pick a role you do not believe."
  );
}

export type ReadingParse = { ok: true; reading: RegionReading } | { ok: false; error: string };

/** First balanced JSON object in the text, ignoring braces inside strings. */
function extractObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index++) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

export function parseRegionReading(raw: string): ReadingParse {
  const json = extractObject(raw);
  if (!json) return { ok: false, error: "the answer contained no JSON object" };

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: "the answer was not valid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "the answer was not a JSON object" };
  }

  const record = value as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
  if (!(REGION_ROLES as readonly string[]).includes(role)) {
    return { ok: false, error: `role ${JSON.stringify(record.role)} is not one of ${REGION_ROLES.join(", ")}` };
  }

  // A number is expected, but models often quote it.
  const confidence = typeof record.confidence === "number" ? record.confidence : Number(record.confidence);
  if (typeof record.confidence !== "number" && typeof record.confidence !== "string") {
    return { ok: false, error: "confidence is missing" };
  }
  if (!Number.isFinite(confidence)) return { ok: false, error: "confidence is not a number" };

  const label = typeof record.label === "string" ? record.label.replace(/\s+/g, " ").trim() : "";
  return {
    ok: true,
    reading: {
      role: role as RegionRole,
      label,
      confidence: Math.min(1, Math.max(0, confidence)),
    },
  };
}

/** Text of an assistant answer, or null when the call failed or said nothing. */
export function answerText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const record = response as Record<string, unknown>;
  // An error response carries no answer, and reading its empty content as one
  // would turn a provider failure into a shape with nothing written in it.
  if (record.stopReason === "error") return null;
  if (!Array.isArray(record.content)) return null;
  const text = record.content.map(blockText).join("").trim();
  return text || null;
}

function blockText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const record = block as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string" ? record.text : "";
}

/** Splits a rendered crop back into the image block a model call expects. */
export function imageFromDataUrl(dataUrl: unknown): { data: string; mimeType: string } | null {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

export type CropAnswer = { ok: true; reading: RegionReading } | { ok: false; reason: string };

/** One response in, one reading or one reason out. Never invents a reading. */
export function readCropAnswer(response: unknown): CropAnswer {
  const text = answerText(response);
  if (text === null) return { ok: false, reason: "the model returned no answer" };
  const parsed = parseRegionReading(text);
  if (!parsed.ok) return { ok: false, reason: `${parsed.error}; answer was: ${text.slice(0, 120)}` };
  return { ok: true, reading: parsed.reading };
}

export type RegionCropRequest = { regionId: string; dataUrl: string };

/** The transport seam: one crop in, one raw model response out. */
export type CropCompleter = (request: {
  prompt: string;
  image: { data: string; mimeType: string };
}) => Promise<unknown>;

export type CropProblem = { regionId: string; reason: string };

/**
 * Reads every crop, one closed question each, in order. Nothing here invents a
 * reading: a crop that cannot be sent, or an answer that cannot be enforced,
 * comes back as a problem so the region reaches a human as a question.
 *
 * Sequential on purpose. Each crop is a paid call, so the cost of a compile is
 * predictable from the drawing rather than from how many requests race.
 */
export async function readCrops(
  crops: RegionCropRequest[],
  complete: CropCompleter
): Promise<{ readings: Record<string, RegionReading>; problems: CropProblem[] }> {
  const readings: Record<string, RegionReading> = {};
  const problems: CropProblem[] = [];
  const asked = crops.slice(0, MAX_SKETCH_CROPS);
  for (const crop of asked) {
    const image = imageFromDataUrl(crop.dataUrl);
    if (!image) {
      // An unrenderable crop is never sent.
      problems.push({ regionId: crop.regionId, reason: "the crop was not a base64 image" });
      continue;
    }
    try {
      const answer = readCropAnswer(await complete({ prompt: buildRegionPrompt(), image }));
      if (answer.ok) readings[crop.regionId] = answer.reading;
      else problems.push({ regionId: crop.regionId, reason: answer.reason });
    } catch (error) {
      problems.push({ regionId: crop.regionId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  // Dropping the rest silently would lose shapes from the drawing without saying so.
  for (const crop of crops.slice(MAX_SKETCH_CROPS)) {
    problems.push({
      regionId: crop.regionId,
      reason: `not read: a compile reads at most ${MAX_SKETCH_CROPS} shapes`,
    });
  }
  return { readings, problems };
}
