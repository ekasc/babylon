import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function createAskQuestionTool(): ToolDefinition<any, any> {
  return {
    name: "ask_question",
    label: "Ask Question",
    description:
      "Ask the user a question and wait for their answer. You MUST use this tool (not just write the question in chat) when you need clarification, a choice, or confirmation before proceeding. The tool shows a blocking dialog with your question and options, waits for the user to answer, and returns their answer. Always use this tool instead of writing the question directly in your response.",
    promptSnippet: "Ask the user for clarification via the ask_question tool — never just write the question in chat",
    promptGuidelines: [
      "You MUST call ask_question when you need input to continue — do not just write the question in your response.",
      "Keep the question short and specific. Provide options when the answer is a choice.",
      "Example: ask_question({ question: \"Deploy to staging or prod?\", options: [\"staging\", \"prod\"] })",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1, description: "The question to ask the user" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of options for the user to choose from. When provided, a picker is shown.",
        },
        placeholder: { type: "string", description: "Placeholder for free-text input when no options are given" },
      },
    } as any,
    execute: async (_toolCallId, raw, _signal, onUpdate, ctx: any) => {
      console.log("[Babylon] ask_question called", JSON.stringify(raw).slice(0, 500));
      const question = String((raw as any)?.question ?? "").trim();
      if (!question) throw new Error("ask_question: question is required");
      const rawOptions = (raw as any)?.options;
      const options: string[] | null =
        Array.isArray(rawOptions) && rawOptions.length ? rawOptions.map((o: any) => String(o)).filter(Boolean) : null;
      const placeholder = typeof (raw as any)?.placeholder === "string" ? (raw as any).placeholder : undefined;

      // Surface a lightweight progress hint while the user is deciding.
      onUpdate?.({
        content: [{ type: "text", text: `Waiting for user answer: ${question}` }],
        details: { question, options: options ?? undefined, waiting: true },
      });

      let answer: string | undefined;
      try {
        if (options && options.length) {
          answer = await ctx.ui.select(question, options);
        } else {
          answer = await ctx.ui.input(question, { placeholder });
        }
      } catch (e) {
        throw new Error(`ask_question cancelled: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (answer === undefined || (typeof answer === "string" && !answer.trim() && !options)) {
        // `select` returns undefined on cancel, `input` also on cancel
        throw new Error("ask_question: user cancelled");
      }

      const text = String(answer).trim();
      return {
        content: [{ type: "text", text: `User answered: ${text}` }],
        details: { answer: text, question, options: options ?? undefined },
      };
    },
  } as ToolDefinition<any, any>;
}
