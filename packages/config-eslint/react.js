import reactHooksPlugin from 'eslint-plugin-react-hooks'
import baseConfig from './index.js'

export default [
  ...baseConfig,
  {
    files: ['**/*.tsx', '**/*.jsx'],
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
    },
  },
]
