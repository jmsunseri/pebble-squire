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

/**
 * Telegram authentication functions.
 * Uses client.invoke() with auth.SendCode and auth.SignIn,
 * matching the Pebblegram bundle's API surface.
 */

var client = require('./client');
var session = require('./session');

var phoneCodeHash = null;
var pendingPhone = null;
var authSession = null;
var authInProgress = false;
var authStartedAt = 0;
var authGeneration = 0;
var pendingClient = null;

var AUTH_STATE_KEY = 'telegram_auth_waiting_for_code';

// A new request may replace an in-flight one after this long. This keeps a
// double-tap from triggering a second SendCode, but lets a stuck request be
// retried instead of locking the user out until the JS context restarts.
var AUTH_SUPERSEDE_MS = 15000;
// Upper bound for one GramJS auth operation. Must stay below the watch's
// response timer so the watch gets an explicit failure rather than silence.
var AUTH_OPERATION_TIMEOUT_MS = 40000;

function clearPendingClient() {
    var c = pendingClient;
    pendingClient = null;
    if (!c) return;
    try {
        c.disconnect().catch(function() {});
    } catch (e) {
        console.log('[auth] Failed to disconnect pending client: ' + (e.message || e));
    }
}

function clearPendingAuthData() {
    phoneCodeHash = null;
    authSession = null;
    pendingPhone = null;
    clearPendingClient();
    try { localStorage.removeItem(AUTH_STATE_KEY); } catch(e) {}
}

function resetAuthState(reason) {
    authGeneration++;
    authInProgress = false;
    authStartedAt = 0;
    clearPendingAuthData();
    if (reason) {
        console.log('[auth] Reset auth state: ' + reason);
    }
}

