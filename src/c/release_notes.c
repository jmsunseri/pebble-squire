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

#include "release_notes.h"
#include <pebble.h>
#include <string.h>

#include "util/formatted_text_layer.h"
#include "util/logging.h"
#include "util/memory/malloc.h"
#include "util/memory/sdk.h"
#include "util/style.h"
#include "version/version.h"

typedef struct {
  Window *window;
  ScrollLayer *scroll_layer;
  StatusBarLayer *status_bar;
  FormattedTextLayer *text_layer;
  char* text;
} ReleaseNotesWindowData;

static void prv_load(Window *window);
static void prv_unload(Window *window);
// static void prv_click_config_provider(void *context);
static char* prv_create_release_notes();
static uint32_t prv_changelog_resource_id();

void release_notes_push() {
  Window *window = bwindow_create();
  ReleaseNotesWindowData *data = bmalloc(sizeof(ReleaseNotesWindowData));
  memset(data, 0, sizeof(ReleaseNotesWindowData));
  data->window = window;
  window_set_user_data(window, data);
  window_set_window_handlers(window, (WindowHandlers) {
    .load = prv_load,
    .unload = prv_unload,
  });
  window_stack_push(window, true);
}

void release_notes_maybe_push() {
  if (version_is_updated() && !version_is_first_launch()) {
    SQUIRE_LOG(APP_LOG_LEVEL_INFO, "Showing release notes");
    release_notes_push();
  } else {
    SQUIRE_LOG(APP_LOG_LEVEL_INFO, "Not showing release notes. Is updated: %d, Is first launch: %d", version_is_updated(), version_is_first_launch());
  }
}

static char* prv_create_release_notes() {
  ResHandle handle = resource_get_handle(prv_changelog_resource_id());
  size_t size = resource_size(handle) + 1;
  char* text = bmalloc(size);
  text[size - 1] = '\0';
  resource_load(handle, (uint8_t*)text, size);
  return text;
}

static uint32_t prv_changelog_resource_id() {
  VersionInfo version = version_get_current();
  if (version.major == 0) {
    switch (version.minor) {
      case 2:
        return RESOURCE_ID_CHANGELOG_0_2;
      case 1:
        return RESOURCE_ID_CHANGELOG_0_1;
      default:
        break;
    }
  }
  SQUIRE_LOG(APP_LOG_LEVEL_WARNING, "No changelog for v%d.%d, falling back to v0.1 notes",
             version.major, version.minor);
  return RESOURCE_ID_CHANGELOG_0_1;
}

static void prv_load(Window *window) {
  GRect bounds = layer_get_bounds(window_get_root_layer(window));
  ReleaseNotesWindowData *data = window_get_user_data(window);
  data->text = prv_create_release_notes();

  window_set_background_color(window, GColorWhite);

  data->status_bar = bstatus_bar_layer_create();
  squire_status_bar_config(data->status_bar);
  layer_add_child(window_get_root_layer(window), status_bar_layer_get_layer(data->status_bar));

#ifdef PBL_PLATFORM_GABBRO
  const int16_t text_margin = 40;
  const int16_t bottom_padding = 60;
  const GTextAlignment alignment = GTextAlignmentCenter;
#else
  const int16_t text_margin = 5;
  const int16_t bottom_padding = 10;
  const GTextAlignment alignment = GTextAlignmentLeft;
#endif
  const int16_t text_width = bounds.size.w - text_margin * 2;
  data->text_layer = formatted_text_layer_create(GRect(text_margin, 0, text_width, 5000));
  formatted_text_layer_set_text_alignment(data->text_layer, alignment);
  formatted_text_layer_set_text_color(data->text_layer, GColorBlack);
  formatted_text_layer_set_text(data->text_layer, data->text);
  GSize content_size = formatted_text_layer_get_content_size(data->text_layer);
  layer_set_frame(data->text_layer, GRect(text_margin, 0, text_width, content_size.h + 10));

  GRect scroll_frame = GRect(0, STATUS_BAR_LAYER_HEIGHT, bounds.size.w, bounds.size.h - STATUS_BAR_LAYER_HEIGHT);
  data->scroll_layer = scroll_layer_create(scroll_frame);
  scroll_layer_set_shadow_hidden(data->scroll_layer, true);
  scroll_layer_set_content_size(data->scroll_layer, GSize(bounds.size.w, content_size.h + bottom_padding));
  scroll_layer_set_click_config_onto_window(data->scroll_layer, window);
  scroll_layer_add_child(data->scroll_layer, data->text_layer);
  layer_add_child(window_get_root_layer(window), scroll_layer_get_layer(data->scroll_layer));
}

static void prv_unload(Window *window) {
  ReleaseNotesWindowData *data = window_get_user_data(window);
  free(data->text);
  formatted_text_layer_destroy(data->text_layer);
  scroll_layer_destroy(data->scroll_layer);
  status_bar_layer_destroy(data->status_bar);
  free(data);
  window_destroy(window);
}
