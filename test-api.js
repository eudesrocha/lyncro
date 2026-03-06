fetch('https://lyncro.live/api/rooms')
    .then(r => r.text().then(text => ({ status: r.status, ok: r.ok, body: text })))
    .then(data => console.log('Result:', data))
    .catch(err => console.error('Fetch error:', err));
