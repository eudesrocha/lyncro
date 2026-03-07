// host-chat.js — Chat e Typing Indicator do Host
// Depende dos globais: ws, roomName (declarados em host.js)

const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const sendChatBtn = document.getElementById('send-chat');

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (text && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat', roomId: roomName, name: 'Produção (Host)', text: text, timestamp: Date.now() }));
        chatInput.value = '';
    }
}

if (sendChatBtn) sendChatBtn.onclick = sendChatMessage;
if (chatInput) chatInput.onkeypress = (e) => { if (e.key === 'Enter') sendChatMessage(); };

// --- Typing Indicator ---
let typingTimeout = null;
const typingIndicatorEl = document.getElementById('typing-indicator');
const typingUsers = new Set();

if (chatInput) {
    chatInput.addEventListener('input', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'chat-typing', roomId: roomName, name: 'Produção (Host)', isTyping: true }));
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'chat-typing', roomId: roomName, name: 'Produção (Host)', isTyping: false }));
            }
        }, 1500);
    });
}

function handleTypingIndicator(name, isTyping) {
    if (name === 'Produção (Host)') return; // Ignore own typing
    if (isTyping) {
        typingUsers.add(name);
    } else {
        typingUsers.delete(name);
    }
    if (typingIndicatorEl) {
        if (typingUsers.size > 0) {
            const names = Array.from(typingUsers).join(', ');
            typingIndicatorEl.textContent = `${names} está digitando...`;
            typingIndicatorEl.classList.remove('hidden');
        } else {
            typingIndicatorEl.classList.add('hidden');
        }
    }
}

function appendChatMessage(name, text, time) {
    if (!chatMessages) return;
    const msg = document.createElement('div');
    const isMe = name === 'Produção (Host)';
    msg.className = `flex flex-col max-w-[90%] ${isMe ? 'self-end items-end' : 'self-start items-start'}`;
    const timeStr = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    msg.innerHTML = `
        <span class="text-[9px] text-gray-500 mb-1 px-1 font-bold uppercase tracking-tighter">${name} • ${timeStr}</span>
        <div class="px-4 py-2 rounded-win shadow-lg ${isMe ? 'bg-win-accent text-white border-none' : 'bg-black/40 border border-win-border/60 text-gray-200'} text-sm leading-relaxed">
            ${text}
        </div>
    `;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
