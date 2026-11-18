import tseslint from "typescript-eslint";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", ".audit/**", ".venv/**", "models/**", "test-results/**", "reports/**", "scripts/vendor/**", "src/cheongeum/**", "apps/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/require-array-sort-compare": ["error", { ignoreStringArrays: false }],
      "@typescript-eslint/strict-boolean-expressions": ["error", { allowNumber: false, allowString: false }],
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.property.name='split'][arguments.length>=2]", message: "Python split의 maxsplit은 나머지 문자열을 보존합니다." },
        { selector: "CallExpression[callee.property.name='lastIndexOf'][arguments.length>=2]", message: "Python rfind의 끝 위치는 검색 대상에서 제외됩니다." },
      ],
    },
  },
];
