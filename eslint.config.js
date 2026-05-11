import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'data/', 'db/migrations/'] },
  ...tseslint.configs.recommended,
  prettier,
);
