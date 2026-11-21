/**
 * Messages from Telegram that must never be forwarded to the watch.
 *
 * These are matched on the opening text. Leading whitespace is ignored so a
 * message that starts with a newline is still caught.
 */
var EXCLUDED_PREFIXES = [
    'Self-improvement review:'
];

var EXCLUDED_SUBSTRINGS = [
    'Working \u2014'
];

function isExcludedMessage(text) {
    if (typeof text !== 'string') return false;
    var trimmed = text.replace(/^\s+/, '');
    for (var i = 0; i < EXCLUDED_PREFIXES.length; i++) {
        if (trimmed.indexOf(EXCLUDED_PREFIXES[i]) === 0) {
            return true;
        }
    }
    for (var j = 0; j < EXCLUDED_SUBSTRINGS.length; j++) {
        if (trimmed.indexOf(EXCLUDED_SUBSTRINGS[j]) !== -1) {
            return true;
        }
    }
    return false;
}

exports.isExcludedMessage = isExcludedMessage;
