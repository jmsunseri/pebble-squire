#ifndef HISTORY_H
#define HISTORY_H

#include <pebble.h>

// These arrays live in static RAM for the whole app lifetime. Keep the budget
// small: dictation and the conversation window need the remaining heap, and
// the app-message buffers already reserve 5000 bytes each way.
#define HISTORY_MAX_ENTRIES 8
// Ask Again shows the most recent questions. The phone fetches one batch of
// messages and sends these separately from the interleaved conversation
// history, so they are not limited by HISTORY_MAX_ENTRIES.
#define HISTORY_RECENT_PROMPT_MAX 10

#define HISTORY_TEXT_MAX 256

typedef enum {
  HistoryEntryTypePrompt,
  HistoryEntryTypeResponse,
} HistoryEntryType;

typedef struct {
  HistoryEntryType type;
  char text[HISTORY_TEXT_MAX];
} HistoryEntry;

void history_init(void);
void history_reset(void);
void history_set_loading(bool loading);
bool history_is_loading(void);
void history_set_done_callback(void (*callback)(void));
void history_add_prompt(const char* text);
void history_add_response(const char* text);
void history_add_recent_prompt(const char* text);
int history_get_recent_prompt_count(void);
const char* history_get_recent_prompt(int index);
void history_set_thread_id(const char* thread_id);
void history_set_done(void);
void history_push_prompt(const char* text);
void history_push_response(const char* text);
void history_push_thread_id(const char* thread_id);
bool history_is_available(void);
const char* history_get_thread_id(void);
int history_get_count(void);
const HistoryEntry* history_get_entry(int index);
void history_free(void);

#endif