import { z } from "zod";
import { tryUrl } from "./url.ts";
import type { Action } from "./actions.ts";

/** 화면에서 관찰한 누르기 순서. ref와 주소의 검색값은 기억한 경로에 넣지 않는다. */
export interface PlanStep { page: string; kind: "click"; role: string; name: string }
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
export const RememberedRouteSchema = z.object({
  goalKey: digest, site: z.string(), endPage: z.string(),
  steps: z.array(z.object({page: z.string(), kind: z.literal("click"), role: z.string(), name: z.string()})).min(1).max(10),
  evidence: z.array(digest).min(1).max(4),
});
export type RememberedRoute = z.infer<typeof RememberedRouteSchema>;
export interface PlanGrant { id: string; goal: string; steps: readonly PlanStep[]; cursor: number }

export function planPage(value: string | undefined): string | undefined {
  const url = tryUrl(value);
  return url !== undefined && ["http:", "https:"].includes(url.protocol) ? url.origin + url.pathname : undefined;
}

/** 지금 승인된 순서 중 조작 하나에만 발행한다. 시간·중단·순서 검사와 한 번 쓰는 권한은 발행한 객체에만 연결된다. */
export interface PlanBinding {
  readonly step: Readonly<PlanStep>;
  readonly actionId: string;
  readonly ref: string;
  readonly url: string;
  readonly signature: string;
}
const active = new WeakMap<PlanBinding, () => boolean>();

export function bindPlanClick(step: PlanStep, actionId: string, ref: string, url: string, signature: string, current: () => boolean): PlanBinding {
  const binding = Object.freeze({ step: Object.freeze({ ...step }), actionId, ref, url, signature });
  active.set(binding, current);
  return binding;
}

export function boundPlanClick(binding: PlanBinding, action: Action, url: string | undefined): boolean {
  const target = action.target;
  return active.get(binding)?.() === true && binding.url === url && binding.step.page === planPage(url) &&
    binding.signature.length > 0 && binding.actionId === action.id && binding.step.kind === action.type && action.type === "click" &&
    target !== undefined && Object.keys(target).length === 3 && target.ref === binding.ref && target.role === binding.step.role &&
    target.name === binding.step.name && action.risk === "low" && !action.requiresConfirmation;
}

export function revokePlanClick(binding: PlanBinding) { active.delete(binding); }
