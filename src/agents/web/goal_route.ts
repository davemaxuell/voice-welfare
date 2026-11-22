import { routePage, routeDigest, cleanRouteText, safeRouteStep } from "../../safety/route_metadata.ts";
import type { PlanStep, RememberedRoute } from "../../core/plan.ts";
import { verifiedClick, type PageView, type WebOutcome } from "./agent.ts";
import { accessBlocked, stillNeedsAuth } from "./auth_page.ts";

export interface RouteStore {
  rememberedRoute(site: string, goalKey: string): RememberedRoute | undefined;
  saveRoute(route: RememberedRoute, eligible: (route: RememberedRoute, values: readonly string[]) => boolean): void;
}
export function routeView(view: PageView | undefined, privateValues: readonly string[]): string | undefined {
  if (!view || view.pageId === "blank" || view.pageId === "mock-welfare" || stillNeedsAuth(view) || accessBlocked(view) ||
      view.dialogs.length > 0 || view.fields.some(field => field.type === "password" || field.filled)) return undefined;
  return routePage(view.url, privateValues);
}
export function routeItem(view: PageView, step: PlanStep, privateValues: readonly string[]) {
  if (routeView(view, privateValues) !== step.page || !safeRouteStep(step, privateValues)) return undefined;
  const matches = view.outline?.items?.filter(item => !item.disabled && item.name === step.name);
  const item = matches?.[0];
  return matches?.length === 1 && item?.role === step.role && item.pictureMasked !== true && item.dialog === undefined ? item : undefined;
}
function evidenceRows(view: PageView) {
  return (view.outline?.mainText ?? "").slice(0, 24000).split(/\n/u).map(text => text.trim()).filter(text => text.length >= 2 && text.length <= 400);
}
export function routeAnswer(route: RememberedRoute, view: PageView, privateValues: readonly string[]): string[] | undefined {
  if (routeView(view, privateValues) !== route.endPage) return undefined;
  const rows = new Map(evidenceRows(view).filter(row => cleanRouteText(row, privateValues)).map(row => [routeDigest(row), row]));
  const current = route.evidence.flatMap(key => rows.get(key) ?? []);
  return current.length > 0 && current.length === route.evidence.length ? current : undefined;
}

/** 저장 후보는 목표가 끝날 때까지 메모리에만 둔다. 승인 대기도 같은 후보에 관찰된 클릭 한 번만 보탠다. */
export class RouteLearning {
  readonly steps: PlanStep[] = [];
  eligible = true;
  pendingApprovalId?: string;
  readonly goalKey: string;
  readonly privateValues: readonly string[];
  constructor(goalKey: string, privateValues: readonly string[]) { this.goalKey = goalKey; this.privateValues = privateValues; }
  click(before: PageView | undefined, out: WebOutcome) {
    const [row] = out.actions;
    const page = routeView(before, this.privateValues);
    const target = row?.action.target;
    if (page === undefined || !before || !out.view || routeView(out.view, this.privateValues) === undefined ||
        out.status !== "ok" || (out.effect !== "changed" && out.effect !== "moved") || out.native || out.question || (out.manual?.length ?? 0) > 0 ||
        out.actions.length !== 1 || !row || !verifiedClick(row) ||
        (this.pendingApprovalId !== undefined && this.pendingApprovalId !== row.action.id) ||
        target?.role === undefined || target.name === undefined || target.ref === undefined || this.steps.length >= 10) { this.eligible = false; return; }
    const step = {page, kind: "click" as const, role: target.role, name: target.name};
    if (routeItem(before, step, this.privateValues)?.ref !== target.ref ||
        new URL(out.view.url).origin !== new URL(page).origin) { this.eligible = false; return; }
    this.steps.push(step);
    this.pendingApprovalId = undefined;
  }
  finish(view: PageView, quotes: readonly string[]): RememberedRoute | undefined {
    const first = this.steps[0];
    const endPage = routeView(view, this.privateValues);
    if (!this.eligible || this.pendingApprovalId !== undefined || !first || endPage === undefined || quotes.length === 0 || quotes.length > 4) return undefined;
    const rows = evidenceRows(view);
    const evidence = new Set<string>();
    for (const quote of quotes) {
      const found = rows.filter(row => quote.trim().length >= 2 && row.includes(quote));
      if (found.length !== 1 || !cleanRouteText(found[0]!, this.privateValues)) return undefined;
      evidence.add(routeDigest(found[0]!));
    }
    return {goalKey: this.goalKey, site: new URL(first.page).origin, steps: this.steps, endPage, evidence: [...evidence]};
  }
}
