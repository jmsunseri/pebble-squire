/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var MAX_BYTES_IN_FLIGHT = 400;

// The watch allocates SQUIRE_APP_MESSAGE_BUFFER_SIZE (5000) bytes for its
// app-message inbox/outbox (see src/c/converse/conversation_manager.c). A
// single app message must fit within that budget or it gets dropped, so we
// chunk any large CHAT payload into pieces below this limit. The watch's
// conversation layer reassembles CHAT fragments by appending them to the
// last open response (see conversation_add_response_fragment), so splitting
// is transparent to the UI.
var MAX_CHAT_CHUNK_SIZE = 4000;

function MessageQueue() {
    this.queue = [];
    this.messagesInFlight = 0;
    this.bytesInFlight = 0;
}

function countBytes(message) {
    var bytes = 0;
    for (var key in message) {
        if (message.hasOwnProperty(key)) {
            var value = message[key];
            if (typeof value === 'string') {
                bytes += value.length;
            } else if (typeof value === 'number') {
                bytes += 4; // 4 bytes for numbers
            } else if (typeof value == 'boolean') {
                bytes += 1; // 1 byte for boolean
            } else if (Array.isArray(value)) {
                bytes += value.length; // 1 byte per array element
            } else if (value instanceof Uint8Array) {
                bytes += value.length; // 1 byte per array element
            }
            bytes += 12; // space for some overhead for the key.
        }
    }
    return bytes;
}

// Keys whose string payloads the watch reassembles across multiple app
// messages. For CHAT the conversation layer appends each fragment to the
// last open response (conversation_add_response_fragment), so a long agent
// reply can be safely split into several smaller app messages.
var REASSEMBLABLE_KEYS = ['CHAT'];

MessageQueue.prototype.enqueue = function(message) {
    this.queue.push(message);
    this.pump();
}

MessageQueue.prototype.pump = function() {
    if (this.messagesInFlight >= 6 || this.bytesInFlight >= MAX_BYTES_IN_FLIGHT) {
        console.log('enqueued, queue length: ' + this.queue.length + ', bytes: ' + this.bytesInFlight);
        return;
    }
    var message = this.queue.shift();
    if (!message) return;

    var self = this;
    function send(msg) {
        var mSize = countBytes(msg);
        if (mSize > 5000) {
            console.warn('message exceeds 5000-byte watch inbox limit (' + mSize + ' bytes), will likely be dropped');
        }
        console.log('sending message, remaining: ' + self.queue.length + ', bytes in flight: ' + self.bytesInFlight);
        self.messagesInFlight++;
        self.bytesInFlight += mSize;
        Pebble.sendAppMessage(msg, (function() {
            self.messagesInFlight--;
            self.bytesInFlight -= mSize;
            console.log('sent successfully');
            if (self.queue.length > 0) {
                if (self.bytesInFlight > MAX_BYTES_IN_FLIGHT) {
                    console.log('still too many bytes in flight (' + self.bytesInFlight + '), waiting');
                } else {
                    self.pump();
                }
            } else {
                console.log('done');
            }
        }).bind(self), (function() {
            self.messagesInFlight--;
            self.bytesInFlight -= mSize;
            console.log('failed, message lost. carrying on shortly.');
            if (self.queue.length > 0) {
                setTimeout(function() { self.pump(); }, 10);
            } else {
                console.log('done');
            }
        }).bind(self));
    }

    // Split oversized reassemblable payloads into chunks the watch can accept.
    for (var i = 0; i < REASSEMBLABLE_KEYS.length; i++) {
        var key = REASSEMBLABLE_KEYS[i];
        if (message.hasOwnProperty(key) && typeof message[key] === 'string' &&
            message[key].length > MAX_CHAT_CHUNK_SIZE) {
            var full = message[key];
            var chunks = [];
            for (var offset = 0; offset < full.length; offset += MAX_CHAT_CHUNK_SIZE) {
                chunks.push(full.substring(offset, offset + MAX_CHAT_CHUNK_SIZE));
            }
            console.log('chunking ' + key + ' (' + full.length + ' bytes) into ' + chunks.length + ' pieces');
            // unshift in reverse so they come off the front in order.
            for (var c = chunks.length - 1; c >= 0; c--) {
                this.queue.unshift({ CHAT: chunks[c] });
            }
            this.pump();
            return;
        }
    }

    send(message);
}

exports.Queue = new MessageQueue();
