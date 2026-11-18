import { z } from "zod";
import { ActionSchema } from "../../src/core/actions.ts";
import { fingerprint } from "../../src/agents/web/approval.ts";
import { authPageKind } from "../../src/agents/web/auth_page.ts";
import { WebObservationSchema } from "../../src/agents/web/view.ts";

const action = ActionSchema.in.pick({ type: true, target: true, value: true }).strip();
export const webPolicyImplementations = new Map<string, (args: Record<string, unknown>) => unknown>([
  ["agents.web.auth_page.auth_page_kind", args => authPageKind(WebObservationSchema.parse(args.view))],
  ["agents.web.approval.fingerprint", args => fingerprint(
    WebObservationSchema.parse(args.view), z.array(action).parse(args.actions), z.string().parse(args.speech),
    z.array(z.string()).nullable().parse(args.field_ids) ?? undefined,
  )],
]);
