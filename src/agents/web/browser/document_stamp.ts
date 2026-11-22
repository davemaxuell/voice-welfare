export interface DocumentStamp {
  id: string;
  revision: number;
  url: string;
}

declare global {
  interface Document {
    __cheongeumDocument?: { id: string; revision: number };
  }
}

/** 문서를 새로 열거나 같은 문서에서 주소가 바뀌면 앞서 승인한 조작을 구별한다. */
export function stampDocument(id: string): DocumentStamp {
  let stamp = document.__cheongeumDocument;
  if (stamp === undefined) {
    stamp = { id, revision: 0 };
    Object.defineProperty(document, "__cheongeumDocument", { value: stamp });
    const record = stamp;
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    navigation?.addEventListener("currententrychange", () => { record.revision++; });
  }
  return { id: stamp.id, revision: stamp.revision, url: location.href };
}