function withTimeout(promise, ms, message) {
    return new Promise(function(resolve, reject) {
        var timer = setTimeout(function() {
            reject(new Error(message));
        }, ms);
        promise.then(function(value) {
            clearTimeout(timer);
            resolve(value);
        }, function(err) {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function withAuthLock(fn) {
    return function() {
        if (authInProgress) {
            var age = Date.now() - authStartedAt;
            if (age < AUTH_SUPERSEDE_MS) {
                return Promise.reject(new Error('Authentication already in progress'));
            }
            console.log('[auth] Replacing stale auth request (' + age + 'ms old)');
            resetAuthState('stale request replaced');
        }
        authInProgress = true;
        authStartedAt = Date.now();
        var generation = authGeneration;
        var args = arguments;
        return Promise.resolve()
            .then(function() { return fn.apply(null, args); })
            .then(function(result) {
                if (generation === authGeneration) authInProgress = false;
                return result;
            }, function(err) {
                if (generation === authGeneration) authInProgress = false;
                throw err;
            });
    };
}

var AUTH_DC = {
    id: 1,
    host: 'pluto.web.telegram.org'
};

// TELEGRAM_APP_ID / TELEGRAM_APP_HASH are inlined at build time.
// Release builds get them from the CloudPebble build environment;
// see "Telegram API Credentials" in README.md.
function createAuthClient() {
    var StringSessionCls = StringSession;
    var apiId = parseInt(process.env.TELEGRAM_APP_ID, 10);
    var apiHash = process.env.TELEGRAM_APP_HASH || '';
    var newClient = new TelegramClient(new StringSessionCls(''), apiId, apiHash, {
        connectionRetries: 5,
        // GramJS ignores the session's port and uses 80 unless useWSS is set.
        // Telegram's TCP endpoints are on 443; port 80 often hangs.
        useWSS: true,
        deviceModel: 'Squire',
        systemVersion: '1.0',
        appVersion: '1.0'
    });
    if (newClient.session && typeof newClient.session.setDC === 'function') {
        newClient.session.setDC(AUTH_DC.id, AUTH_DC.host, 443);
    }
    return newClient;
}

function startAuth(phoneNumber) {
    console.log('[auth] startAuth called for phone: ' + phoneNumber);
    var generation = authGeneration;
    pendingPhone = phoneNumber;
    phoneCodeHash = null;
    authSession = null;

    var operation = new Promise(function(resolve, reject) {
        var authClient = createAuthClient();
        pendingClient = authClient;
        var Api = (typeof TelegramApi !== 'undefined') ? TelegramApi : (authClient.Api || {});
        var apiId = parseInt(process.env.TELEGRAM_APP_ID, 10);
        var apiHash = process.env.TELEGRAM_APP_HASH || '';

        authClient.connect().then(function() {
            console.log('[auth] Auth client connected, sending code...');
            return authClient.invoke(new Api.auth.SendCode({
                phoneNumber: phoneNumber,
                apiId: apiId,
                apiHash: apiHash,
                settings: new Api.CodeSettings({})
            }));
        }).then(function(result) {
            if (generation !== authGeneration) {
                console.log('[auth] Superseded auth request; discarding SendCode result');
                try { authClient.disconnect(); } catch (e) {}
                return;
            }
            console.log('[auth] SendCode result: phoneCodeHash=' + (result.phoneCodeHash ? 'received' : 'missing'));
            if (!result || !result.phoneCodeHash) {
                if (result && result.className === 'auth.SentCodeSuccess') {
                    clearPendingAuthData();
                    reject(new Error('This session is already authorized.'));
                    return;
                }
                clearPendingAuthData();
                reject(new Error('Telegram did not return a login code hash.'));
                return;
            }
            phoneCodeHash = result.phoneCodeHash;
            authSession = authClient.session.save();
            try { localStorage.setItem(AUTH_STATE_KEY, 'true'); } catch(e) {}
            // The code is tied to authSession; don't keep a second connection
            // open with the same auth key while the user enters it.
            clearPendingClient();
            resolve({
                success: true,
                status: 'code_sent'
            });
        }).catch(function(err) {
            if (generation !== authGeneration) {
                console.log('[auth] Superseded auth request; ignoring SendCode failure');
                try { authClient.disconnect(); } catch (e) {}
                return;
            }
            console.error('[auth] startAuth failed: ' + (err.message || err));
            clearPendingAuthData();
            reject(new Error('Auth failed: ' + (err.errorMessage || err.message)));
        });
    });

    return withTimeout(operation, AUTH_OPERATION_TIMEOUT_MS, 'Telegram did not respond in time')
        .catch(function(err) {
            if (err && err.message === 'Telegram did not respond in time') {
                resetAuthState('startAuth timeout');
            }
            throw err;
        });
}

function provideCode(code) {
    console.log('[auth] provideCode called');
    var generation = authGeneration;
    try { localStorage.removeItem(AUTH_STATE_KEY); } catch(e) {}
    var operation = new Promise(function(resolve, reject) {
        if (!phoneCodeHash) {
            reject(new Error('No pending code request — call startAuth first'));
            return;
        }
        var apiId = parseInt(process.env.TELEGRAM_APP_ID, 10);
        var apiHash = process.env.TELEGRAM_APP_HASH || '';
        var phone = pendingPhone || '';
        var StringSessionCls = StringSession;
        var signInClient = new TelegramClient(new StringSessionCls(authSession || ''), apiId, apiHash, {
            connectionRetries: 5,
            useWSS: true,
            deviceModel: 'Squire',
            systemVersion: '1.0',
            appVersion: '1.0'
        });
        pendingClient = signInClient;
        var Api = (typeof TelegramApi !== 'undefined') ? TelegramApi : (signInClient.Api || {});

        signInClient.connect().then(function() {
            console.log('[auth] SignIn client connected, signing in...');
            return signInClient.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash,
                phoneCode: code
            }));
        }).then(function(result) {
            if (generation !== authGeneration) {
                console.log('[auth] Superseded auth request; discarding SignIn result');
                try { signInClient.disconnect(); } catch (e) {}
                return;
            }
            console.log('[auth] SignIn successful');
            var sessionStr = signInClient.session.save();
            session.saveSession(sessionStr);
            clearPendingAuthData();
            resolve({
                success: true,
                status: 'signed_in'
            });
        }).catch(function(err) {
            if (generation !== authGeneration) {
                console.log('[auth] Superseded auth request; ignoring SignIn failure');
                try { signInClient.disconnect(); } catch (e) {}
                return;
            }
            var msg = err.errorMessage || err.message || '';
            console.error('[auth] SignIn failed: ' + msg);
            if (msg === 'SESSION_PASSWORD_NEEDED') {
                console.log('[auth] 2FA required');
                authSession = signInClient.session.save();
                try { signInClient.disconnect(); } catch (e) {}
                pendingClient = null;
                phoneCodeHash = null;
                resolve({
                    success: false,
                    status: 'password_needed',
                    hint: err.hint || ''
                });
                return;
            }
            clearPendingAuthData();
            reject(new Error('SignIn failed: ' + msg));
        });
    });

    return withTimeout(operation, AUTH_OPERATION_TIMEOUT_MS, 'Telegram did not respond in time')
        .catch(function(err) {
            if (err && err.message === 'Telegram did not respond in time') {
                resetAuthState('provideCode timeout');
            }
            throw err;
        });
}

function providePassword(password) {
    console.log('[auth] providePassword called');
    var generation = authGeneration;
    var operation = new Promise(function(resolve, reject) {
        if (!authSession) {
            reject(new Error('No pending 2FA request — sign in first'));
            return;
        }
        var apiId = parseInt(process.env.TELEGRAM_APP_ID, 10);
        var apiHash = process.env.TELEGRAM_APP_HASH || '';
        var StringSessionCls = StringSession;
        var pwClient = new TelegramClient(new StringSessionCls(authSession), apiId, apiHash, {
            connectionRetries: 5,
            useWSS: true,
            deviceModel: 'Squire',
            systemVersion: '1.0',
            appVersion: '1.0'
        });
        pendingClient = pwClient;

        pwClient.connect().then(function() {
            return pwClient.signInWithPassword({
                apiId: apiId,
                apiHash: apiHash
            }, {
                password: function() {
                    return Promise.resolve(password);
                },
                onError: function(err) {
                    reject(new Error('2FA failed: ' + (err.message || err)));
                }
            });
        }).then(function() {
            if (generation !== authGeneration) {
                console.log('[auth] Superseded auth request; discarding 2FA result');
                try { pwClient.disconnect(); } catch (e) {}
                return;
            }
            console.log('[auth] 2FA successful');
            var sessionStr = pwClient.session.save();
            session.saveSession(sessionStr);
            clearPendingAuthData();
            resolve({
                success: true,
                status: 'signed_in'
            });
        }).catch(function(err) {
            if (generation !== authGeneration) {
                console.log('[auth] Superseded auth request; ignoring 2FA failure');
                try { pwClient.disconnect(); } catch (e) {}
                return;
            }
            console.error('[auth] 2FA failed: ' + (err.message || err));
            clearPendingAuthData();
            reject(new Error('2FA failed: ' + (err.message || err)));
        });
    });

    return withTimeout(operation, AUTH_OPERATION_TIMEOUT_MS, 'Telegram did not respond in time')
        .catch(function(err) {
            if (err && err.message === 'Telegram did not respond in time') {
                resetAuthState('providePassword timeout');
            }
            throw err;
        });
}

function checkConnection() {
    console.log('[auth] checkConnection called');
    return new Promise(function(resolve) {
        var storedSession = session.loadSession();
        if (storedSession) {
            console.log('[auth] Stored session found, attempting to connect...');
            client.initClient().then(function() {
                console.log('[auth] Connected successfully with stored session');
                resolve({ connected: true, hasSession: true });
            }).catch(function(err) {
                console.error('[auth] Failed to connect with stored session: ' + (err.message || err));
                resolve({ connected: false, hasSession: true, needsReauth: true });
            });
        } else {
            console.log('[auth] No stored session found');
            resolve({ connected: false, hasSession: false });
        }
    });
}

function logout() {
    console.log('[auth] logout called');
    // Invalidate any in-flight auth request and clear its lock. Without this,
    // disconnecting mid-auth leaves the next attempt failing with
    // "Authentication already in progress".
    resetAuthState('logout');
    return new Promise(function(resolve, reject) {
        client.disconnect().then(function() {
            console.log('[auth] Disconnected and session cleared');
            resolve();
        }).catch(function(err) {
            console.error('[auth] Logout failed: ' + (err.message || err));
            reject(err);
        });
    });
}

function getAuthState() {
    return {
        isWaitingForCode: phoneCodeHash !== null,
        isWaitingForPassword: authSession !== null,
        isAuthInProgress: authInProgress,
        isCodeViaApp: false
    };
}

exports.startAuth = withAuthLock(startAuth);
exports.provideCode = withAuthLock(provideCode);
exports.providePassword = withAuthLock(providePassword);
exports.checkConnection = checkConnection;
exports.logout = logout;
exports.getAuthState = getAuthState;