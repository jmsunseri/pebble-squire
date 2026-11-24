#include "history.h"
#include "../util/memory/malloc.h"
#include "../util/logging.h"
#include <string.h>

static HistoryEntry s_entries[HISTORY_MAX_ENTRIES];
static int s_count = 0;
static char s_recent_prompts[HISTORY_RECENT_PROMPT_MAX][HISTORY_TEXT_MAX];
static int s_recent_prompt_count = 0;
static char s_thread_id[37] = "";
static bool s_done = false;
static bool s_loading = false;
static void (*s_done_callback)(void) = NULL;

// Copy with truncation that never leaves a partial UTF-8 sequence at the end
// of the buffer; a bare strncpy can cut a multi-byte character in half.
static void prv_copy_entry_text(char* dst, const char* src, size_t dst_size) {
  strncpy(dst, src, dst_size - 1);
  dst[dst_size - 1] = '\0';
  size_t len = strlen(dst);
  if (len < dst_size - 1) {
    return;  // nothing was truncated
  }
  size_t seq_start = len;
  while (seq_start > 0 && ((unsigned char)dst[seq_start - 1] & 0xC0) == 0x80) {
    seq_start--;
  }
  if (seq_start == 0 || ((unsigned char)dst[seq_start - 1] & 0xC0) != 0xC0) {
    return;  // ends on a complete character (or isn't UTF-8 at all)
  }
  unsigned char lead = (unsigned char)dst[seq_start - 1];
  size_t expected = (lead & 0xE0) == 0xC0 ? 2 : (lead & 0xF0) == 0xE0 ? 3 : 4;
  if (expected > len - (seq_start - 1)) {
    dst[seq_start - 1] = '\0';
  }
}

void history_init(void) {
  s_count = 0;
  s_recent_prompt_count = 0;
  s_done = false;
  s_loading = true;
  s_done_callback = NULL;
  s_thread_id[0] = '\0';
}

// Start a new history batch. The text buffers are deliberately left intact so
// an open menu still has valid pointers until the replacement batch arrives.
void history_reset(void) {
  s_count = 0;
  s_recent_prompt_count = 0;
  s_done = false;
  s_loading = true;
  // Keep the thread ID: if the replacement batch has no thread marker, the
  // existing conversation is still the right place for a reused question.
}

void history_set_loading(bool loading) {
  s_loading = loading;
}

bool history_is_loading(void) {
  return s_loading;
}

void history_set_done_callback(void (*callback)(void)) {
  s_done_callback = callback;
}

void history_add_prompt(const char* text) {
  if (s_count >= HISTORY_MAX_ENTRIES) return;
  s_entries[s_count].type = HistoryEntryTypePrompt;
  prv_copy_entry_text(s_entries[s_count].text, text, sizeof(s_entries[s_count].text));
  s_count++;
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "History prompt %d: %.50s", s_count, text);
}

void history_add_response(const char* text) {
  if (s_count >= HISTORY_MAX_ENTRIES) return;
  s_entries[s_count].type = HistoryEntryTypeResponse;
  prv_copy_entry_text(s_entries[s_count].text, text, sizeof(s_entries[s_count].text));
  s_count++;
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "History response %d: %.50s", s_count, text);
}

static void prv_push_recent_prompt(const char* text) {
  // If this question is already in the ring, remove it first so it moves to
  // the newest position instead of appearing twice. Compare with the same
  // truncation the entry was stored with.
  for (int i = 0; i < s_recent_prompt_count; i++) {
    if (strncmp(s_recent_prompts[i], text, HISTORY_TEXT_MAX - 1) == 0) {
      for (int j = i; j < s_recent_prompt_count - 1; j++) {
        memcpy(s_recent_prompts[j], s_recent_prompts[j + 1], HISTORY_TEXT_MAX);
      }
      s_recent_prompt_count--;
      break;
    }
  }
  if (s_recent_prompt_count >= HISTORY_RECENT_PROMPT_MAX) {
    for (int i = 0; i < HISTORY_RECENT_PROMPT_MAX - 1; i++) {
      memcpy(s_recent_prompts[i], s_recent_prompts[i + 1], HISTORY_TEXT_MAX);
    }
    s_recent_prompt_count = HISTORY_RECENT_PROMPT_MAX - 1;
  }
  prv_copy_entry_text(s_recent_prompts[s_recent_prompt_count], text, HISTORY_TEXT_MAX);
  s_recent_prompt_count++;
}

void history_add_recent_prompt(const char* text) {
  prv_push_recent_prompt(text);
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "Recent prompt %d: %.50s", s_recent_prompt_count, text);
}

int history_get_recent_prompt_count(void) {
  return s_recent_prompt_count;
}

// Index 0 is the most recent question.
const char* history_get_recent_prompt(int index) {
  if (index < 0 || index >= s_recent_prompt_count) return NULL;
  return s_recent_prompts[s_recent_prompt_count - 1 - index];
}

void history_set_thread_id(const char* thread_id) {
  strncpy(s_thread_id, thread_id, sizeof(s_thread_id) - 1);
  s_thread_id[sizeof(s_thread_id) - 1] = '\0';
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "History thread ID: %s", thread_id);
}

static void prv_shift_if_full(void) {
  if (s_count < HISTORY_MAX_ENTRIES) return;
  for (int i = 0; i < HISTORY_MAX_ENTRIES - 1; i++) {
    s_entries[i] = s_entries[i + 1];
  }
  s_count = HISTORY_MAX_ENTRIES - 1;
}

void history_push_prompt(const char* text) {
  prv_shift_if_full();
  s_entries[s_count].type = HistoryEntryTypePrompt;
  prv_copy_entry_text(s_entries[s_count].text, text, sizeof(s_entries[s_count].text));
  s_count++;
  prv_push_recent_prompt(text);
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "History push prompt %d: %.50s", s_count, text);
}

void history_push_response(const char* text) {
  prv_shift_if_full();
  s_entries[s_count].type = HistoryEntryTypeResponse;
  prv_copy_entry_text(s_entries[s_count].text, text, sizeof(s_entries[s_count].text));
  s_count++;
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "History push response %d: %.50s", s_count, text);
}

void history_push_thread_id(const char* thread_id) {
  history_set_thread_id(thread_id);
}

void history_set_done(void) {
  s_done = true;
  s_loading = false;
  SQUIRE_LOG(APP_LOG_LEVEL_INFO, "History done. %d entries, %d recent prompts.", s_count, s_recent_prompt_count);
  // Clear the callback before invoking it so a still-open window can register
  // itself again for the next batch.
  void (*callback)(void) = s_done_callback;
  s_done_callback = NULL;
  if (callback) {
    callback();
  }
}

bool history_is_available(void) {
  return s_done && s_count > 0;
}

const char* history_get_thread_id(void) {
  return s_thread_id;
}

int history_get_count(void) {
  return s_count;
}

const HistoryEntry* history_get_entry(int index) {
  if (index < 0 || index >= s_count) return NULL;
  return &s_entries[index];
}

void history_free(void) {
  s_count = 0;
  s_recent_prompt_count = 0;
  s_done = false;
  s_thread_id[0] = '\0';
}
