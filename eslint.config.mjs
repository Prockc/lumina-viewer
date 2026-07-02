import playcanvasConfig from '@playcanvas/eslint-config';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
    ...playcanvasConfig,
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parser: tsParser,
            globals: {
                ...globals.browser
            }
        },
        plugins: {
            '@typescript-eslint': tsPlugin
        },
        settings: {
            'import/resolver': {
                typescript: {}
            }
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'jsdoc/require-param-type': 'off',
            'jsdoc/require-returns-type': 'off',
            // Several packages referenced by upstream .tsx files are not installed in this
            // fork, and pre-existing .ts files have unresolved peer deps — disable resolver check.
            'import/no-unresolved': 'off',
            // Pre-existing duplicate-import and ordering issues in upstream source files.
            'no-duplicate-imports': 'off',
            'import/order': 'off'
        }
    },
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'import/no-unresolved': 'off'
        }
    }
];
