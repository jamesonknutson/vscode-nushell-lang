/**@type {import('eslint').Linter.Config} */
// eslint-disable-next-line no-undef
module.exports = {
  extends: [
    '@jamesonknutson/eslint-config',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  root: true,
	parserOptions: {
    ecmaVersion: 'latest',
    project: ['./tsconfig.json', './client/tsconfig.json', './server/tsconfig.json'],
    // eslint-disable-next-line no-undef
    tsconfigRootDir: __dirname,
  },
};
