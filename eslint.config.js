import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // apps/* are separate Next.js packages with their own lint/tsconfig; the root
  // gate (tsc + eslint over db/src/config/tests) does not cover them.
  { ignores: ['dist/', 'node_modules/', 'data/', 'db/migrations/', 'apps/'] },
  ...tseslint.configs.recommended,
  prettier,
);
