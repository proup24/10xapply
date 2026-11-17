const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

// Nest loads these optional packages lazily inside try/catch; the API uses
// none of them, so leave them out of the bundle instead of failing the build.
const optionalNest =
  /^(@nestjs\/(microservices|websockets)|class-validator|class-transformer)(\/|$)/;

module.exports = {
  externals: [
    ({ request }, callback) =>
      optionalNest.test(request ?? '')
        ? callback(null, `commonjs ${request}`)
        : callback(),
  ],
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      mergeExternals: true,
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
