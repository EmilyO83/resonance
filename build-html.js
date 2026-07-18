// Regenerates appHtml.js from web/index.html so the packaged app always matches
// the browser version. The whole UI + audio engine is that single HTML file;
// the native app wraps it in a WebView (see App.js).
//
//   node build-html.js
//
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'web', 'index.html');
const OUT = path.join(__dirname, 'appHtml.js');

let html = fs.readFileSync(SRC, 'utf8');

// Escape so the HTML is safe inside a JS template literal:
// backslash first, then backtick, then ${ interpolation start.
html = html
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const out =
  '// AUTO-GENERATED from web/index.html. Do not edit by hand.\n' +
  '// Regenerate after changing web/index.html:  node build-html.js\n' +
  'export const HTML = `' + html + '`;\n';

fs.writeFileSync(OUT, out);
console.log('appHtml.js written:', (out.length / 1024).toFixed(1), 'KB');
