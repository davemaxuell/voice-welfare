import { browsePatterns } from "../../src/agents/web/skills/browse.ts";
import { screenPatterns } from "../../src/agents/web/skills/screen_context.ts";
import { authPatterns } from "../../src/agents/web/auth_page.ts";
import { autopilotPatterns } from "../../src/agents/web/autopilot.ts";
import { linkPatterns } from "../../src/agents/web/link_choices.ts";
import { playbookPatterns } from "../../src/agents/web/playbook.ts";
import { piecePattern, shotPatterns } from "../../src/agents/web/shot.ts";
import { picturePatterns } from "../../src/speech/picture.ts";

const RRN = "900101-1234567";

// 77aad3e에서 새로 생긴 정규식의 지문과 제품 코드의 RegExp.
export const webAgentRegexPorts77 = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/agents/web/skills/browse.py", new Map([
    ["5d21f913916769d744ed", browsePatterns.homePage], ["073d8c18508ba546c590", browsePatterns.goalTail],
    ["87b7e922cbae6a7cfbfb", screenPatterns.generalDetail], ["3bb18b85e51870226665", screenPatterns.deictic],
    ["a0bb09a42827fb1a207b", screenPatterns.visual], ["513a8b0643a7d128ac4d", browsePatterns.readMore],
    ["99d053cdf2c9a4d9a4a8", screenPatterns.numbers], ["4326695dc9e137c7bb50", browsePatterns.newlines],
    ["89534a8cb94a059394e1", browsePatterns.guide], ["b9a3e11f2894f123ff0e", screenPatterns.general],
    ["0a769d09ea270f8c7723", browsePatterns.practice],
  ])],
  ["src/cheongeum/agents/web/auth_page.py", new Map([
    ["61341da48948272c73f8", authPatterns.sentence],
    ["fd27cbc1847fd27eebc4", authPatterns.captcha],
    ["8cd69219f29fbfef5cb0", authPatterns.verification],
    ["96bd2e0ca03133c751d4", authPatterns.accessBlock],
    ["da99f3de00f49263b73a", authPatterns.onPage],
    ["735f80682d0b61552bed", authPatterns.verifyChoose],
    ["8fb920fcb69d2317d7af", authPatterns.verifyControl],
    ["d102e49a94608c912cae", authPatterns.certificateTool],
    ["128f3635330fc49d26b1", authPatterns.authNews],
    ["5741858cbaca0d9ce161", authPatterns.describes],
    ["9929c9331dafa81c46ae", authPatterns.doItNow],
  ])],
  ["src/cheongeum/agents/web/playbook.py", new Map([
    ["4ad36ac2e0c1075145bd", playbookPatterns.typeTwo],
    ["7635ce19e30df7d854d3", playbookPatterns.procedureHeading],
    ["d36a92aa67f4e1354e1c", playbookPatterns.howToApply],
    ["a6f134d1e86132d6aec5", playbookPatterns.when],
    ["7ea84e0b2c014f63b685", playbookPatterns.residentCopy],
    ["9189eaec16d1f11b1e3a", playbookPatterns.space],
  ])],
  ["src/cheongeum/agents/web/link_choices.py", new Map([
    ["6d48740cb894ab55a9fc", linkPatterns.proposalReply],
    ["a1b7a0a24a088e17adeb", linkPatterns.simple],
    ["35ced9e74ae388339258", linkPatterns.ordinal],
    ["6113bf5a4f6399ba2fb5", linkPatterns.confirmThenOpen],
    ["19d35fc9f7880ad6b5f6", linkPatterns.pointer],
    ["6e6db409df3b60a5c104", linkPatterns.pointerOpen],
    ["029c51e664464ef49589", linkPatterns.negated],
    ["d25f49806748841d015c", linkPatterns.openEnd],
    ["fa7bc3c0ba906687054f", linkPatterns.correction],
    ["551599cdd701899db2f0", linkPatterns.yesLead],
    ["4d541f4137b66ac02713", linkPatterns.linkNoun],
    ["9cbfdf195228d704574d", linkPatterns.describe],
    ["a2f855faeaac1d5e0e52", linkPatterns.anything],
    ["221701d9928e4d72bde1", linkPatterns.information],
    ["b46eea014fd5b9c58a2f", linkPatterns.program],
    ["956c786e68a94a136d93", linkPatterns.digits],
  ])],
  // 125번 줄의 식은 test_judge_blocks의 조각과 이웃 조각으로 만들어진다.
  ["src/cheongeum/agents/web/shot.py", new Map([
    ["b2dc0eeda1657c80e054", shotPatterns.captchaFrame],
    ["371ad68a0cddd192fd37", shotPatterns.captchaWords],
    ["5892b7d2834d60448e28", piecePattern("110-123-456789", "계좌번호", "담당 부서")],
    ["1b6f4d963c84ebaaf3bc", piecePattern("3", "계좌번호", "")],
    ["6d41803b1c9e88b59165", piecePattern(`주민등록번호 ${RRN}`, "기초연금 안내", "")],
    ["e113d22c9ced98a10a0b", piecePattern("카드번호 1234-5678-9012-3456", "안내", "")],
    ["19c3c1c87a96c2662a8e", piecePattern(`주민등록번호 ${RRN}`, "앞 문단입니다", "")],
    ["51f0bbd6df8398129b1a", piecePattern(RRN, "주민등록번호", "")],
    ["b86e894c4960ebc87fbf", piecePattern(`주민등록번호 ${RRN}`, "", "")],
    ["9e7a0888b67c8836a23b", piecePattern(`주민등록번호 ${RRN}`, "", "안내")],
    ["53194196a6acf9ce3ae9", piecePattern(`주민등록번호 ${RRN}`, "", "안쪽 문단입니다.")],
  ])],
  ["src/cheongeum/speech/picture.py", new Map([
    ["298a1d30b0de9dd9d347", picturePatterns.sentenceEnd],
    ["fbccf56fa5f6d2ac9566", picturePatterns.addressedToAi],
  ])],
  ["src/cheongeum/agents/web/autopilot.py", new Map([
    ["237840e09587d01a3bd7", autopilotPatterns.sentence],
    ["4326695dc9e137c7bb50", autopilotPatterns.rows],
  ])],
]);
