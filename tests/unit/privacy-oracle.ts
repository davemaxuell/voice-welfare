import { z } from "zod";
import { detectSensitive, redactText } from "../../src/safety/privacy.ts";

type Invoke = (args: Record<string, unknown>) => unknown;
export const privacyImplementations = new Map<string, Invoke>([
  ["safety.privacy.detect_sensitive", args => {
    const input = z.object({ text: z.string(), model: z.literal(false) }).parse(args);
    return detectSensitive(input.text);
  }],
  ["safety.privacy.redact_text", args => redactText(z.string().parse(args.text))],
]);
