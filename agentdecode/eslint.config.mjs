import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "*.config.mjs",
      "*.config.ts",
      "scripts/**",
      "test_*.ts",
      "test-*.js",
      "*.mjs",
    ],
  },

  // Base TypeScript config
  ...tseslint.configs.recommended,

  // Project-specific overrides
  {
    rules: {
      // Allow `any` in specific cases (Supabase types, API handlers)
      "@typescript-eslint/no-explicit-any": "off",
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Allow empty catch blocks (used in fire-and-forget patterns)
      "@typescript-eslint/no-empty-function": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Relaxed rules for test files
  {
    files: ["**/__tests__/**", "**/*.test.*", "**/*.spec.*"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
