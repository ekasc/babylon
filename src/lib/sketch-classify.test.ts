import { describe, expect, it } from "vitest";
import { REGION_ROLES } from "./sketch-compile";
import {
  MAX_SKETCH_CROPS,
  answerText,
  buildRegionPrompt,
  imageFromDataUrl,
  parseRegionReading,
  readCropAnswer,
  readCrops,
} from "./sketch-classify";

describe("the classification prompt", () => {
  it("names every role so the answer vocabulary is closed", () => {
    const prompt = buildRegionPrompt();
    for (const role of REGION_ROLES) expect(prompt).toContain(`- ${role}:`);
  });

  it("asks for the fields the parser requires", () => {
    const prompt = buildRegionPrompt();
    expect(prompt).toContain('"role"');
    expect(prompt).toContain('"label"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain("answer unknown");
  });
});

describe("reading an answer", () => {
  it("accepts a plain object", () => {
    const parsed = parseRegionReading('{"role":"decision","label":"Paid?","confidence":0.9}');
    expect(parsed).toEqual({ ok: true, reading: { role: "decision", label: "Paid?", confidence: 0.9 } });
  });

  it("accepts one wrapped in a code fence", () => {
    const parsed = parseRegionReading('```json\n{"role":"process","label":"Cart","confidence":0.8}\n```');
    expect(parsed.ok && parsed.reading.label).toBe("Cart");
  });

  it("accepts one wrapped in prose", () => {
    const parsed = parseRegionReading('Sure, here it is:\n{"role":"data","label":"Store","confidence":1}\nHope that helps.');
    expect(parsed.ok && parsed.reading.role).toBe("data");
  });

  it("is not confused by braces inside the label", () => {
    const parsed = parseRegionReading('{"role":"note","label":"use {this} form","confidence":0.7}');
    expect(parsed.ok && parsed.reading.label).toBe("use {this} form");
  });

  it("normalises the role's case and spacing", () => {
    const parsed = parseRegionReading('{"role":"  Decision ","label":"","confidence":0.5}');
    expect(parsed.ok && parsed.reading.role).toBe("decision");
  });

  it("collapses whitespace in a label read from handwriting", () => {
    const parsed = parseRegionReading('{"role":"process","label":"  Enter\\n  the   code ","confidence":0.6}');
    expect(parsed.ok && parsed.reading.label).toBe("Enter the code");
  });

  it("treats a missing label as no text", () => {
    const parsed = parseRegionReading('{"role":"process","confidence":0.6}');
    expect(parsed.ok && parsed.reading.label).toBe("");
  });

  it("accepts a quoted confidence", () => {
    const parsed = parseRegionReading('{"role":"process","label":"A","confidence":"0.75"}');
    expect(parsed.ok && parsed.reading.confidence).toBe(0.75);
  });

  it("clamps a confidence outside the range", () => {
    expect(parseRegionReading('{"role":"process","confidence":4}')).toMatchObject({ ok: true });
    const high = parseRegionReading('{"role":"process","confidence":4}');
    const low = parseRegionReading('{"role":"process","confidence":-2}');
    expect(high.ok && high.reading.confidence).toBe(1);
    expect(low.ok && low.reading.confidence).toBe(0);
  });

  it("keeps unknown as a real answer", () => {
    const parsed = parseRegionReading('{"role":"unknown","label":"","confidence":0.95}');
    expect(parsed.ok && parsed.reading.role).toBe("unknown");
  });

  describe("rejects an answer it cannot enforce", () => {
    it("names the valid roles when the role is not one of them", () => {
      const parsed = parseRegionReading('{"role":"widget","label":"A","confidence":1}');
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.error).toContain("is not one of");
      expect(parsed.ok === false && parsed.error).toContain("decision");
    });

    it("rejects a missing role", () => {
      expect(parseRegionReading('{"label":"A","confidence":1}')).toMatchObject({ ok: false });
    });

    it("rejects a missing confidence rather than assuming one", () => {
      const parsed = parseRegionReading('{"role":"process","label":"A"}');
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.error).toBe("confidence is missing");
    });

    it("rejects a confidence that is not a number", () => {
      expect(parseRegionReading('{"role":"process","confidence":"quite sure"}')).toMatchObject({ ok: false });
    });

    it("rejects prose with no object", () => {
      expect(parseRegionReading("I think it is a decision.")).toMatchObject({ ok: false });
    });

    it("rejects an object that never closes", () => {
      expect(parseRegionReading('{"role":"process","label":"A"')).toMatchObject({ ok: false });
    });

    it("rejects a non-object answer", () => {
      expect(parseRegionReading('["process"]')).toMatchObject({ ok: false });
    });

    it("rejects malformed JSON", () => {
      expect(parseRegionReading('{"role": }')).toMatchObject({ ok: false });
    });
  });
});

describe("reading an answer out of a response", () => {
  it("takes the text blocks and ignores the rest", () => {
    expect(answerText({ content: [{ type: "text", text: "hello" }, { type: "reasoning", text: "thinking" }] })).toBe("hello");
  });

  it("joins several text blocks", () => {
    expect(answerText({ content: [{ type: "text", text: '{"role":' }, { type: "text", text: '"process"}' }] })).toBe('{"role":"process"}');
  });

  it("treats an error response as no answer", () => {
    // Observed live from Console Go: an error stop with empty content. Reading it
    // as an answer would turn a provider failure into a shape with no text in it.
    expect(
      answerText({
        role: "assistant",
        content: [],
        provider: "opencode-go",
        stopReason: "error",
        errorMessage: 'OpenAI API error (400): {"type":"MissingSessionID"}',
      })
    ).toBeNull();
  });

  it("treats empty or absent content as no answer", () => {
    expect(answerText({ content: [] })).toBeNull();
    expect(answerText({ content: [{ type: "text", text: "   " }] })).toBeNull();
    expect(answerText({})).toBeNull();
    expect(answerText(null)).toBeNull();
    expect(answerText("a string")).toBeNull();
  });
});

