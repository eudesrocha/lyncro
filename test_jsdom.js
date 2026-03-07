const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('public/guest.html', 'utf8');
const script = fs.readFileSync('public/js/guest.js', 'utf8');

const dom = new JSDOM(html, {
    url: 'http://localhost/guest.html?room=test&name=Test',
    runScripts: 'outside-only'
});

dom.window.navigator.mediaDevices = {
    enumerateDevices: async () => [],
    getUserMedia: async () => ({
        getVideoTracks: () => [{ getSettings: () => ({ facingMode: 'user' }) }],
        getAudioTracks: () => [{ getSettings: () => ({}) }]
    })
};
dom.window.localStorage = { getItem: () => null, setItem: () => null };

dom.window.onerror = function (msg, src, lineno, colno, err) {
    console.log('UNCAUGHT EXCEPTION IN BROWSER:', msg, 'at line', lineno, ':', colno);
};

try {
    dom.window.eval(script);
    console.log('Script evaluated successfully without throwing inside Eval.');
} catch (e) {
    console.log('EVAL THREW AN ERROR:', e.stack);
}

// wait for promises
setTimeout(() => {
    console.log('Done.');
}, 2000);
