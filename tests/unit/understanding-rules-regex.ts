import { fullMatchExpression, prefixMatchExpression } from "./regex-match-mode.ts";
import { createMockWelfareProfile, fieldVocabulary } from "../../src/agents/web/profile.ts";
import { filtersPatterns } from "../../src/understanding/filters.ts";
import { RuleBasedIntentProvider, rulesPatterns } from "../../src/understanding/rules.ts";
import { sitesPatterns } from "../../src/understanding/sites.ts";

const rules = new Map<string, RegExp>([
  ["e35b0f5b692b8916a8be", fullMatchExpression(rulesPatterns.cancelWord)],
  ["81bbc9172f7b86a95fe8", fullMatchExpression(rulesPatterns.stop)],
  ["783b1bc851210e3b6c09", prefixMatchExpression(rulesPatterns.progressStart)],
  ["f5d1939cdc7e91c7da01", rulesPatterns.afterQuestion],
  ["021e2fb4b7a3a5732466", rulesPatterns.beforeGoThere],
  ["006d8b6cd94ee46a7aa7", rulesPatterns.downloadAnalyze],
  ["87ded8ab49f10b6d3e0b", rulesPatterns.downloaded],
  ["55eda0a0138db6cbe848", rulesPatterns.downloadList],
  ["2090523f743a8d466129", rulesPatterns.downloadNoun],
  ["83778b88d910fe2033ce", rulesPatterns.downloadQuestion],
  ["d2ba31bbfb4501b37df1", rulesPatterns.downloadRead],
  ["14cbe8af73744f0ebfe5", rulesPatterns.downloadTarget],
  ["6e25c5f9f975d1e766f8", rulesPatterns.fileWord],
  ["bfa30cca242d4b26805a", rulesPatterns.imageWord],
  ["394da2ff9ef4cfd94684", rulesPatterns.justSaid],
  ["f0e476f44f029597c74a", rulesPatterns.loginAsk],
  ["b2814742c53f3adb40c5", rulesPatterns.noPicture],
  ["ba7f7d1a4264e534bfb2", rulesPatterns.notThis],
  ["298bbbf0097c2953c478", rulesPatterns.openOfficial],
  ["ed1b76baa23c8f2e9c65", rulesPatterns.pageName],
  ["960582998a74a81ba21b", rulesPatterns.pictureRequest],
  ["85ee2893f493a7fdb78b", rulesPatterns.pictureWord],
  ["efa0d9ac7054a3a08788", rulesPatterns.restartSetup],
  ["fecf164be8b6cc5927a9", rulesPatterns.screenWord],
  ["8be8318010c70415888a", rulesPatterns.slowRepeat],
  ["9189eaec16d1f11b1e3a", rulesPatterns.space],
  ["ce0ca22d87c4452d03c8", rulesPatterns.stopClauses],
  ["57583d2cbe211f61e4bc", rulesPatterns.stopImperative],
  ["1db9ee90d75bdc02862c", rulesPatterns.submitAsk],
  ["8adf9df14b20eef2952c", rulesPatterns.submitNegated],
  ["a9a933a709920e5d6f4f", rulesPatterns.textOnly],
  ["b80c34db5f0a3552ce4c", rulesPatterns.metacharacters],
  ["b216059268f6e1deab59", rulesPatterns.aliasSeparators],
  ["0ea3892771c9e31ca4f2", rulesPatterns.edgeQuotes],
  ["da70a4400f447daabec5", rulesPatterns.quotedCommand],
  ["a49199bcc768c867bc24", rulesPatterns.valueCommand],
  ["a92f6dfcc5d28f6245c5", rulesPatterns.politeEnding],
  ["d6b13b461204cdf365c7", rulesPatterns.politeName],
  ["95c29df09a17be96aeb5", rulesPatterns.digit],
  ["6a0ef3beb6c7822e010f", rulesPatterns.serviceName],
  ["692e22e045eb31230df8", rulesPatterns.listedService],
  ["bf62838c5b0bed000d63", rulesPatterns.help],
  ["609277304ecf87e7ffe7", rulesPatterns.moreHelp],
  ["9ed4547a96e0332a161d", rulesPatterns.here],
  ["62a539b778f7c0b835c8", rulesPatterns.commandSeparator],
  ["bed848a150c8b55baa22", rulesPatterns.sentenceEnd],
  ["4e7d97ccd5d741ffc4a5", rulesPatterns.spaces],
  ["07fe35af5f901cdd261a", rulesPatterns.serviceNumber],
  ["34c29e3854f6798ae950", rulesPatterns.search],
  ["5c55a21cc657d559784e", rulesPatterns.queryPrefix],
  ["294708ccc53084a90777", rulesPatterns.quotesAnywhere],
  ["a142f615fe6bea3c56f4", rulesPatterns.linkCommand],
  ["b716692b744507c72bbb", rulesPatterns.slot],
  ["94613d85c00dc58b893d", rulesPatterns.edit],
  ["e3885e3f45037c284441", rulesPatterns.editCommand],
  ["ec7c890a4454d19134a9", rulesPatterns.punctuationPrefix],
  ["374f9f62f5fddcfc6736", rulesPatterns.fieldSeparator],
]);

