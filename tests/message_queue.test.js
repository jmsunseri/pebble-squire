import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'dotenv/config';

describe('MessageQueue chunking', () => {
    let sendAppMessage;
    let Queue;

    beforeEach(() => {
        sendAppMessage = vi.fn((msg, success, failure) => {
            if (success) success();
        });
        global.Pebble = { sendAppMessage };

        // Re-require with a fresh module cache so the queue starts empty.
        var path = require.resolve('../src/pkjs/lib/message_queue.js');
        delete require.cache[path];
        Queue = require('../src/pkjs/lib/message_queue.js').Queue;
    });

    it('sends a small CHAT in one message', () => {
        Queue.enqueue({ CHAT: 'hello' });
        expect(sendAppMessage).toHaveBeenCalledTimes(1);
        expect(sendAppMessage.mock.calls[0][0].CHAT).toBe('hello');
    });

    it('chunks a large CHAT into multiple messages', () => {
        // Build a payload well over MAX_CHAT_CHUNK_SIZE (4000).
        var big = '';
        for (var i = 0; i < 10000; i++) big += 'x';
        Queue.enqueue({ CHAT: big });

        expect(sendAppMessage.mock.calls.length).toBeGreaterThan(1);
        var reassembled = '';
        for (var c = 0; c < sendAppMessage.mock.calls.length; c++) {
            reassembled += sendAppMessage.mock.calls[c][0].CHAT;
        }
        expect(reassembled).toBe(big);
    });

    it('preserves order of surrounding messages around a chunked CHAT', () => {
        var big = '';
        for (var i = 0; i < 5000; i++) big += 'y';
        Queue.enqueue({ CHAT: big });
        Queue.enqueue({ CHAT_DONE: true });

        var keys = sendAppMessage.mock.calls.map(function(c) { return Object.keys(c[0])[0]; });
        var lastKey = keys[keys.length - 1];
        expect(lastKey).toBe('CHAT_DONE');
    });
});