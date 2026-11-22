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

// 안내 팝업 증명(A2). 팝업 안의 한 단추를 '내용만 알리는 안내를 닫는 조작'으로 본다는 근거로, 누르기 직전의 새 관찰(controlWindow notice 질의)에서 얻는다.
// 어댑터가 누르기 직전에 다시 관찰해 이 사실과 같을 때만 누르므로, 부르는 쪽은 정책을 낮출 수 없고 증명이 낡으면 누르지 않는다.
// text는 600자까지만 담고 textLength는 전체 길이다(잘렸으면 둘이 다르다: 다 읽지 못한 안내는 안내로 보지 않는다).
// buttons·buttonCount: 보이는 단추(button·[role=button]·입력 단추). others: 팝업 안의 그 밖의 조작 요소(링크·입력·라벨·탭) 수. popups: 이때 떠 있던 팝업 수.
// root: 팝업 몸통의 ref. shadows: 팝업 안의 열린·닫힌 shadow root 수. 페이지 안에서는 닫힌 root를 볼 수 없어서 어댑터가 브라우저(CDP)의 DOM 정보로 세어 채운다.
// 읽지 못했으면 -1이고, 0이 아니면 속을 알 수 없는 부분이 있다는 뜻이라 안내로 보지 않는다.
export interface NoticeFacts {
  kind: DialogKind; title: string; text: string; textLength: number; buttons: readonly string[]; buttonCount: number;
  others: number; hasInputs: boolean; popups: number; signature: string; root: string; shadows: number;
}
export interface NoticeProof { kind: "notice"; url: string; ref: string; role: string; name: string; facts: NoticeFacts }
// 사이트가 띄운 confirm() 창에 '예'라고 답해 같은 조작을 한 번 되풀이해도 된다는 허가. 어느 탭·문서·주소에서, 어떤 글(전체 해시와 길이)에 대해서만 쓴다.
export interface NativeGrant { tab: string; document: string; url: string; hash: string; length: number }
// 어댑터가 취소한 confirm() 창의 기록. preview는 앞 200자, risk는 전체 글로 가른 분류다(long: 소리로 다 읽어 줄 수 없는 긴 글).
export interface NativeDialogRecord extends NativeGrant {
  actionId: string; preview: string; risk: "routine" | "consequential" | "long";
}
export interface NativeSeen { cancelled: readonly NativeDialogRecord[]; accepted: boolean }
/** 한 번의 조작에만 붙는 허가들. 정책 검사와 어댑터의 누르기 직전 확인에 같은 값이 쓰인다. */
export interface ExecuteGrants {
  notice?: NoticeProof; native?: NativeGrant; plan?: import("./plan.ts").PlanBinding;
  /** 이 탭에서 요청한 누르기가 바로 띄운 확인창 하나에만 답한다. */
  requestedClick?: "command" | "navigation";
}

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
