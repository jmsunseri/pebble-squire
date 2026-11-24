var messageQueue = require('./lib/message_queue').Queue;
var bundleLoader = require('./lib/bundle_loader');
var telegram = require('./telegram');
var isExcludedMessage = require('./message_filter').isExcludedMessage;

// Entries kept for the Conversation view and for seeding a new question.
var HISTORY_LIMIT = 8;
// Questions offered by Ask Again. The watch keeps its own ring of this size.
var RECENT_PROMPT_LIMIT = 10;
// One getMessages call feeds both lists. This is still a single request; the
// larger limit just gives us enough turns to find ten questions.
var HISTORY_FETCH_LIMIT = 60;
var CACHE_KEY = 'ask_again_history';

// A duplicate watch request arriving just after a completed fetch does not
// need another round trip.
var DUPLICATE_REQUEST_WINDOW_MS = 3000;

var fetching = false;
var lastCompletedAt = 0;

function formatLoggedMessage(message) {
    if (!message) return '';
    var withoutSystem = message.replace(/<system>[\s\S]*?<\/system>/g, '').trim();
    if (withoutSystem.length <= 100) return withoutSystem;
    return withoutSystem.substring(0, 50) + '...' + withoutSystem.substring(withoutSystem.length - 50);
}

function batchHasSystemBlock(messages) {
    for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (msg && msg.message && msg.message.indexOf('<system>') !== -1) {
            return true;
        }
    }
    return false;
}

// Telegram's `out` flag is unreliable in the bot chat. When any message has the
// system block, only prompts carry it. Otherwise fall back to the thread marker
// or `out` for older history.
function isOwnMessage(msg, hasSystemBlock) {
    var text = msg.message;
    return hasSystemBlock
        ? text.indexOf('<system>') !== -1
        : (text.indexOf('[thread:') === 0 || msg.out === true || msg.out === 1);
}

function promptTextFromMessage(msg, hasSystemBlock) {
    if (!isOwnMessage(msg, hasSystemBlock)) return null;

    var promptText = msg.message;
    if (promptText.indexOf('[thread:') === 0) {
        var markerEnd = promptText.indexOf('] ');
        if (markerEnd !== -1) {
            promptText = promptText.substring(markerEnd + 2);
        }
    }
    promptText = promptText.replace(/\s*<system>[\s\S]*?<\/system>\s*/, '').trim();
    if (promptText.length === 0 || isExcludedMessage(promptText)) return null;
    return promptText;
}

function buildHistory(messages) {
    var hasSystemBlock = batchHasSystemBlock(messages);
    var historyEntries = [];
    for (var i = 0; i < messages.length && historyEntries.length < HISTORY_LIMIT; i++) {
        var msg = messages[i];
        if (!msg || !(msg.message && msg.message.length > 0)) {
            if (msg && msg.out !== true && msg.out !== 1) {
                console.log('[history] bot empty msg _text=' + JSON.stringify(msg._text) + ' media=' + (msg.media ? msg.media.className : 'none') + ' action=' + (msg.action ? msg.action.className : 'none'));
            }
            continue;
        }

        var text = msg.message;
        console.log('[history] raw message out=', msg.out, 'text=', formatLoggedMessage(text));

        if (isOwnMessage(msg, hasSystemBlock)) {
            var promptText = promptTextFromMessage(msg, hasSystemBlock);
            if (promptText) {
                historyEntries.push({ type: 'prompt', text: promptText });
            }
        } else if (!isExcludedMessage(text)) {
            historyEntries.push({ type: 'response', text: text });
        }
    }

    var threadId = null;
    for (var j = 0; j < messages.length; j++) {
        var m = messages[j];
        if (m && m.message && m.message.indexOf('[thread:') === 0) {
            var end = m.message.indexOf(']');
            if (end !== -1) {
                threadId = m.message.substring('[thread:'.length, end);
                break;
            }
        }
    }

    return { entries: historyEntries, threadId: threadId };
}

// Newest first, independent of the smaller interleaved history window. Each
// question appears once: walking newest-first keeps the most recent occurrence.
function buildRecentPrompts(messages) {
    var hasSystemBlock = batchHasSystemBlock(messages);
    var prompts = [];
    var seen = Object.create(null);
    for (var i = 0; i < messages.length && prompts.length < RECENT_PROMPT_LIMIT; i++) {
        var msg = messages[i];
        if (!msg || !(msg.message && msg.message.length > 0)) continue;
        var promptText = promptTextFromMessage(msg, hasSystemBlock);
        if (promptText && !seen[promptText]) {
            seen[promptText] = true;
            prompts.push(promptText);
        }
    }
    return prompts;
}

