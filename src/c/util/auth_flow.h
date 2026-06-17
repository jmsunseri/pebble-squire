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

#ifndef AUTH_FLOW_H
#define AUTH_FLOW_H

#include <pebble.h>

typedef void (*AuthFlowCompleteCallback)(bool success);

void auth_flow_start(AuthFlowCompleteCallback callback);
void auth_flow_handle_message(uint32_t key);
void auth_flow_cancel(void);

#endif // AUTH_FLOW_H
