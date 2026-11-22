import base from "../../vitest.config.ts";

const { test } = base;
const e2e = test.projects.find(project => project.test.name === "e2e");
export default { ...base, test: { ...test, projects: [{ ...e2e, test: {
  ...e2e.test, setupFiles: ["trial/stagehand/guard-setup.mjs"],
} }] } };
