const fs = require('fs');
const html = fs.readFileSync('public/guest.html', 'utf8');
const js = fs.readFileSync('public/js/guest.js', 'utf8');

const r = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
let match;
while (match = r.exec(js)) {
    const id = match[1];
    if (!html.includes('id=\"' + id + '\"') && !html.includes('id=\'' + id + '\'')) {
        console.log('Missing: ' + id);
    }
}
