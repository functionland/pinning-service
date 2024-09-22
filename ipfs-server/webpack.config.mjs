import path from 'path';
import { fileURLToPath } from 'url';
import nodeExternals from 'webpack-node-externals';
import webpack from 'webpack';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  entry: './server.js',
  target: 'node',
  externals: [
    nodeExternals(),
    'firebase-admin',
    'file-type',
    'uint8array-extras',
    '@sec-ant/readable-stream',
    'get-stream',
    'supports-color'
  ],
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env'],
            plugins: ['@babel/plugin-syntax-import-attributes']
          }
        }
      },
      {
        test: /\.json$/,
        loader: 'json-loader',
        type: 'javascript/auto'
      }
    ]
  },
  plugins: [
    new webpack.ProvidePlugin({
      kuboRpcClient: 'kubo-rpc-client'
    }),
    new CopyPlugin({
      patterns: [
        { from: '../firebase.json', to: 'firebase.json' }
      ],
    })
  ],
  resolve: {
    fallback: {
      "stream": 'stream-browserify',
      "buffer": 'buffer',
      "crypto": 'crypto-browserify'
    }
  }
};