import { z } from "zod";
import { digestPage } from "../../src/agents/web/digest.ts";
import { Churn, diffViews } from "../../src/agents/web/effect.ts";
import { WebObservationSchema as view } from "../../src/agents/web/view.ts";

const counts = z.record(z.string(), z.int().nonnegative());
const state = z.object({ page: z.tuple([z.string(), z.string()]).nullable(), counts, widths: counts });
type Invoke = (args: Record<string, unknown>) => unknown;

export const webViewImplementations = new Map<string, Invoke>([
  ["agents.web.digest.digest_page", args => digestPage(view.parse(args.view))],
  ["agents.web.effect.diff_views", args => {
    const input = z.object({ before: view, after: view, ref: z.string().nullable(), volatile: counts.nullable() }).parse(args);
    return diffViews(input.before, input.after, input.ref ?? undefined, input.volatile ?? undefined);
  }],
  ["agents.web.effect.Churn.observe", args => {
    const input = z.object({ state, view, idle: z.boolean(), idle_prev: view.nullable() }).parse(args);
    if (input.idle !== (input.idle_prev !== null)) throw new Error("Inconsistent recorded idle gap");
    const churn = new Churn({ ...input.state, page: input.state.page ?? undefined });
    churn.observe(input.view, input.idle_prev ?? undefined);
    return { state: churn.snapshot(), volatile: churn.volatile() };
  }],
]);
