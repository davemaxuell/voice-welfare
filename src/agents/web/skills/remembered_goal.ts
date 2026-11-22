import type { PlanStep, RememberedRoute } from "../../../core/plan.ts";
import { draft, type Draft } from "../../../core/turn.ts";
import { todayIso } from "../../../core/time.ts";
import { clickTier } from "../../../safety/guard.ts";
import { verifiedClick, type ExecContext, type PageView, type WebAction } from "../agent.ts";
import type { GoalContinuation } from "../autopilot.ts";
import type { BrowserJourney } from "../journey.ts";
import { routeMetadataSafe, routePage } from "../../../safety/route_metadata.ts";
import { routeAnswer, routeItem, routeView, type RouteLearning } from "../goal_route.ts";
import { noticeSpeech } from "../notice.ts";
import type { BrowseSkill } from "./browse.ts";
import { browseState } from "./common.ts";

interface Replay {
  goal: string; route: RememberedRoute; ctx: ExecContext; learning: RouteLearning; continuation: GoalContinuation;
  entry?: string; journey?: BrowserJourney; maxSteps: number; deviceAllowed(): boolean;
  resume(ctx: ExecContext, remainingSteps: number, remainingMs: number): Promise<Draft>;
}

/** 이미 누른 항목과 남은 한도를 이어 주므로 불일치 때 처음 화면으로 돌아가지 않는다. */
export async function replayGoal(browse: BrowseSkill, run: Replay): Promise<Draft> {
  const {web} = browse;
  const {ctx, route, journey, learning} = run;
  const values = learning.privateValues;
  const first = route.steps[0]!;
  const actions: WebAction[] = [];
  const notices: string[] = [];
  let used = 0, started: number | undefined;
  const budget = journey?.timeRemaining(75_000) ?? 75_000;
  const remainingMs = () => budget - (started === undefined ? 0 : performance.now() - started);
  const remainingSteps = () => Math.min(run.maxSteps - used, journey?.remaining ?? Infinity);
  const stop = () => draft("STOPPED", "stop", "멈췄어요.");
  const append = (result: Draft): Draft => ({...result, speech: [...notices, result.speech].join(" "),
    actions: [...actions, ...result.actions ?? []], browserIterations: used + (result.browserIterations ?? 0)});
  function fallback(live: ExecContext) {
    if (live.signal.aborted || live.isStopped()) return Promise.resolve(stop());
    if (!run.deviceAllowed()) learning.eligible = false;
    if (remainingSteps() <= 0 || remainingMs() <= 0) return Promise.resolve(draft("BROWSING", "goal", "이번에 할 수 있는 탐색 횟수나 시간을 채워서 멈췄어요."));
    return run.resume(live, remainingSteps(), remainingMs());
  }
  const canStep = (live: ExecContext, view: PageView, step: PlanStep) => {
    started ??= performance.now();
    return run.deviceAllowed() && !live.isStopped() && !live.signal.aborted && remainingSteps() > 0 && remainingMs() > 0 &&
      journey?.admit("click") !== false && routeItem(view, step, values) !== undefined;
  };
  const didStep = (ref: string) => {
    run.continuation.approvedRefs.add(ref);
    learning.steps.push({...route.steps[learning.steps.length]!});
    used++;
    journey?.takeStep();
  };
  const complete = async (live: ExecContext): Promise<Draft> => {
    if (live.isStopped() || live.signal.aborted) return stop();
    const view = await web.observe(live);
    const quotes = run.deviceAllowed() && remainingSteps() > 0 && remainingMs() > 0 ? routeAnswer(route, view, values) : undefined;
    if (!quotes) return fallback(live);
    browse.afterNavigation(view);
    const speech = quotes.join(" ");
    const sources = [{title: view.title, url: view.url, lastCheckedAt: todayIso(), note: "웹 화면"}];
    return draft(browseState(view), "goal", speech, {summary: speech, sources, view, reviewQuotes: quotes,
      reviewQuoteSources: Object.fromEntries(quotes.map(quote => [quote, [view.url]]))});
  };
  if (!routeMetadataSafe(route, values)) return fallback(ctx);
  let view = await web.observe(ctx);
  if (run.entry !== undefined && routePage(run.entry, values) === first.page && view.url !== first.page) {
    if (remainingSteps() <= 0 || ctx.signal.aborted || ctx.isStopped() || !run.deviceAllowed()) return fallback(ctx);
    started = performance.now();
    const entered = await web.openSite(run.entry, ctx);
    actions.push(...entered.actions);
    used++;
    journey?.takeStep();
    if (entered.status !== "ok" || !entered.view) return append(await fallback(ctx));
    view = entered.view;
  }
  if (routeView(view, values) !== first.page) return append(await fallback(ctx));
  if (!web.guard.directActions && route.steps.some(step => clickTier(step.role, step.name) === "ask")) {
    const offered = await browse.knownPlans.offer(run.goal, route.steps, ctx, {
      canStep, didStep, onComplete: async live => { const done = await complete(live); return {...done, browserIterations: used + (done.browserIterations ?? 0)}; },
      onMismatch: async live => { const next = await fallback(live); return {...next, browserIterations: used + (next.browserIterations ?? 0)}; },
    });
    if (offered) return append(offered);
    return append(await fallback(ctx));
  }
  for (const step of route.steps) {
    view = await web.observe(ctx);
    const item = routeItem(view, step, values);
    if (!item || !canStep(ctx, view, step)) return append(await fallback(ctx));
    const out = await web.followLink(item.name, ctx, false, {expected: [view.url, item.ref, item.role]});
    if (out.status === "needs-clarification" || out.actions.some(a => a.result?.errorCode === "VERIFY_FAILED" || a.result?.errorCode === "TARGET_NOT_FOUND")) {
      actions.push(...out.actions);
      return append(await fallback(ctx));
    }
    if (out.status === "needs-approval" && out.pending) {
      learning.eligible = false;
      return append(out.native ? browse.askNative(out.pending, out.native, out.view, "", out.actions) : browse.askClick(out.pending, out.view, "", out.actions));
    }
    const clicked = out.actions.find(a => a.action.target?.ref === item.ref && verifiedClick(a));
    if (!clicked || out.status !== "ok" || !out.view || out.effect !== "moved" && out.effect !== "changed" || out.question || (out.manual?.length ?? 0) > 0) {
      const action = clicked?.action ?? out.actions[0]?.action;
      if (action) return append(await browse.finishApprovedClick(out, {action, url: view.url}, ctx, true));
      return append(await fallback(ctx));
    }
    actions.push(...out.actions);
    const notice = noticeSpeech(out.notices ?? []);
    if (notice.length > 0) notices.push(notice);
    didStep(item.ref);
  }
  return append(await complete(ctx));
}
