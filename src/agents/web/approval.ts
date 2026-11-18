import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ApprovalFingerprint } from "../../core/dialogue.ts";
import type { Action, ActionTarget } from "../../core/actions.ts";
import { tryUrl } from "../../core/url.ts";
import { josa, speakLabel } from "../../speech/phrasing.ts";
import type { WebObservation } from "./view.ts";

export type ApprovalAction = Pick<Action, "type" | "value" | "target">;
export type { ApprovalFingerprint } from "../../core/dialogue.ts";

function valueHash(value: string | undefined): string | null {
  return value === undefined ? null : createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function targetNow(view: WebObservation, target: ActionTarget) {
  if ((target.fieldId?.length ?? 0) > 0) return { fieldId: target.fieldId };
  const ref = target.ref;
  const item = (view.outline?.items ?? []).find(item =>
    ref !== undefined && ref.length > 0 ? item.ref === ref : item.role === target.role && item.name === target.name);
  if (item === undefined) return null;
  return { role: item.role, name: item.name, ...(ref !== undefined && ref.length > 0 ? { ref } : {}) };
}

// 본문·제목이 바뀌어도 무효화하지 않는다. 화면 값과 앞으로 넣을 값은 지문에 해시로만 저장한다.
export function fingerprint(view: WebObservation, actions: readonly ApprovalAction[], speech: string, fieldIds?: readonly string[]): ApprovalFingerprint {
  const fields = fieldIds ?? actions.flatMap(({ target }) => target?.fieldId === undefined || target.fieldId.length === 0 ? [] : [target.fieldId]);
  const observed = new Map((view.fields ?? []).map(field => [field.fieldId, field]));
  const url = tryUrl(view.url);
  return {
    actions: actions.map(action => ({
      type: action.type,
      role: action.target?.role ?? null,
      name: action.target?.name ?? null,
      now: targetNow(view, action.target ?? {}),
      ...(Object.hasOwn(action, "value") ? { valueHash: valueHash(action.value) } : {}),
    })),
    page: url === undefined ? view.url ?? "" : url.origin + url.pathname,
    fields: fields.map(fieldId => {
      const field = observed.get(fieldId);
      return { fieldId, label: speakLabel(field?.label ?? ""), valueHash: valueHash(field?.value) };
    }),
    speech,
  };
}

function difference(asked: ApprovalFingerprint, now: ApprovalFingerprint): string | undefined {
  if (asked.page !== now.page) return "여쭤본 뒤에 화면이 바뀌었어요.";
  for (const [i, action] of asked.actions.entries()) {
    const current = now.actions[i];
    if (current === undefined) break;
    if (action.valueHash !== current.valueHash) return "여쭤본 뒤에 넣을 값이 바뀌었어요.";
    if (!isDeepStrictEqual(action, current)) {
      const kind = josa(action.role === "link" ? "링크" : "버튼", "이", "가");
      const how = current.now === null ? "화면에서 없어졌어요" : "다른 것으로 바뀌었어요";
      return "누르려던 '" + (action.name ?? "") + "' " + kind + " " + how + ".";
    }
  }
  const labels = asked.fields.filter((field, i) => field.valueHash !== now.fields[i]?.valueHash).map(field => field.label);
  return labels.length > 0 ? labels.join(", ") + " 칸 값이 바뀌었어요." : undefined;
}

export function recheck(asked: ApprovalFingerprint, view: WebObservation, actions: readonly ApprovalAction[]) {
  const now = fingerprint(view, actions, asked.speech, asked.fields.map(field => field.fieldId));
  return [now, difference(asked, now)] as const;
}
