import { describe, it, expect, vi, afterEach } from 'vitest';

const { isExcludedMessage } = require('../src/pkjs/message_filter');
const { buildHistory } = require('../src/pkjs/history');
const Queue = require('../src/pkjs/lib/message_queue').Queue;
const { Session } = require('../src/pkjs/session');

describe('excluded Telegram messages', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('matches the opening text, including leading whitespace', () => {
        expect(isExcludedMessage('Self-improvement review: be better')).toBe(true);
        expect(isExcludedMessage('\n  Self-improvement review: be better')).toBe(true);
        expect(isExcludedMessage('The Self-improvement review: is later')).toBe(false);
        expect(isExcludedMessage('Self-improvement review without a colon')).toBe(false);
        expect(isExcludedMessage(undefined)).toBe(false);
        expect(isExcludedMessage(null)).toBe(false);
    });

    it('matches an emoji or decoration before the opening text', () => {
        expect(isExcludedMessage('\uD83D\uDD04 Self-improvement review: notes')).toBe(true);
        expect(isExcludedMessage('\uD83D\uDD04\uFE0F  Self-improvement review: notes')).toBe(true);
        expect(isExcludedMessage('\u2705 Self-improvement review: notes')).toBe(true);
        expect(isExcludedMessage('\u2022 Self-improvement review: notes')).toBe(true);
        expect(isExcludedMessage('\u0031\uFE0F\u20E3 Self-improvement review: notes')).toBe(true);
    });

    it('matches Working — anywhere in the message', () => {
        expect(isExcludedMessage('Working \u2014 3 minutes')).toBe(true);
        expect(isExcludedMessage('Agent: Working \u2014 3 minutes')).toBe(true);
        expect(isExcludedMessage('Working - 3 minutes')).toBe(false);
    });

    it('is not added to history from either direction', () => {
        const messages = [
            { out: false, message: 'Self-improvement review: bot notes' },
            { out: false, message: 'Working \u2014 still thinking' },
            { out: false, message: 'A real answer' },
            { out: true, message: '[thread:abc] <system>ctx</system>\n\nSelf-improvement review: prompt notes' },
            { out: true, message: '[thread:abc] <system>ctx</system>\n\nA real question' }
        ];

        const history = buildHistory(messages);
        expect(history.entries).toEqual([
            { type: 'response', text: 'A real answer' },
            { type: 'prompt', text: 'A real question' }
        ]);
        expect(history.threadId).toBe('abc');
    });

    it('prefers the prompt marker when out is unreliable', () => {
        const messages = [
            { out: true, message: 'A bot reply' },
            { out: true, message: '[thread:abc] <system>ctx</system>\n\nMy question' }
        ];

        const history = buildHistory(messages);
        expect(history.entries).toEqual([
            { type: 'response', text: 'A bot reply' },
            { type: 'prompt', text: 'My question' }
        ]);
    });

    it('does not treat a thread marker alone as a prompt when system blocks exist', () => {
        const messages = [
            { out: true, message: '[thread:abc] A bot reply' },
            { out: true, message: '[thread:abc] <system>ctx</system>\n\nMy question' }
        ];

        const history = buildHistory(messages);
        expect(history.entries).toEqual([
            { type: 'response', text: '[thread:abc] A bot reply' },
            { type: 'prompt', text: 'My question' }
        ]);
    });

    it('is never queued for the watch from a live response', () => {
        const enqueue = vi.spyOn(Queue, 'enqueue');
        const session = new Session('hello', null);

        session.handleIncomingMessage('Self-improvement review: bot notes', () => {});
        session.handleIncomingMessage('Working \u2014 3 minutes', () => {});

        expect(enqueue).not.toHaveBeenCalled();
        expect(session.hasOpenDialog).toBe(false);
    });

    it('still queues normal live responses', () => {
        const enqueue = vi.spyOn(Queue, 'enqueue');
        const session = new Session('hello', null);

        session.handleIncomingMessage('Hello there', () => {});
        clearTimeout(session._doneTimer);

        expect(enqueue).toHaveBeenCalledWith({ CHAT: 'Hello there' });
    });
});
