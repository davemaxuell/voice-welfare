import { privacyPatterns as p } from "../../src/safety/privacy.ts";

export const privacyRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/safety/privacy.py", new Map([
    ["196157843bca502fcd39", p.cardValue], ["cc77fd314ea688140e52", p.otpKo],
    ["81e3aa53cad6c5cbc919", p.password], ["e141c7729b5450dbe5ec", p.otp],
    ["dc049b3f316c8ba46631", p.account], ["d7267e56e625269d34fa", p.healthQuestion],
    ["74077f614e5d25da7912", p.passwordKo], ["259a3207e97591a77808", p.idnum],
    ["7f4359866e99f3517c33", p.rrn], ["f6188858b6c21439237a", p.health],
    ["aca35c9f47dd2bd2cdbb", p.card], ["f9b50b31961323564693", p.separators],
    ["e63aeb9d4a366394081b", p.latinWord], ["cd7547279d874b7175ae", p.offerValue],
    ["0eeafd6cc65e098170f7", p.hangul], ["3152c46cf6b12374caa5", p.spoken],
    ["d011bf7617c33e095f50", p.healthParticles], ["c4cd9d0cd103e7dd2b63", p.nonDigit],
    ["95c29df09a17be96aeb5", p.digit], ["180e79e3ed38b157c2c2", p.spokenCard],
    ["21e3d35c6146fb53d63d", p.spokenRrn], ["966f7ec0edea73a2fcd2", p.rrnValue],
    ["8995377d176f3e47b42f", p.lead], ["1998586c0c767fae89b6", p.offer],
    ["c6b58a62e7721c90225e", p.aboutIt], ["9d2de3b3686bc15c9d8f", p.endingOnly],
  ])],
]);