const filters = new Map<string, RegExp>([
  ["8453eb1ce56d74beed27", filtersPatterns.questionLike],
  ["a8a2501ecde1f2faf40e", filtersPatterns.address],
  ["ddf3bc4c5b71142eeded", filtersPatterns.filler],
  ["6214c2c6a88b8833b37e", filtersPatterns.sentenceEnd],
  ["4e7d97ccd5d741ffc4a5", filtersPatterns.spaces],
  ["f5ac669f2165a29ae147", filtersPatterns.vagueAction],
  ["38090ec66aac8bdef530", filtersPatterns.vagueClick],
  ["81f990e89060f6366176", filtersPatterns.vagueOpen],
  ["3de0a13942c6650e1a21", filtersPatterns.vagueSearch],
  ["56cc31adc3d75ebd95cf", filtersPatterns.vagueTell],
]);

const sites = new Map<string, RegExp>([
  ["926238c2205888ba82a5", sitesPatterns.civilPortal],
  ["53ce5c545eb50de2aabc", sitesPatterns.explicitUrl],
  ["cf117edd579f54bf22b3", sitesPatterns.goalMarker],
  ["b1c077e1515fb5898fb6", sitesPatterns.goalParticle],
  ["a4d9b05143db531b2a57", sitesPatterns.goalSiteNoun],
  ["d79d8c97db11dcd136a4", sitesPatterns.guessDestination],
  ["56a9fda3ce4ca8db06f0", sitesPatterns.guessOpen],
  ["8ef568888507088182b0", sitesPatterns.guessParticle],
  ["8d49cd7bae960453970b", sitesPatterns.scholarshipType1],
  ["750125b87071135a4c2b", sitesPatterns.scholarshipType2],
  ["6ba146b7a339fb1385d3", sitesPatterns.siteNameTail],
  ["33e7f8433db33e4bb35e", sitesPatterns.siteNoun],
  ["aee624cfe46e32cd8e84", sitesPatterns.openCommand],
  ["4e7d97ccd5d741ffc4a5", sitesPatterns.spaces],
  ["53b5b7d62e093c2550f6", sitesPatterns.domain],
  ["9189eaec16d1f11b1e3a", sitesPatterns.space],
  ["6dd7d8c52bab938d53e2", sitesPatterns.otherThanHangul],
  ["55a58b10a91669f3190f", sitesPatterns.particle],
  ["dab0c32c9005b9c9f74e", sitesPatterns.hangulName],
  ["9a31e22043def8a9a829", sitesPatterns.www],
  ["6a6b52551a0b2b356485", sitesPatterns.dotCom],
  ["a39f61ac489f78861c3e", sitesPatterns.dotKr],
  ["6ddc9ffb20e24e9ca6af", sitesPatterns.linkEnding],
  ["7dc6e08d5919ad827b04", sitesPatterns.localAddress],
  ["cbc188bb11adef9dd8f3", sitesPatterns.protocol],
]);

