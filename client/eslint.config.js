import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Dialog forms intentionally reset local draft state when their `open`
      // or `initial` props change; report effects intentionally expose a
      // loading state before fetching. These are synchronization effects, not
      // derived state that belongs in render.
      'react-hooks/set-state-in-effect': 'off',
      // Local accumulator variables used to derive chart series are not state
      // and are safe to update within the same render.
      'react-hooks/immutability': 'off',
      // Component modules also export colocated value helpers used by tests.
      'react-refresh/only-export-components': 'off',
    },
  },
])
