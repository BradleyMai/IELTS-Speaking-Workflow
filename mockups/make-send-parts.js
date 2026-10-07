/*
 * interview-send-part-1/2/3.html are interview-send-full.html with one line changed:
 * `var ONLY = null;` becomes 0, 1 or 2. Edit the full file, then run:
 *
 *   node make-send-parts.js
 */
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, 'interview-send-full.html'), 'utf8');
if (src.indexOf('var ONLY = null;') === -1) throw new Error('ONLY marker not found in interview-send-full.html');

[0, 1, 2].forEach(function(i){
  var name = 'interview-send-part-' + (i + 1) + '.html';
  var out = src
    .replace('var ONLY = null;', 'var ONLY = ' + i + ';')
    .replace('<title>IELTS mock interview send full</title>', '<title>IELTS mock interview send part ' + (i + 1) + '</title>')
    .replace('Full test · Parts 1, 2 and 3 in order', 'Practising Part ' + (i + 1));
  fs.writeFileSync(path.join(__dirname, name), out);
  console.log('wrote ' + name);
});
