import { plannerRegexPorts } from "./planner-regex.ts";
import { ruleRegexPorts } from "./understanding-rules-regex.ts";

// Python 파일별로 지문과 제품 코드에서 가져온 RegExp를 짝짓는다. 같은 식을 다른 파일이 따로 옮길 수 있다.
export const regexPorts: ReadonlyMap<string, ReadonlyMap<string, RegExp>> = new Map([...ruleRegexPorts, ...plannerRegexPorts]);
