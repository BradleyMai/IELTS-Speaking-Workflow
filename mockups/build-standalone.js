/*
 * Mockup sources are written for the artifact platform, which wraps them in its own
 * <!doctype html><head>…</head><body> skeleton at publish time. Opened straight from disk
 * that skeleton is missing, which breaks the pages two ways:
 *
 *   1. No DOCTYPE -> the browser falls into quirks mode -> percentage heights and the
 *      full-height flex layout collapse, giving every panel its own scrollbar.
 *   2. No `[hidden]{display:none!important}` -> elements with an explicit `display`
 *      (.screens is display:flex, .chip is inline-flex) ignore the hidden attribute,
 *      so hidden screens render on top of each other.
 *
 * This script wraps each source in a real HTML document so the files work offline.
 * Run it after changing any mockup:   node build-standalone.js
 */
var fs = require('fs');
var path = require('path');

var SRC = __dirname;
var OUT = process.argv[2]
  || 'C:\\Users\\admin\\OneDrive\\Documents\\IELTS SIM\\speaking-review-engine\\mockups';

var SKELETON = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<style>',
  '  :root{color-scheme:light}',
  '  html{-webkit-text-size-adjust:100%}',
  '  body{margin:0;font-size:14px}',
  '  img{max-width:100%}',
  '  [hidden]{display:none!important}',
  '</style>'
].join('\n');

var files = fs.readdirSync(SRC).filter(function(f){
  return f.endsWith('.html');
});

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

files.forEach(function(name){
  var src = fs.readFileSync(path.join(SRC, name), 'utf8');

  if (/^\s*<!doctype/i.test(src)){
    fs.writeFileSync(path.join(OUT, name), src);
    console.log('copied   ' + name + '  (already a full document)');
    return;
  }

  var cut = src.indexOf('</style>');
  if (cut === -1){
    console.log('SKIPPED  ' + name + '  (no <style> block found)');
    return;
  }
  cut += '</style>'.length;

  var head = src.slice(0, cut).trim();
  var body = src.slice(cut).trim();

  var out = SKELETON + '\n' + head + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  fs.writeFileSync(path.join(OUT, name), out);

  var title = (src.match(/<title>([^<]*)<\/title>/) || [])[1] || '(no title)';
  console.log('built    ' + name + '  ->  ' + title);
});

console.log('\nWrote ' + files.length + ' file(s) to:\n' + OUT);
