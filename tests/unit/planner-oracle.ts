import { z } from "zod";
import { chatRoute } from "../../src/understanding/chat.ts";
import { FakeLlm } from "../helpers.ts";
import { fixtureText } from "./redacted-fixture.ts";

const chat = z.object({
  llm: z.array(z.object({ schemaName: z.literal("chat_route"), response: z.unknown() })).length(1),
  text: z.string(), page: z.string().nullable(), last_assistant: z.string().nullable(),
  recent: z.array(z.string()), asked_just_now: z.boolean(),
});

export const plannerImplementations = new Map<string, (args: Record<string, unknown>) => unknown>([
  ["understanding.chat.chat_route", (inputs) => {
    const args = chat.parse(inputs);
    const [call] = args.llm;
    if (call === undefined) throw new Error("missing recorded chat call");
    const llm = new FakeLlm({ [call.schemaName]: call.response });
    return chatRoute(llm, fixtureText(args.text), {
      page: args.page === null ? undefined : fixtureText(args.page),
      lastAssistant: args.last_assistant === null ? undefined : fixtureText(args.last_assistant),
      askedJustNow: args.asked_just_now, recent: args.recent.map(fixtureText),
    });
  }],
]);
