// guest-chat.js — Chat, Typing Indicator e Room Status do Guest
// Depende dos globais: ws, roomName, userName (declarados em guest.js)

const chatPanel = document.getElementById('chat-panel');
const toggleChatBtn = document.getElementById('toggleChat');
const closeChatBtn = document.getElementById('closeChat');
const chatBadge = document.getElementById('chat-badge');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const sendChatBtn = document.getElementById('send-chat');

if (toggleChatBtn) {
    toggleChatBtn.onclick = () => {
        chatPanel.classList.toggle('hidden');
        if (chatBadge) chatBadge.classList.add('hidden');
    };
}
if (closeChatBtn) {
    closeChatBtn.onclick = () => chatPanel.classList.add('hidden');
}

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (text && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'chat',
            roomId: roomName,
            name: userName,
            text: text,
            timestamp: Date.now()
        }));
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
            ws.send(JSON.stringify({ type: 'chat-typing', roomId: roomName, name: userName, isTyping: true }));
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'chat-typing', roomId: roomName, name: userName, isTyping: false }));
            }
        }, 1500);
    });
}

function handleTypingIndicator(name, isTyping) {
    if (name === userName) return;
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

// --- Room Status (Contagem de participantes + Host Offline) ---
let hadHostBefore = false;
function updateRoomStatus(participants) {
    const countEl = document.getElementById('room-count');
    const badgeEl = document.getElementById('room-status-badge');
    const visibleParticipants = participants.filter(p => p.role !== 'observer');

    if (countEl) countEl.textContent = visibleParticipants.length;

    const hostPresent = visibleParticipants.some(p => p.role === 'host');

    if (badgeEl) {
        if (hostPresent) {
            badgeEl.classList.remove('text-red-400');
            badgeEl.classList.add('text-gray-300');
            badgeEl.title = 'Participantes na sala';
            hadHostBefore = true;
        } else {
            badgeEl.classList.remove('text-gray-300');
            badgeEl.classList.add('text-red-400');
            badgeEl.title = 'Produtor offline';

            if (hadHostBefore) {
                appendChatMessage('Sistema', '⚠️ O Produtor saiu da sala.', Date.now());
            }
        }
    }
}

function appendChatMessage(name, text, time) {
    if (!chatMessages) return;
    const msg = document.createElement('div');
    const isMe = name === userName;
    msg.className = `flex flex-col max-w-[85%] ${isMe ? 'self-end items-end' : 'self-start items-start'}`;

    const timeStr = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    msg.innerHTML = `
        <span class="text-[10px] text-gray-400 mb-0.5 px-1">${name} • ${timeStr}</span>
        <div class="px-3 py-1.5 rounded-lg shadow-md ${isMe ? 'bg-win-accent text-white rounded-br-none' : 'bg-win-surface border border-win-border text-gray-200 rounded-bl-none'} text-sm">
            ${text}
        </div>
    `;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
