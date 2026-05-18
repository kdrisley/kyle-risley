// ESLint flat config.
//
// The `no-undef` rule is the static guard against the class of bug that broke
// the UCP Explorer: a reference to an undeclared variable (`step.innerHTML =
// html` where `html` no longer existed). It catches such mistakes without
// running anything.

'use strict';

module.exports = [
    {
        // Browser code: the UCP Explorer and the Pong game run in the page.
        files: ['tools/ucp-explorer/explore.js', 'pong/pong.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                document: 'readonly',
                window: 'readonly',
                fetch: 'readonly',
                navigator: 'readonly',
                setTimeout: 'readonly',
                requestAnimationFrame: 'readonly',
                console: 'readonly'
            }
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
        }
    },
    {
        // Node code: the test files.
        files: ['tools/ucp-explorer/*.test.js', 'pong/*.test.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'readonly',
                __dirname: 'readonly',
                process: 'readonly',
                global: 'readonly'
            }
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
        }
    }
];
