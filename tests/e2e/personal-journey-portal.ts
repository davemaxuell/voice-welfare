import type { Page } from "playwright";

export const portalOrigin = "https://citizen-services.example.invalid";
export const portalPrivate = {
  username: "violet-customer@example.invalid",
  password: "plum-credential-only-on-form",
  email: "orchard-contact@example.invalid",
  phone: "010-0000-0000",
  query: "cedar-session-identifier",
  fragment: "hazel-private-fragment",
  linkQuery: "maple-record-identifier",
  cookie: "birch-browser-credential",
};

export interface PortalLayout {
  readonly language: string;
  readonly home: string;
  readonly title: string;
  readonly ask: string;
  readonly account: string;
  readonly accountPath: string;
  readonly loginTitle: string;
  readonly workspace: string;
  readonly workspacePath: string;
  readonly detail: string;
  readonly detailPath: string;
  readonly statusTitle: string;
  readonly status: string;
  readonly detour?: { readonly title: string; readonly link: string; readonly path: string };
}

export const layouts = [{
  language: "ko", home: "/", title: "온라인 민원 창구",
  ask: "제가 접수한 민원이 지금 어디까지 처리됐는지 알려 주세요",
  account: "내 민원함 열기", accountPath: "/gate/identity",
  loginTitle: "로그인", workspace: "이용자 보관함", workspacePath: "/member/desktop",
  detail: "내가 보낸 요청과 처리결과", detailPath: "/member/cases",
  statusTitle: "최근 요청 처리결과", status: "접수한 민원은 담당 부서 검토 중입니다.",
  detour: { title: "일반 이용자를 위한 자료", link: "민원 처리 현황", path: "/help/request-statistics" },
}, {
  language: "en", home: "/", title: "Public Services Office",
  ask: "여기서 전에 제가 낸 민원의 결과가 나왔는지 봐 주세요",
  account: "Resident workspace", accountPath: "/identity/access",
  loginTitle: "Sign in", workspace: "Your service desk", workspacePath: "/dashboard/overview",
  detail: "Delivery and review updates", detailPath: "/workspace/activity",
  statusTitle: "Current case status", status: "신청 결과는 승인 완료입니다.",
}] satisfies PortalLayout[];

export const heldOut = {
  language: "ja", home: "/", title: "住民手続き窓口",
  ask: "지난번에 낸 민원 있잖아요. 지금 어느 단계인지 이 화면에서 좀 찾아봐 주실래요?",
  account: "ご利用者専用ページ", accountPath: "/access/entry",
  loginTitle: "本人確認", workspace: "利用者メニュー", workspacePath: "/desk/top",
  detail: "提出した手続きの進み具合", detailPath: "/desk/archive/progress",
  statusTitle: "直近の手続き", status: "접수한 민원은 추가 자료를 기다리고 있습니다.",
} satisfies PortalLayout;

export function dashboardUrl(layout: PortalLayout) {
  return portalOrigin + layout.workspacePath + "?session=" + portalPrivate.query + "#" + portalPrivate.fragment;
}

export async function mountPortal(page: Page, layout: PortalLayout, { missingStatus = false } = {}) {
  const visited: string[] = [];
  const outside: string[] = [];
  const link = (path: string, label: string) => `<a href="${path}">${label}</a>`;
  const pages = new Map([
    [layout.home, [layout.title, layout.language === "ko"
      ? `<nav>${link(layout.detour?.path ?? "/help", layout.detour?.link ?? "이용 안내")}</nav>
         <section><h2>이용자 전용</h2>${link(layout.accountPath, layout.account)}</section>`
      : `<article><h2>${layout.language === "ja" ? "お手続き" : "Manage your requests"}</h2>
         <ul><li>${link("/help", layout.language === "ja" ? "よくある質問" : "Visitor help")}</li>
         <li>${link(layout.accountPath, layout.account)}</li></ul></article>`]],
    [layout.detour?.path ?? "/help", [layout.detour?.title ?? "Help",
      "<p>공개 자료에는 월별 처리 건수와 담당 부서 안내만 있습니다.</p>"]],
    [layout.accountPath, [layout.loginTitle, `
      <form id="resident-form">
        <label for="resident-id">Resident ID</label><input id="resident-id" type="email" name="resident">
        <label for="resident-password">Password</label><input id="resident-password" type="password" name="password">
        <button type="submit">Continue</button>
      </form>
      <script>
        document.querySelector("#resident-form").addEventListener("submit", event => {
          event.preventDefault();
          if (document.querySelector("#resident-id").value && document.querySelector("#resident-password").value) {
            document.cookie = "residentSession=${portalPrivate.cookie}; Secure; SameSite=Strict; Path=/";
            location.assign(${JSON.stringify(dashboardUrl(layout))});
          }
        });
      </script>`]],
    [layout.workspacePath, [layout.workspace, `
      <header><p>${portalPrivate.email}</p><p>${portalPrivate.phone}</p></header>
      <section aria-label="${layout.workspace}">
        ${link(layout.detailPath + "?record=" + portalPrivate.linkQuery, layout.detail)}
        <button type="button" onclick="location.assign('/submitted')">제출</button>
      </section>`]],
    [layout.detailPath, [layout.statusTitle, missingStatus ? "<p>조회할 기록이 없습니다.</p>" : `<p>${layout.status}</p>`]],
  ] as const);
  await page.context().route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== portalOrigin) {
      outside.push(url.origin);
      return route.abort();
    }
    if (!request.isNavigationRequest()) return route.fulfill({ status: 204 });
    visited.push(url.pathname);
    if ((url.pathname === layout.workspacePath || url.pathname === layout.detailPath)
        && (await request.headerValue("cookie"))?.includes("residentSession=" + portalPrivate.cookie) !== true) {
      return route.fulfill({ status: 401, contentType: "text/html", body: "<title>Sign in required</title>" });
    }
    const [title, content] = pages.get(url.pathname) ?? ["Not found", "<p>요청한 화면을 찾지 못했습니다.</p>"];
    return route.fulfill({
      status: pages.has(url.pathname) ? 200 : 404,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="${layout.language}"><head><title>${title}</title></head>
        <body><main><h1>${title}</h1>${content}</main></body></html>`,
    });
  });
  return { visited, outside };
}

export async function signIn(page: Page, layout: PortalLayout) {
  await page.getByLabel("Resident ID").fill(portalPrivate.username);
  await page.getByLabel("Password").fill(portalPrivate.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(dashboardUrl(layout));
}
