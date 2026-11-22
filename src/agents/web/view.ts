import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DialogInfoSchema, InteractiveItemSchema, ObservationSchema, ObservedFieldSchema, ScreenOutlineSchema, StepInfoSchema,
} from "../../core/actions.ts";
import { optional } from "../../core/schema.ts";

// 브라우저는 화면 전체를 돌려준다. 화면 비교와 개별 동작은 관찰한 글이나 입력 칸만 남긴 기록도 쓴다.
const field = ObservedFieldSchema.in.partial().loose();
const item = InteractiveItemSchema.in.partial().loose();
const outline = ScreenOutlineSchema.in.partial().extend({
  headings: optional(z.array(ScreenOutlineSchema.in.shape.headings.element.partial().loose())),
  buttons: optional(z.array(ScreenOutlineSchema.in.shape.buttons.element.partial().loose())),
  items: optional(z.array(item)),
}).loose();

export const WebObservationSchema = ObservationSchema.in.partial().extend({
  pageId: optional(z.string()), mainText: optional(z.string()),
  step: optional(StepInfoSchema.partial().loose()),
  fields: optional(z.array(field)), dialogs: optional(z.array(DialogInfoSchema.in.partial().loose())),
  outline: optional(outline),
}).loose();

export type WebObservation = z.infer<typeof WebObservationSchema>;
export type WebField = z.infer<typeof field>;
export type WebItem = z.infer<typeof item>;

/** 같은 주소에서도 제목과 메뉴 상태로 화면을 구별한다. 저절로 바뀌는 본문은 비교에서 뺀다. */
export function screenKey(view: WebObservation): string {
  const outline = view.outline;
  return createHash("sha256").update(JSON.stringify([view.url, view.title, outline?.headings,
    outline?.items?.map(item => [item.name, item.role, item.expanded, item.selected, item.disabled])])).digest("hex");
}

/** 같은 화면 상태에서 승인받아 누른 항목만 중복 실행을 막고, 다음 단계로 바뀐 재사용 단추는 새 승인을 허용한다. */
export function approvedClickKey(view: WebObservation, ref: string): string {
  return createHash("sha256")
    .update(JSON.stringify([screenKey(view), view.step?.current, view.step?.label, view.outline?.steps, ref]))
    .digest("hex");
}
