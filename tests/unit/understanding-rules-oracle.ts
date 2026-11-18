import { z } from "zod";
import { cleanValue, isProgressQuestion, isStopUtterance, RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { isQuestionLike, shortReplyKind, splitQuestions, stripAddress, stripFiller, vagueQuestion } from "../../src/understanding/filters.ts";
import { mentionsKnownSite, nearSite, resolveSite, siteLabel, siteNameFrom } from "../../src/understanding/sites.ts";
import { fixtureText } from "./redacted-fixture.ts";

type Args = Record<string, unknown>;
type Invoke = (args: Args) => unknown;
const strings = z.array(z.string());
const parseArgs = z.object({
  input_: z.string(), vocabulary: strings,
  ctx: z.object({ state: z.string(), awaitingFieldId: z.string().nullish() }),
});
const sites = z.array(z.object({
  names: strings, label: z.string(), url: z.string(), about: z.string().nullish(),
})).transform(rows => rows.map(row => ({ ...row, about: row.about ?? undefined })));
const recordedQuestions = z.object({
  text: z.string(), recent: strings,
  signal: z.object({ aborted: z.boolean() }).nullable(),
  llm: z.array(z.object({ schemaName: z.string(), response: z.unknown() })).nullable(),
});

async function replayQuestions(args: Args) {
  const { text, recent, signal, llm } = recordedQuestions.parse(args);
  const calls = llm?.values();
  const provider = calls === undefined ? undefined : {
    name: "recording",
    async generate(request: { schemaName: string }) {
      const call = calls.next();
      if (call.done === true || call.value.schemaName !== request.schemaName) {
        throw new Error("split_questions 모델 호출이 기록과 다름");
      }
      return call.value.response;
    },
  };
  const result = await splitQuestions(provider, fixtureText(text), recent.map(fixtureText),
    signal?.aborted === true ? AbortSignal.abort() : undefined);
  if (calls !== undefined && calls.next().done !== true) throw new Error("기록된 질문 분리 호출 누락");
  return result;
}

export const ruleImplementations = new Map<string, Invoke>([
  ["understanding.rules.RuleBasedIntentProvider.parse_sync", args => {
    const { ctx, vocabulary, input_ } = parseArgs.parse(args);
    return new RuleBasedIntentProvider(vocabulary).parseSync(input_, {
      state: ctx.state, awaitingFieldId: ctx.awaitingFieldId ?? undefined,
    });
  }],
  ["understanding.rules.RuleBasedIntentProvider.split_commands", args =>
    new RuleBasedIntentProvider(strings.parse(args.vocabulary)).splitCommands(z.string().parse(args.input_))],
  ["understanding.rules.clean_value", args => cleanValue(z.string().parse(args.raw))],
  ["understanding.rules.is_stop_utterance", args => isStopUtterance(z.string().parse(args.text))],
  ["understanding.rules.is_progress_question", args => isProgressQuestion(z.string().parse(args.text))],
  ["understanding.filters.split_questions", replayQuestions],
  ["understanding.filters.short_reply_kind", args => shortReplyKind(z.string().parse(args.text)) ?? null],
  ["understanding.filters.strip_address", args => stripAddress(z.string().parse(args.text))],
  ["understanding.filters.strip_filler", args => stripFiller(z.string().parse(args.text))],
  ["understanding.filters.is_question_like", args => isQuestionLike(z.string().parse(args.t))],
  ["understanding.filters.vague_question", args => vagueQuestion(z.string().parse(args.text)) ?? null],
  ["understanding.sites.mentions_known_site", args => mentionsKnownSite(z.string().parse(args.text))],
  ["understanding.sites.site_name_from", args => siteNameFrom(z.string().parse(args.text))],
  ["understanding.sites.near_site", args => {
    const site = nearSite(z.string().parse(args.text), sites.parse(args.extra));
    return site === undefined ? null : { ...site, about: site.about ?? null };
  }],
  ["understanding.sites.resolve_site", args => resolveSite(z.string().parse(args.target), sites.parse(args.extra)) ?? null],
  ["understanding.sites.site_label", args => siteLabel(z.string().parse(args.url), sites.parse(args.extra))],
]);
