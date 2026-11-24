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

#include "sample_prompts_menu.h"

#include "../converse/history.h"
#include "../converse/session_window.h"
#include "../util/style.h"
#include "../util/memory/malloc.h"
#include "../util/memory/sdk.h"
#include "../util/logging.h"
#include <pebble.h>

typedef struct {
  MenuLayer *menu_layer;
  StatusBarLayer *status_bar;
  char *buffer;
  char **prompts;
  int count;
  bool using_history;
  bool waiting_for_history;
} SamplePromptsMenuData;

// Show the most recent few prompts. The entries are pointers into the fixed
// history arrays, so showing more costs only a pointer each.
#define RECENT_PROMPT_LIMIT HISTORY_RECENT_PROMPT_MAX

// The visible menu, so the history-loaded callback can refresh it.
static Window *s_window = NULL;

static void prv_window_load(Window* window);
static void prv_window_unload(Window* window);
static void prv_load_source(SamplePromptsMenuData *data);
static void prv_history_done(void);
static uint16_t prv_get_num_rows(MenuLayer *menu_layer, uint16_t section_index, void *context);
static void prv_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *context);
static void prv_select_click(MenuLayer *menu_layer, MenuIndex *cell_index, void *context);

static int prv_load_prompts(char *buffer, size_t size, char ***prompts) {
  int count = 1;
  for (size_t i = 0; i < size; ++i) {
    if (buffer[i] == '\n') {
      ++count;
    }
  }
  *prompts = bmalloc(sizeof(char*) * count);
  if (!*prompts) {
    return 0;
  }
  char *p = buffer;
  for (int i = 0; i < count; ++i) {
    (*prompts)[i] = p;
    p = strchr(p, '\n');
    if (p) {
      *p = '\0';
      ++p;
    }
  }
  return count;
}

