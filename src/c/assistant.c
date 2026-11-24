/*
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

#include "root_window.h"
#include "release_notes.h"
#include "consent/consent.h"
#include "converse/session_window.h"
#include "converse/conversation_manager.h"
#include "converse/history.h"
#include "version/version.h"
#include "settings/settings.h"

#include <pebble.h>
#include <pebble-events/pebble-events.h>

#include "util/logging.h"
#include "util/memory/pressure.h"
#include "util/auth_flow.h"


#define QUICK_LAUNCH_TIMEOUT_MS 60000

// History is pulled by the watch rather than pushed when PebbleKit JS starts,
// so the burst cannot land before this app is listening. Retry a few times in
// case the phone-side JS is still starting up.
#define HISTORY_REQUEST_INITIAL_DELAY_MS 1000
#define HISTORY_REQUEST_RETRY_DELAY_MS 2000
#define HISTORY_REQUEST_MAX_ATTEMPTS 5

static RootWindow* s_root_window = NULL;
static EventHandle s_history_handle;
static AppTimer* s_history_request_timer = NULL;
static int s_history_request_attempts = 0;
static bool s_history_response_seen = false;

static void prv_request_history(void);
static void prv_history_request_timer_callback(void *context);

static void prv_history_message_handler(DictionaryIterator *iter, void *context) {
  bool saw_history_key = false;
  bool saw_reset = false;
  for (Tuple *tuple = dict_read_first(iter); tuple; tuple = dict_read_next(iter)) {
    if (tuple->key == MESSAGE_KEY_HISTORY_PROMPT) {
      saw_history_key = true;
      history_add_prompt(tuple->value->cstring);
    } else if (tuple->key == MESSAGE_KEY_HISTORY_RESPONSE) {
      saw_history_key = true;
      history_add_response(tuple->value->cstring);
    } else if (tuple->key == MESSAGE_KEY_RECENT_PROMPT) {
      saw_history_key = true;
      history_add_recent_prompt(tuple->value->cstring);
    } else if (tuple->key == MESSAGE_KEY_HISTORY_THREAD_ID) {
      saw_history_key = true;
      history_set_thread_id(tuple->value->cstring);
    } else if (tuple->key == MESSAGE_KEY_HISTORY_RESET) {
      saw_history_key = true;
      saw_reset = true;
      history_reset();
    } else if (tuple->key == MESSAGE_KEY_HISTORY_DONE) {
      saw_history_key = true;
      history_set_done();
    }
  }
  if (saw_history_key) {
    s_history_response_seen = true;
    if (!saw_reset) {
      history_set_loading(false);
    }
  }
}

static void prv_request_history(void) {
  if (s_history_response_seen) return;
  if (s_history_request_attempts >= HISTORY_REQUEST_MAX_ATTEMPTS) return;
  s_history_request_attempts++;
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "Requesting history (attempt %d).", s_history_request_attempts);
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result == APP_MSG_OK) {
    dict_write_int8(iter, MESSAGE_KEY_HISTORY_REQUEST, 1);
    result = app_message_outbox_send();
    if (result != APP_MSG_OK) {
      SQUIRE_LOG(APP_LOG_LEVEL_WARNING, "History request send failed: %d.", result);
    }
  } else {
    SQUIRE_LOG(APP_LOG_LEVEL_WARNING, "Could not prepare history request: %d.", result);
  }
  s_history_request_timer = app_timer_register(HISTORY_REQUEST_RETRY_DELAY_MS, prv_history_request_timer_callback, NULL);
}

static void prv_history_request_timer_callback(void *context) {
  s_history_request_timer = NULL;
  prv_request_history();
}

static void prv_init(void) {
  memory_pressure_init();
  version_init();
  consent_migrate();
  settings_init();
  history_init();
  conversation_manager_init();
  s_history_handle = events_app_message_register_inbox_received(prv_history_message_handler, NULL);
  events_app_message_open();
  s_history_response_seen = false;
  s_history_request_attempts = 0;
  s_history_request_timer = app_timer_register(HISTORY_REQUEST_INITIAL_DELAY_MS, prv_history_request_timer_callback, NULL);
}

static void prv_deinit(void) {
  if (s_root_window) {
    root_window_destroy(s_root_window);
  }
  if (s_history_request_timer) {
    app_timer_cancel(s_history_request_timer);
    s_history_request_timer = NULL;
  }
  events_app_message_unsubscribe(s_history_handle);
}

int main(void) {
  VersionInfo version_info = version_get_current();
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "Squire %d.%d", version_info.major, version_info.minor);
  prv_init();

#ifdef _PBL_API_EXISTS_app_touch_navigation_enable
  // Third-party apps are opted out by default. Opt in so menus and the
  // What's New screen can be driven by touch when the user enables it.
  app_touch_navigation_enable(true);
#ifdef _PBL_API_EXISTS_touch_service_is_enabled
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "Touch navigation %s",
             touch_service_is_enabled() ? "enabled" : "unavailable");
#endif
#endif
  
  if (must_present_consent()) {
    consent_window_push();
  } else {
    if (launch_reason() == APP_LAUNCH_QUICK_LAUNCH) {
      QuickLaunchBehaviour quick_launch_behaviour = settings_get_quick_launch_behaviour();
      s_root_window = root_window_create();
      if (quick_launch_behaviour == QuickLaunchBehaviourHomeScreen) {
        root_window_push(s_root_window);
      } else {
        // Put the home screen underneath the quick-launched conversation so
        // Back (or the inactivity timeout) returns to it instead of quitting
        // the app. Push it without animating so only the conversation animates
        // in.
        window_stack_push(root_window_get_window(s_root_window), false);
        session_window_push_recent(quick_launch_behaviour == QuickLaunchBehaviourConverseWithTimeout ? QUICK_LAUNCH_TIMEOUT_MS : 0, 2);
      }
    } else {
      s_root_window = root_window_create();
      root_window_push(s_root_window);
    }
    release_notes_maybe_push();
  }

  app_event_loop();
  prv_deinit();
}
