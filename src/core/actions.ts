import { z } from "zod";
import { boundedText, integer, omitAbsent, optional } from "./schema.ts";
import { tryUrl } from "./url.ts";

export const ACTION_TYPES = ["navigate", "back", "click", "fill", "press", "select", "check", "scroll", "read", "focus", "capture"] as const;
export const EXECUTION_ERROR_CODES = [
  "TARGET_NOT_FOUND", "AMBIGUOUS_TARGET", "VERIFY_FAILED", "TIMEOUT", "ABORTED",
  "NAVIGATION_FAILED", "RESUBMIT_BLOCKED", "LOG_FAILED", "NOT_SUPPORTED", "UNKNOWN",
] as const;
export const LINK_ROLES = ["link", "scriptlink"] as const;

export const PlatformSchema = z.literal("pc");
export const ActionTypeSchema = z.enum(ACTION_TYPES);
export const RiskSchema = z.enum(["low", "sensitive", "consequential"]);
export const ExecutionErrorCodeSchema = z.enum(EXECUTION_ERROR_CODES);
export type Platform = z.infer<typeof PlatformSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type ExecutionErrorCode = z.infer<typeof ExecutionErrorCodeSchema>;

export const UrlStringSchema = z.string().refine(value => tryUrl(value) != null, "주소 형식이 올바르지 않습니다.");
const name = z.string().min(1);
const natural = integer.nonnegative();

export const ActionTargetSchema = z.strictObject({
  ref: optional(name), label: optional(name), role: optional(name), name: optional(name),
  testId: optional(name), fieldId: optional(name), nth: optional(natural),
}).refine(t => t.ref === undefined || (t.role !== undefined && t.name !== undefined),
  "ref는 role과 name을 함께 지정해야 합니다.").transform(omitAbsent);
export type ActionTarget = z.infer<typeof ActionTargetSchema>;

export const ActionSchema = z.strictObject({
  id: name, type: ActionTypeSchema, target: optional(ActionTargetSchema), url: optional(UrlStringSchema),
  value: optional(boundedText(0, 300)), checked: optional(z.boolean()),
  reason: name, risk: RiskSchema, requiresConfirmation: z.boolean(),
}).transform(omitAbsent);
export type Action = z.infer<typeof ActionSchema>;

export const ActionResultSchema = z.object({
  actionId: z.string(), ok: z.boolean(), verified: z.boolean(),
  errorCode: optional(ExecutionErrorCodeSchema), message: optional(z.string()),
  readValue: optional(z.string()), latencyMs: natural,
}).transform(omitAbsent);
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const ObservedFieldSchema = z.object({
  fieldId: z.string(), label: z.string(), type: z.string(), required: z.boolean(), visible: z.boolean(),
  value: z.string(), filled: z.boolean(), invalid: z.boolean(), error: optional(z.string()),
  sensitive: z.boolean(), options: optional(z.array(z.string())), hint: optional(z.string()),
  searchable: optional(z.boolean()),
}).transform(omitAbsent);
export type ObservedField = z.infer<typeof ObservedFieldSchema>;

export const StepInfoSchema = z.object({ index: integer.positive(), total: integer.positive(), name: z.string() });
export type StepInfo = z.infer<typeof StepInfoSchema>;
export const DIALOG_KINDS = ["dialog", "layer"] as const;
// 팝업 사실(선택): 생략은 '모른다'이고 false는 '확인했고 없다'이다. 생략을 false로 읽지 않는다.
// kind: ARIA 대화상자·<dialog>는 "dialog", 화면 위에 뜬 레이어 팝업은 "layer".
// hasInputs: 팝업 안에 입력 칸·양식·안을 볼 수 없는 iframe·shadow root가 있거나 팝업 단추가 어떤 양식에(밖의 양식을 가리키는 button[form] 포함) 속하면 true. 모르면 true 쪽으로 기울인다.
// buttons: 보이는 단추(button·[role=button]·입력 단추)를 하나씩 담는다. 이름이 없으면 빈 문자열, 이름이 같으면 그대로 여럿이고 6개까지만 남는다.
export const DialogInfoSchema = z.object({
  title: z.string(), text: z.string(), buttons: z.array(z.string()),
  hasInputs: optional(z.boolean()), kind: optional(z.enum(DIALOG_KINDS)),
}).transform(omitAbsent);
export type DialogInfo = z.infer<typeof DialogInfoSchema>;
export type DialogKind = (typeof DIALOG_KINDS)[number];
// dialog: 이 요소가 들어 있는 팝업의 자리(같은 관찰의 dialogs 배열 번호). 팝업 밖이거나 모르면 생략.
export const InteractiveItemSchema = z.object({
  ref: z.string(), role: z.enum([...LINK_ROLES, "button", "tab", "menuitem", "generic"]), name: z.string(),
  region: z.enum(["main", "menu", "other"]), disabled: z.boolean(), searchResult: optional(z.boolean()),
  selected: optional(z.boolean()), expanded: optional(z.boolean()), pictureMasked: optional(z.boolean()),
  dialog: optional(natural),
}).transform(omitAbsent);
export type InteractiveItem = z.infer<typeof InteractiveItemSchema>;
export type ItemRole = InteractiveItem["role"];

export const ScreenTargetSchema = z.object({
  kind: z.enum(["selection", "focus", "hover"]), role: z.string(), label: z.string(), text: z.string(),
  position: optional(z.string()),
}).transform(omitAbsent);
export type ScreenTarget = z.infer<typeof ScreenTargetSchema>;

export const ScreenOutlineSchema = z.object({
  headings: z.array(z.object({ level: integer, text: z.string() })),
  notices: z.array(z.object({ label: z.string(), text: z.string() })),
  steps: z.array(z.string()), buttons: z.array(z.object({ name: z.string(), disabled: z.boolean() })),
  links: z.array(z.string()), linkCount: optional(natural), menuLinks: optional(z.array(z.string())),
  mainLinks: optional(z.array(z.string())), mainText: optional(z.string()), screenTarget: optional(ScreenTargetSchema),
  hasVisualContent: optional(z.boolean()), visualLabels: optional(z.array(z.string())), footerText: optional(z.string()),
  landmarks: optional(z.array(z.string())), items: optional(z.array(InteractiveItemSchema)),
}).transform(omitAbsent);
export type ScreenOutline = z.infer<typeof ScreenOutlineSchema>;

export const ObservationSchema = z.object({
  platform: PlatformSchema, url: z.string(), title: z.string(), step: optional(StepInfoSchema),
  fields: z.array(ObservedFieldSchema), errors: z.array(z.string()), dialogs: z.array(DialogInfoSchema),
  status: optional(z.string()), outline: optional(ScreenOutlineSchema), loading: optional(z.boolean()),
  capturedAt: z.string(),
}).transform(omitAbsent);
export type Observation = z.infer<typeof ObservationSchema>;

export function parseAction(candidate: unknown): Action | undefined {
  return ActionSchema.safeParse(candidate).data;
}

export function parseObservation(raw: unknown): Observation {
  return ObservationSchema.parse(raw);
}

export interface ExecutionAdapter {
  readonly platform: Platform;
  start(): Promise<void>;
  execute(action: Action, signal?: AbortSignal): Promise<ActionResult>;
  observe(): Promise<Observation>;
  close(): Promise<void>;
  bringToFront(): Promise<void>;
}