void sample_prompts_menu_push() {
  Window *window = bwindow_create();
  SamplePromptsMenuData *data = bmalloc(sizeof(SamplePromptsMenuData));
  memset(data, 0, sizeof(SamplePromptsMenuData));
  window_set_user_data(window, data);
  window_set_window_handlers(window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(window, true);
}

static void prv_load_canned_prompts(SamplePromptsMenuData *data) {
  ResHandle handle = resource_get_handle(RESOURCE_ID_SAMPLE_PROMPTS);
  size_t size = resource_size(handle);
  // The resource is raw text without a terminator; add one so the last prompt
  // does not read past the end of the buffer.
  data->buffer = bmalloc(size + 1);
  if (!data->buffer) return;
  resource_load(handle, (uint8_t*)data->buffer, size);
  data->buffer[size] = '\0';
  data->count = prv_load_prompts(data->buffer, size, &data->prompts);
  data->using_history = false;
}

static void prv_load_history_prompts(SamplePromptsMenuData *data) {
  // The phone sends the most recent questions separately from the interleaved
  // conversation history, so Ask Again can show more of them than the history
  // array holds.
  int count = history_get_recent_prompt_count();
  if (count > RECENT_PROMPT_LIMIT) count = RECENT_PROMPT_LIMIT;
  if (count > 0) {
    data->prompts = bmalloc(sizeof(char*) * count);
    if (!data->prompts) return;
    for (int i = 0; i < count; i++) {
      const char *prompt = history_get_recent_prompt(i);
      if (!prompt) break;
      // Point at the ring entry; do not duplicate the text.
      data->prompts[data->count++] = (char*)prompt;
    }
    data->using_history = data->count > 0;
    return;
  }

  // Fall back to prompts in the interleaved history when no separate list has
  // arrived (for example, a batch from an older phone build).
  int total = history_get_count();
  int available = 0;
  for (int i = 0; i < total; i++) {
    const HistoryEntry *entry = history_get_entry(i);
    if (entry && entry->type == HistoryEntryTypePrompt) available++;
  }
  count = available < RECENT_PROMPT_LIMIT ? available : RECENT_PROMPT_LIMIT;
  if (count == 0) return;

  data->prompts = bmalloc(sizeof(char*) * count);
  if (!data->prompts) return;

  // Walk backwards so the most recent prompt is first, skipping repeats.
  int idx = 0;
  for (int i = total - 1; i >= 0 && idx < count; i--) {
    const HistoryEntry *entry = history_get_entry(i);
    if (!entry || entry->type != HistoryEntryTypePrompt) continue;
    bool duplicate = false;
    for (int j = 0; j < idx; j++) {
      if (strcmp(entry->text, data->prompts[j]) == 0) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      // Point at the history entry; do not duplicate the text.
      data->prompts[idx++] = (char*)entry->text;
    }
  }
  data->count = idx;
  data->using_history = idx > 0;
}

static void prv_load_source(SamplePromptsMenuData *data) {
  if (data->prompts) {
    free(data->prompts);
    data->prompts = NULL;
  }
  if (data->buffer) {
    free(data->buffer);
    data->buffer = NULL;
  }
  data->count = 0;
  data->using_history = false;
  data->waiting_for_history = false;

  prv_load_history_prompts(data);
  if (data->count > 0) return;

  if (history_is_loading()) {
    data->waiting_for_history = true;
    return;
  }

  prv_load_canned_prompts(data);
}

static void prv_history_done(void) {
  if (!s_window) return;
  SamplePromptsMenuData *data = window_get_user_data(s_window);
  prv_load_source(data);
  menu_layer_reload_data(data->menu_layer);
  // history_set_done clears the callback before calling it, so keep listening
  // for another batch while this menu is visible.
  history_set_done_callback(prv_history_done);
}

static void prv_window_load(Window* window) {
  SamplePromptsMenuData *data = window_get_user_data(window);
  Layer *root_layer = window_get_root_layer(window);
  GRect window_bounds = layer_get_frame(root_layer);

  s_window = window;
  prv_load_source(data);
  // Keep listening even when cached data is already shown, so a later batch
  // (or a retried history request) refreshes the menu.
  history_set_done_callback(prv_history_done);

  window_set_background_color(window, GColorWhite);

  data->status_bar = bstatus_bar_layer_create();
  squire_status_bar_config(data->status_bar);
  layer_add_child(root_layer, status_bar_layer_get_layer(data->status_bar));

  GRect menu_frame = GRect(0, STATUS_BAR_LAYER_HEIGHT, window_bounds.size.w, window_bounds.size.h - STATUS_BAR_LAYER_HEIGHT);
  data->menu_layer = bmenu_layer_create(menu_frame);
  menu_layer_set_callbacks(data->menu_layer, data, (MenuLayerCallbacks) {
    .get_num_rows = prv_get_num_rows,
    .draw_row = prv_draw_row,
    .select_click = prv_select_click,
  });
  menu_layer_set_highlight_colors(data->menu_layer, SELECTION_HIGHLIGHT_COLOUR, gcolor_legible_over(SELECTION_HIGHLIGHT_COLOUR));
#ifdef PBL_ROUND
  menu_layer_set_center_focused(data->menu_layer, true);
#endif
  layer_add_child(root_layer, menu_layer_get_layer(data->menu_layer));
  menu_layer_set_click_config_onto_window(data->menu_layer, window);
}

static void prv_window_unload(Window* window) {
  SamplePromptsMenuData *data = window_get_user_data(window);
  history_set_done_callback(NULL);
  s_window = NULL;
  menu_layer_destroy(data->menu_layer);
  status_bar_layer_destroy(data->status_bar);
  free(data->prompts);
  if (data->buffer) {
    free(data->buffer);
  }
  free(data);
  window_destroy(window);
}

static uint16_t prv_get_num_rows(MenuLayer *menu_layer, uint16_t section_index, void *context) {
  SamplePromptsMenuData *data = context;
  if (data->count == 0) return 1;
  return data->count;
}

static void prv_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *context) {
  SamplePromptsMenuData *data = context;
  const char *title = data->count == 0
      ? (data->waiting_for_history ? "Loading history..." : "No recent prompts")
      : data->prompts[cell_index->row];
#ifdef PBL_ROUND
  GRect bounds = layer_get_bounds(cell_layer);
  graphics_draw_text(ctx, title,
    fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
    GRect(10, 5, bounds.size.w - 20, bounds.size.h - 10),
    GTextOverflowModeWordWrap,
    GTextAlignmentCenter,
    NULL);
#else
  menu_cell_title_draw(ctx, cell_layer, title);
#endif
}

static void prv_select_click(MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  SamplePromptsMenuData *data = context;
  if (data->count == 0) return;

  const char *prompt = data->prompts[cell_index->row];
  const char *thread_id = history_get_thread_id();
  if (data->using_history && thread_id && thread_id[0]) {
    // Reuse the prompt in the conversation it came from, with the last
    // exchange visible.
    session_window_push_with_history_limit(0, (char*)prompt, thread_id, 2);
  } else {
    session_window_push(0, (char*)prompt);
  }
}