import { guardPatterns } from "../../src/safety/guard.ts";
import { verifyPatterns } from "../../src/safety/verify.ts";

export const policyRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/safety/guard.py", new Map([
    ["f2535029b5f430e38d1f", guardPatterns.secretLabel],
    ["938ece3aec8318056539", guardPatterns.loginName],
    ["f71271ab0baca0ff43c2", guardPatterns.riskyButton],
    ["ad500265a989e613b279", guardPatterns.actionAnywhere],
    ["712c845c28f5f7d8e236", guardPatterns.actionEnding],
    ["a98fed6b2c0bd0fac2be", guardPatterns.trailingNoise],
    ["4e7d97ccd5d741ffc4a5", guardPatterns.spaces],
  ])],
  ["src/cheongeum/safety/verify.py", new Map([
    ["777635cb115c3c110d82", verifyPatterns.punctuation],
    ["7a760f396897c39a9c88", verifyPatterns.code],
    ["05e4d368ded00e960e25", verifyPatterns.thousands],
    ["d6796e6d02e658de34a9", verifyPatterns.decimal],
    ["1fdbd689866d2a806b35", verifyPatterns.number],
    ["c4cd9d0cd103e7dd2b63", verifyPatterns.nonDigit],
    ["73d50186dd136b0427d0", verifyPatterns.codeSeparator],
    ["6137d98c5f0d96d708cd", verifyPatterns.blank],
    ["d45d0fc9062aa3d9343b", verifyPatterns.date],
  ])],
]);
