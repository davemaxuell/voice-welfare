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
  fields: optional(z.array(field)), dialogs: optional(z.array(DialogInfoSchema.partial().loose())),
  outline: optional(outline),
}).loose();

export type WebObservation = z.infer<typeof WebObservationSchema>;
export type WebField = z.infer<typeof field>;
export type WebItem = z.infer<typeof item>;