function saveCache(history, prompts) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            entries: history.entries,
            threadId: history.threadId,
            prompts: prompts
        }));
    } catch (err) {
        console.error('[history] Failed to cache history: ' + (err.message || err));
    }
}

function loadCache() {
    try {
        var raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        var cache = JSON.parse(raw);
        if (!cache || !Array.isArray(cache.entries) || !Array.isArray(cache.prompts)) {
            return null;
        }
        return cache;
    } catch (err) {
        console.error('[history] Failed to read history cache: ' + (err.message || err));
        return null;
    }
}

function sendHistory(history, prompts) {
    // Every batch starts with a reset so a retried request cannot append a
    // second copy of the same conversation.
    messageQueue.enqueue({ HISTORY_RESET: 1 });

    if (history.threadId) {
        messageQueue.enqueue({ HISTORY_THREAD_ID: history.threadId });
    }

    for (var k = history.entries.length - 1; k >= 0; k--) {
        var entry = history.entries[k];
        if (entry.type === 'prompt') {
            messageQueue.enqueue({ HISTORY_PROMPT: entry.text });
        } else {
            messageQueue.enqueue({ HISTORY_RESPONSE: entry.text });
        }
    }

    // Oldest first so the watch ring ends with the newest prompt last.
    for (var p = prompts.length - 1; p >= 0; p--) {
        messageQueue.enqueue({ RECENT_PROMPT: prompts[p] });
    }

    sendHistoryDone();
}

function sendCachedHistory() {
    var cache = loadCache();
    if (!cache) {
        sendHistoryDone();
        return;
    }
    console.log('[history] Replaying cached history: ' + cache.entries.length + ' entries, ' + cache.prompts.length + ' prompts');
    sendHistory(cache, cache.prompts);
}

function finishFetch() {
    fetching = false;
    lastCompletedAt = Date.now();
}

function fetchAndSendHistory(force) {
    if (fetching) {
        console.log('[history] Fetch already in progress');
        return;
    }
    if (!force && lastCompletedAt && Date.now() - lastCompletedAt < DUPLICATE_REQUEST_WINDOW_MS) {
        console.log('[history] Ignoring duplicate history request');
        return;
    }

    if (!telegram.hasSession()) {
        console.log('[history] No Telegram session, skipping history fetch');
        sendHistoryDone();
        finishFetch();
        return;
    }

    bundleLoader.ensureTelegramBundle();

    if (typeof TelegramClient === 'undefined') {
        console.log('[history] TelegramClient not available after bundle load');
        sendCachedHistory();
        finishFetch();
        return;
    }

    fetching = true;

    telegram.initClient().then(function() {
        var client = telegram.getClient();
        var botUsername = telegram.getBotUsername();
        if (!botUsername) {
            console.log('[history] No bot username configured');
            sendCachedHistory();
            return null;
        }
        var cleanUsername = botUsername.replace(/^@/, '');

        return client.getMessages(cleanUsername, { limit: HISTORY_FETCH_LIMIT }).then(function(messages) {
            console.log('[history] total messages returned: ' + (messages ? messages.length : 0));
            if (!messages || messages.length === 0) {
                console.log('[history] No messages found');
                sendCachedHistory();
                return;
            }

            for (var d = 0; d < Math.min(messages.length, 3); d++) {
                var dm = messages[d];
                if (dm.out === false || dm.out === 0) {
                    console.log('[history] bot msg _text=' + JSON.stringify(dm._text) + ' originalArgs=' + JSON.stringify(dm.originalArgs));
                }
            }

            var history = buildHistory(messages);
            var recentPrompts = buildRecentPrompts(messages);

            if (history.entries.length === 0 && recentPrompts.length === 0) {
                console.log('[history] No usable history entries');
                sendCachedHistory();
                return;
            }

            saveCache(history, recentPrompts);
            sendHistory(history, recentPrompts);
        });
    }).catch(function(err) {
        console.error('[history] Failed to fetch messages: ' + (err.message || err));
        sendCachedHistory();
    }).then(function() {
        finishFetch();
    });
}

function sendHistoryDone() {
    messageQueue.enqueue({ HISTORY_DONE: 1 });
}

exports.fetchAndSendHistory = fetchAndSendHistory;
exports.buildHistory = buildHistory;
exports.buildRecentPrompts = buildRecentPrompts;
