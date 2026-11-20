import { z } from "zod";
import { applicationPeriod } from "../../src/agents/welfare/agent.ts";
import { matchServices, nextProfileSlot, parseProfileAnswer } from "../../src/agents/welfare/discovery.ts";
import { retrieve } from "../../src/agents/welfare/rag.ts";

const slot = z.enum(["age", "disability", "income", "ctpv"]);
const profile = z.object({
  age: z.number().optional(), disability: z.enum(["no","yes","unknown","mild","severe"]).optional(),
  income: z.enum(["basic","near-poor","low","normal","unknown"]).optional(), ctpv: z.string().nullish(), sgg: z.string().nullish(),
  singleParent: z.boolean().optional(), manyChildren: z.boolean().optional(), veteran: z.boolean().optional(),
  multicultural: z.boolean().optional(), living: z.enum(["alone","family"]).optional(),
});
const strings = z.array(z.string());
const common = { servId: z.string(), servNm: z.string(), summary: z.string(), lifeStages: strings, targets: strings, themes: strings };
const catalog = z.array(z.discriminatedUnion("provider", [
  z.looseObject({
    ...common, detailUrl: z.string(), provider: z.enum(["central","local"]), onlineApply: z.boolean().optional(),
    region: z.object({ctpv: z.string(), sgg: z.string().optional()}).optional(),
    provision: z.string().optional(), cycle: z.string().optional(),
  }),
  z.looseObject({
    ...common, provider: z.literal("private"), organization: z.string(), dataOrigin: z.literal("official-snapshot"),
    target: z.string(), benefit: z.string(), applyMethod: z.string(), documents: z.string(), referenceDate: z.string(),
    source: z.looseObject({ title: z.string(), url: z.string(), lastCheckedAt: z.string(), version: z.string(), note: z.string() }),
  }),
]));
const chunk = z.object({
  id: z.string(), text: z.string(), section: z.enum(["개요","지원대상","선정기준","지원내용","제출서류","신청절차","서식","문의처","근거법령"]),
  field: z.enum(["summary","target","criteria","benefit","documents","applySteps","applyMethod","forms","contacts","laws"]),
});
const date = z.string().nullish().transform(text => text ?? undefined);
const period = z.object({
  enfcBgngYmd: date, enfcEndYmd: date, summary: date, target: date, criteria: date, benefit: date, applyMethod: date,
  applySteps: z.array(z.object({step: z.string(), detail:z.string()})).nullish().transform(steps => steps ?? undefined),
});

export const welfareImplementations = new Map<string, (inputs: Record<string, unknown>) => unknown>([
  ["agents.welfare.rag.retrieve", a => retrieve(z.string().parse(a.question), z.array(chunk).parse(a.chunks), z.int().parse(a.k))],
  ["agents.welfare.discovery.next_profile_slot", a => nextProfileSlot(profile.parse(a.p)) ?? null],
  ["agents.welfare.discovery.parse_profile_answer", a => parseProfileAnswer(
    z.string().parse(a.text), slot.nullish().parse(a.asking) ?? undefined, profile.nullish().parse(a.known) ?? undefined)],
  ["agents.welfare.discovery.match_services", a => matchServices(catalog.parse(a.catalog), profile.parse(a.p))],
  ["agents.welfare.agent.application_period", a => applicationPeriod(period.parse(a.s), date.parse(a.today))],
]);