describe("preparing a crop for the model", () => {
  it("splits a rendered crop back into an image block", () => {
    expect(imageFromDataUrl("data:image/png;base64,AAAA")).toEqual({ mimeType: "image/png", data: "AAAA" });
    expect(imageFromDataUrl("data:image/jpeg;base64,/9j/4A==")).toEqual({ mimeType: "image/jpeg", data: "/9j/4A==" });
  });

  it("refuses anything that is not a base64 image", () => {
    expect(imageFromDataUrl("AAAA")).toBeNull();
    expect(imageFromDataUrl("data:image/png,AAAA")).toBeNull();
    expect(imageFromDataUrl(undefined)).toBeNull();
    expect(imageFromDataUrl({})).toBeNull();
  });
});

describe("turning a response into a reading", () => {
  it("returns the reading a good answer describes", () => {
    const answer = readCropAnswer({ content: [{ type: "text", text: '{"role":"terminator","label":"Done","confidence":0.7}' }] });
    expect(answer).toEqual({ ok: true, reading: { role: "terminator", label: "Done", confidence: 0.7 } });
  });

  it("gives a reason rather than a reading when there was no answer", () => {
    expect(readCropAnswer({ content: [], stopReason: "error" })).toEqual({
      ok: false,
      reason: "the model returned no answer",
    });
  });

  it("gives a reason that quotes what the model actually said", () => {
    const answer = readCropAnswer({ content: [{ type: "text", text: "It looks like a box to me." }] });
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toContain("no JSON object");
    expect(answer.ok === false && answer.reason).toContain("It looks like a box to me.");
  });

  it("gives a reason when the role is outside the vocabulary", () => {
    const answer = readCropAnswer({ content: [{ type: "text", text: '{"role":"widget","confidence":1}' }] });
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toContain("is not one of");
  });
});

describe("reading a set of crops", () => {
  const crop = (regionId: string, dataUrl = "data:image/png;base64,AAAA") => ({ regionId, dataUrl });

  it("keys readings by region, in drawing order", async () => {
    const seen: string[] = [];
    const result = await readCrops([crop("r1"), crop("r2")], async ({ image }) => {
      seen.push(image.data);
      return { content: [{ type: "text", text: `{"role":"process","label":"${image.data}","confidence":0.9}` }] };
    });

    expect(seen).toEqual(["AAAA", "AAAA"]);
    expect(Object.keys(result.readings)).toEqual(["r1", "r2"]);
    expect(result.problems).toEqual([]);
  });

  it("sends the prompt and the decoded crop", async () => {
    let sent: { prompt: string; image: { data: string; mimeType: string } } | null = null;
    await readCrops([crop("r1", "data:image/jpeg;base64,ZZZ")], async (request) => {
      sent = request;
      return { content: [{ type: "text", text: '{"role":"unknown","label":"","confidence":0}' }] };
    });

    expect(sent!.image).toEqual({ mimeType: "image/jpeg", data: "ZZZ" });
    expect(sent!.prompt).toContain('"confidence"');
  });

  it("never sends a crop it could not render", async () => {
    let calls = 0;
    const result = await readCrops([crop("r1", "not-an-image")], async () => {
      calls += 1;
      return { content: [] };
    });

    expect(calls).toBe(0);
    expect(result.problems).toEqual([{ regionId: "r1", reason: "the crop was not a base64 image" }]);
  });

  it("turns a failing call into a question and keeps going", async () => {
    const result = await readCrops(
      [crop("r1", "data:image/png;base64,AAAA"), crop("r2", "data:image/png;base64,BBBB")],
      async ({ image }) => {
        if (image.data === "AAAA") throw new Error("provider unavailable");
        return { content: [{ type: "text", text: '{"role":"note","label":"ok","confidence":0.9}' }] };
      }
    );

    // One shape failing to read must not cost the rest of the drawing.
    expect(result.problems).toEqual([{ regionId: "r1", reason: "provider unavailable" }]);
    expect(result.readings).toEqual({ r2: { role: "note", label: "ok", confidence: 0.9 } });
  });

  it("reports an answer it could not enforce", async () => {
    const result = await readCrops([crop("r1")], async () => ({ content: [], stopReason: "error" }));
    expect(result.readings).toEqual({});
    expect(result.problems).toEqual([{ regionId: "r1", reason: "the model returned no answer" }]);
  });

  it("says so when a drawing has more shapes than one compile reads", async () => {
    const many = Array.from({ length: MAX_SKETCH_CROPS + 2 }, (_, index) => crop(`r${index + 1}`));
    let calls = 0;
    const result = await readCrops(many, async () => {
      calls += 1;
      return { content: [{ type: "text", text: '{"role":"process","label":"x","confidence":1}' }] };
    });

    expect(calls).toBe(MAX_SKETCH_CROPS);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0].reason).toBe(`not read: a compile reads at most ${MAX_SKETCH_CROPS} shapes`);
  });
});
