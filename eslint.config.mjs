import parser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import hooks from "eslint-plugin-react-hooks";
export default [{
  files: ["server/src/**/*.ts", "server/test/**/*.ts", "web/src/**/*.ts", "web/src/**/*.tsx", "web/test/**/*.tsx"],
  plugins: { "@typescript-eslint": tsPlugin, "react-hooks": hooks },
  languageOptions: { parser, parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } } },
  linterOptions: { reportUnusedDisableDirectives: "off" },
  rules: { "no-debugger": "error", "no-constant-binary-expression": "error", "no-dupe-else-if": "error", "no-duplicate-case": "error", "no-unsafe-finally": "error", "no-unreachable": "error" }
}];
