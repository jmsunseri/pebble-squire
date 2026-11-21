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

var bundleLoader = require('./lib/bundle_loader');
var ensureTelegramBundle = bundleLoader.ensureTelegramBundle;

var location = require('./location');
var session = require('./session');
var telegram = require('./telegram');
var history = require('./history');
var Clay = require('@rebble/clay');
var clayConfig = require('./config.json');
var customConfigFunction = require('./custom_config');
var config = require('./config');
var package_json = require('package.json');


var clay = new Clay(clayConfig, customConfigFunction);

function main() {
    location.update();
    sendTelegramStatus();
    history.fetchAndSendHistory();
    Pebble.addEventListener('appmessage', handleAppMessage);
}

// Identifies the current auth request so a superseded request's late result
// doesn't send a stale code/error to the watch.
var authRequestSeq = 0;

function sendTelegramStatus() {
    var attempt = 0;
    function send() {
        attempt++;
        var isConnected = telegram.hasSession();
        console.log('Telegram connected: ' + isConnected);
        Pebble.sendAppMessage({
            TELEGRAM_CONNECTED: isConnected ? 1 : 0
        }, function() {
            console.log('[index] Telegram status sent');
        }, function(e) {
            console.error('[index] Failed to send Telegram status: ' + JSON.stringify(e));
            if (attempt < 3) setTimeout(send, 1000);
        });
    }
    send();
}

function describeAuthError(err) {
    var msg = (err && (err.errorMessage || err.message)) || '';
    if (msg.indexOf('API_ID_INVALID') !== -1) {
        return 'This build has no valid Telegram API credentials.';
    }
    if (msg.indexOf('PHONE_NUMBER_INVALID') !== -1) {
        return 'That phone number is not valid.';
    }
    if (msg.indexOf('PHONE_NUMBER_BANNED') !== -1) {
        return 'Telegram has blocked this phone number.';
    }
    var flood = msg.match(/FLOOD_WAIT_(\d+)/);
    if (flood) {
        return 'Telegram asked us to wait ' + flood[1] + ' seconds before trying again.';
    }
    if (msg.indexOf('PHONE_CODE_INVALID') !== -1) {
        return 'That code was incorrect. Sign in again to request a new code.';
    }
    if (msg.indexOf('PHONE_CODE_EXPIRED') !== -1) {
        return 'That code expired. Sign in again to request a new one.';
    }
    if (msg.indexOf('SESSION_PASSWORD_NEEDED') !== -1) {
        return 'This account has 2FA enabled, which is not supported yet.';
    }
    if (msg.indexOf('Authentication already in progress') !== -1) {
        return 'A previous sign-in is still running. Wait a moment and try again.';
    }
    if (msg.indexOf('did not respond in time') !== -1 || msg.indexOf('timed out') !== -1) {
        return 'Telegram did not respond. Check the phone connection and try again.';
    }
    if (msg.indexOf('session expired') !== -1 || msg.indexOf('re-authenticate') !== -1) {
        return 'Your Telegram session expired. Sign in again.';
    }
    return 'Could not sign in to Telegram. Check the phone connection and try again.';
}

function sendAuthError(err) {
    var reason = describeAuthError(err);
    console.error('[index] Auth failed: ' + reason);
    Pebble.sendAppMessage({
        TELEGRAM_AUTH_ERROR: 1,
        TELEGRAM_AUTH_ERROR_REASON: reason
    }, null, function(e) {
        console.error('[index] Failed to send auth error: ' + JSON.stringify(e));
    });
}

function handleTelegramDisconnect() {
    console.log('[index] Disconnecting from Telegram');
    authRequestSeq++;
    telegram.logout().then(function() {
        console.log('[index] Disconnected successfully');
    }).catch(function(err) {
        console.error('[index] Failed to disconnect: ' + (err.message || err));
    }).then(function() {
        // logout() clears local state even when the network disconnect fails,
        // so the watch must be told it is no longer connected either way.
        sendTelegramStatus();
    });
}

