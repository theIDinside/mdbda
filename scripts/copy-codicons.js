// Copies the codicon font and stylesheet from @vscode/codicons into media/codicons, where the webview loads them.
'use strict';

const fs = require('fs');
const path = require('path');

const packageDir = path.dirname(require.resolve('@vscode/codicons/package.json'));
const target = path.resolve(__dirname, '..', 'media', 'codicons');

fs.mkdirSync(target, { recursive: true });
for (const [from, to] of [
  ['dist/codicon.css', 'codicon.css'],
  ['dist/codicon.ttf', 'codicon.ttf'],
  ['LICENSE', 'LICENSE'],
]) {
  fs.copyFileSync(path.join(packageDir, from), path.join(target, to));
}
