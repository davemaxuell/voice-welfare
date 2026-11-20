import { applicationPatterns, publicPatterns, replyPatterns, sessionPatterns } from "../../src/orchestrator/patterns.ts";

// 77aad3e의 session.py 정규식 지문과 제품 코드의 RegExp.
export const sessionRegexPorts77: ReadonlyMap<string, RegExp> = new Map([
  ["9742aed6e541dbfabb54", sessionPatterns.politeEnding],
  ["fdcadd2a0c1630a338e7", sessionPatterns.numberedChoice],
  ["298a1d30b0de9dd9d347", replyPatterns.sentenceGap],
  ["90feeb3c23410707885e", sessionPatterns.sentences],
  ["001a6cc5e7ca09430c03", sessionPatterns.sentenceGap],
  ["0b3cc849343a94fd64fa", sessionPatterns.applyMatch],
  ["4de30968bb430ad90929", sessionPatterns.declineSending],
  ["643023f6ed7baecd00d8", applicationPatterns.practice],
  ["6febb8527b1ad4684fc1", sessionPatterns.goThere],
  ["8a1ba202ce0b7b2e4e2e", replyPatterns.thisField],
  ["b3d28c2c7ac1695d07fd", sessionPatterns.profileCommand],
  ["6214c2c6a88b8833b37e", sessionPatterns.phraseEnd],
  ["8030d951893102ce10fd", sessionPatterns.answerTail],
  ["0eeafd6cc65e098170f7", sessionPatterns.hangul],
  ["95c29df09a17be96aeb5", sessionPatterns.digit],
  ["4e7d97ccd5d741ffc4a5", sessionPatterns.spaces],
  ["8a3cc43c0d46ce72b1a0", publicPatterns.followup],
  ["15fad4a625d2109778d2", replyPatterns.moreServices],
  ["47b281f3ae3997d983b4", replyPatterns.phone],
  ["a03a9b183f6d8b8bf8e4", publicPatterns.otherTask],
  ["8bb8d1bc74b2aa8aa404", applicationPatterns.pension],
  ["2660a3e7eee1dc175c7a", replyPatterns.phoneAsked],
  ["56fb235b013e60e92d8b", publicPatterns.nearby],
  ["7bc2d7bdbeb8dc45d497", replyPatterns.slowly],
]);