// Python 모의 신청서 별칭별로 입력값을 읽는 식과 항목명을 찾는 식을 기록했다.
const aliasIds = new Map<string, readonly [string, string]>([
  ["실거주지가 주민등록 주소와 다릅니다", ["fa795d00eb17ab0a58f5", "ee6c06d1ad4c295bfe28"]],
  ["주민등록상 주소", ["de169ff17939a47ad027", "5c63f00a8ccb2875d940"]],
  ["주민등록 주소", ["e867fc95a0a6ef9948f5", "42b083cbffebd96c629a"]],
  ["실거주지 다름", ["d09bc8102b4f891f8bde", "71732fd6f2a020e7c658"]],
  ["실거주지 주소", ["afb8f175fe8122fc24d6", "4ec7096052e1c4688a4b"]],
  ["소득·재산 신고", ["d3b5b79b055a7d4c4f01", "1c47ac7e4510050f2483"]],
  ["소득 재산 신고", ["d3b5b79b055a7d4c4f01", "1c47ac7e4510050f2483"]],
  ["신청인 이름", ["f028af4ae0d80b6c8f38", "e864bf9d3fc014ce9393"]],
  ["신청자 이름", ["de279f01be3bebb6f7ed", "e045e93011b97b1855a1"]],
  ["신청인 성명", ["0845b9445fcffb6eae7a", "6a7e614a7a8a2968d90d"]],
  ["거주지 주소", ["fd2d68479006f355d056", "bc86b991b0ac5a46ac82"]],
  ["사는 곳 주소", ["063448acc4e0f799b59b", "b56bf2132cee4d642bc6"]],
  ["휴대폰 번호", ["f4207628343b8a94b0ff", "32beb9b279ebec909afd"]],
  ["핸드폰 번호", ["6d3820eecfa5807c6d47", "6ce0c94e711d8cd37ea0"]],
  ["등록 주소", ["c8dc94a1e25acdde67af", "0fc20630bbf5e078da1c"]],
  ["주민등록", ["332906c4a760138fdf1e", "4bcf36f1edd17145aca5"]],
  ["실거주지", ["686c43ef1c6b86abc69f", "7b3a97bee34154e4e878"]],
  ["전화번호", ["2d4c2d8f3f4943016beb", "2025f2c74c04a9a56229"]],
  ["휴대전화", ["71462fa3273f983b3d71", "e42d0e4e3799101c0ef4"]],
  ["소득·재산", ["581a1e0ebde5fdd04e35", "349cf331bbd41a6ba6b7"]],
  ["소득 재산", ["581a1e0ebde5fdd04e35", "349cf331bbd41a6ba6b7"]],
  ["소득 신고", ["abd9cb769b915f383b67", "2994badcc6682c58992d"]],
  ["가구원 수", ["b33e9441876865d6d7de", "e9ef506f92c5e09c2f77"]],
  ["연락처", ["ea2ce8ca1cc90cde1cc9", "59e9aea9df0cc7a71152"]],
  ["휴대폰", ["9761ef8c788de5307568", "748a17d031eacc8bb1b7"]],
  ["핸드폰", ["cbc9067c58c2d3fd8e7e", "7695f38ac14ad1acccef"]],
  ["가구원", ["f407b7f43923dfe25127", "ef890515dfaae9e7dc6d"]],
  ["가족 수", ["0ac53a3a3f32cfb032dc", "cf877e5a0ad976e467ad"]],
  ["이름", ["45f3769d32ad2457b690", "29fd5b84244c89288a35"]],
  ["성명", ["b704520ede5796f4c191", "b83499d5a087ccd80617"]],
  ["주소", ["6d96529fedae75982a7a", "827353b7356a353295ed"]],
  ["소득", ["e7137fdd2b1579cf6218", "d6d17c5eb3b760af07bd"]],
  ["재산", ["56ce834e0b75ada1f2cb", "30bc43e84a9fb6dde66f"]],
]);
export const practiceVocabulary = fieldVocabulary(createMockWelfareProfile("http://localhost:5174"));
const parser = new RuleBasedIntentProvider(practiceVocabulary);
for (const { alias, re, anyRe } of parser.aliases) {
  const ids = aliasIds.get(alias);
  if (ids === undefined) throw new Error(`missing alias regex: ${alias}`);
  rules.set(ids[0], re);
  rules.set(ids[1], anyRe);
}
rules.set("1fa16efbb4c7ad02d224", parser.commandBoundary);
rules.set("947b4d90ceb48e833ee6", new RuleBasedIntentProvider(["이름"]).commandBoundary);

export const ruleRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/understanding/rules.py", rules],
  ["src/cheongeum/understanding/filters.py", filters],
  ["src/cheongeum/understanding/sites.py", sites],
]);