function handleStartAuth(phone) {
    ensureTelegramBundle();
    var seq = ++authRequestSeq;
    console.log('[index] Watch requested start_auth for: ' + phone);

    // If the phone still has a session - e.g. the watch was reset but the
    // phone app wasn't - reuse it instead of forcing a new SMS code.
    if (telegram.hasSession() && typeof TelegramClient !== 'undefined') {
        console.log('[index] Existing Telegram session found; reporting connected');
        Pebble.sendAppMessage({
            TELEGRAM_CONNECTED: 1,
            AGENT_TELEGRAM_USERNAME: telegram.getBotUsername()
        });
        history.fetchAndSendHistory();
        return;
    }

    telegram.startAuth(phone).then(function(result) {
        if (seq !== authRequestSeq) {
            console.log('[index] Ignoring stale auth result');
            return;
        }
        console.log('[index] startAuth result: ' + JSON.stringify(result));
        if (result.success) {
            Pebble.sendAppMessage({ TELEGRAM_CODE_SENT: 1 }, null, function(e) {
                console.error('[index] Failed to send code-sent status: ' + JSON.stringify(e));
            });
        } else if (result.status === 'password_needed') {
            sendAuthError(new Error('SESSION_PASSWORD_NEEDED'));
        } else {
            sendAuthError(new Error('Auth failed: ' + (result.status || 'unknown')));
        }
    }).catch(function(err) {
        if (seq !== authRequestSeq) {
            console.log('[index] Ignoring stale auth failure');
            return;
        }
        sendAuthError(err);
    });
}

function handleProvideCode(code) {
    ensureTelegramBundle();
    var seq = ++authRequestSeq;
    console.log('[index] Watch provided code');
    telegram.provideCode(code).then(function(result) {
        if (seq !== authRequestSeq) {
            console.log('[index] Ignoring stale code result');
            return;
        }
        console.log('[index] provideCode result: ' + JSON.stringify(result));
        if (result.success) {
            Pebble.sendAppMessage({
                TELEGRAM_CONNECTED: 1,
                AGENT_TELEGRAM_USERNAME: telegram.getBotUsername()
            });
            history.fetchAndSendHistory();
        } else if (result.status === 'password_needed') {
            sendAuthError(new Error('SESSION_PASSWORD_NEEDED'));
        } else {
            sendAuthError(new Error('Sign-in failed'));
        }
    }).catch(function(err) {
        if (seq !== authRequestSeq) {
            console.log('[index] Ignoring stale code failure');
            return;
        }
        sendAuthError(err);
    });
}

function handleAppMessage(e) {
    console.log("Inbound app message!");
    console.log(JSON.stringify(e));
    var data = e.payload;
    if (data.PROMPT) {
        console.log("Starting a new Session...");
        var s = new session.Session(data.PROMPT, data.THREAD_ID);
        s.run();
        return;
    }

    if ('TELEGRAM_START_AUTH' in data) {
        handleStartAuth(data.TELEGRAM_START_AUTH);
        return;
    }

    if ('TELEGRAM_PROVIDE_CODE' in data) {
        handleProvideCode(data.TELEGRAM_PROVIDE_CODE);
        return;
    }

    if ('TELEGRAM_DISCONNECT' in data) {
        ensureTelegramBundle();
        handleTelegramDisconnect();
        return;
    }

    if ('LOCATION_ENABLED' in data) {
        try {
            config.setSetting("LOCATION_ENABLED", !!data.LOCATION_ENABLED);
        } catch (err) {
            console.error('[index] Failed to save location setting: ' + (err.message || err));
        }
        console.log("Location enabled: " + config.isLocationEnabled());
        // We need to confirm that we received this for the watch to proceed.
        Pebble.sendAppMessage({
            LOCATION_ENABLED: data.LOCATION_ENABLED,
        });
    }
}

function doCobbleWarning() {
    if (window.cobble) {
        console.log("WARNING: Running Squire on Cobble is not supported, and has multiple known issues.");
        Pebble.sendAppMessage({COBBLE_WARNING: 1});
    }
}

Pebble.addEventListener("ready",
    function(e) {
        // This happens before anything else because I don't trust Cobble to get through the normal flow,
        // given how many things bizarrely don't work.
        doCobbleWarning();
        console.log("Squire " + package_json['version']);

        main();
    }
);

// Export function to notify watch of Telegram status changes
exports.updateTelegramStatus = function() {
    sendTelegramStatus();
};

// Export message handler for testing
exports.handleAppMessage = handleAppMessage;
exports.handleTelegramDisconnect = handleTelegramDisconnect;
exports.describeAuthError = describeAuthError;