import { z } from "zod";
import { ActionTypeSchema } from "../../src/core/actions.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { checkGrounding, quoteInSource, unsupportedNumbers } from "../../src/safety/verify.ts";

const strings = z.array(z.string());
const config = z.object({
  allowedOrigins: strings, allowedActionTypes: z.array(ActionTypeSchema),
  allowedFieldIds: strings, secretFieldIds: strings, maxActionsPerTurn: z.number(),
  readOnlyWeb: z.boolean(), safeButtons: strings, readOnlyClicks: z.enum(["any", "safe"]),
  publicLookupOnly: z.boolean(), defaultActionsPerTurn: z.number().nullable().transform(value => value ?? undefined),
});
const context = z.object({
  approvals: strings, currentUrl: z.string().nullable(), stopped: z.boolean(), actionsThisTurn: z.number(),
  public_lookup: z.boolean(), action_limit: z.number().nullable(),
});

export const policyImplementations = new Map<string, (args: Record<string, unknown>) => unknown>([
  ["safety.guard.PolicyGuard.check", args => {
    const guard = new PolicyGuard(config.parse(args.config));
    const { public_lookup: publicLookup, action_limit: actionLimit, ...ctx } = context.parse(args.ctx);
    return guard.check(args.candidate, {
      ...ctx, currentUrl: ctx.currentUrl ?? undefined, approvals: new Set(ctx.approvals), publicLookup, actionLimit: actionLimit ?? undefined,
    });
  }],
  ["safety.verify.quote_in_source", args => quoteInSource(z.string().parse(args.quote), z.string().parse(args.source))],
  ["safety.verify.unsupported_numbers", args => unsupportedNumbers(z.string().parse(args.answer), strings.parse(args.sources))],
  ["safety.verify.check_grounding", args => checkGrounding({
    answer: z.string().parse(args.answer), sources: strings.parse(args.sources), minQuotes: z.number().parse(args.min_quotes),
    quotes: strings.nullable().parse(args.quotes) ?? [], allowed: strings.nullable().parse(args.allowed) ?? [],
  })],
]);
