const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/*'] },
  {
    files: ['src/screens/production-app.tsx'],
    // Async SQLite/Supabase loaders update state after awaited I/O. The React
    // compiler rule currently reports those deferred calls as synchronous.
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
]);
