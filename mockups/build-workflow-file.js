/*
 * Builds speaking-workflow as ONE html file with every screen it opens embedded, so it can be
 * downloaded, emailed and opened from disk with no other files and no server.
 *
 *   node build-workflow-file.js [output-path]      (default: ../dist/speaking-workflow-all-in-one.html)
 */
var fs = require('fs');
var path = require('path');

var DIR = __dirname;
var OUT = process.argv[2] || path.join(DIR, '..', 'dist', 'speaking-workflow-all-in-one.html');

var page = fs.readFileSync(path.join(DIR, 'speaking-workflow.html'), 'utf8');

/* Every file the workflow page names in its STEPS list. */
var files = {};
(page.match(/file:'([^']+\.html)'/g) || []).forEach(function(m){ files[m.slice(6, -1)] = true; });

var screens = {};
Object.keys(files).forEach(function(f){
  screens[f] = fs.readFileSync(path.join(DIR, f), 'utf8');
});

/* Safe inside a <script>: no "</script" or "<!--" can end or confuse the block. */
var json = JSON.stringify(screens).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\u0021--');

var cut = page.indexOf('</style>') + '</style>'.length;
var out = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  + '<style>body{margin:0;font-size:14px}[hidden]{display:none!important}</style>\n'
  + page.slice(0, cut) + '\n</head>\n<body>\n'
  + '<script>window.SCREENS = ' + json + ';</script>\n'
  + page.slice(cut) + '\n</body>\n</html>\n';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log('embedded ' + Object.keys(screens).length + ' screens: ' + Object.keys(screens).join(', '));
console.log('wrote ' + OUT + ' (' + Math.round(out.length / 1024) + ' KB)');
