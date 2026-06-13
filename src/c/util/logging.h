//
// Created by Katharine Berry on 4/9/25.
//

#pragma once

#include <pebble.h>

#include "debug_state.h"

#ifdef SQUIRE_DEBUG_LEVEL
#define SQUIRE_LOG(level, ...) do {if (level <= SQUIRE_DEBUG_LEVEL) APP_LOG(level, __VA_ARGS__);} while (0)
#else
#define SQUIRE_LOG(level, ...) do {} while (0)
#endif
