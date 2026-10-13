#define _POSIX_C_SOURCE 200809L
#include <systemd/sd-bus.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define DBUS_NAME "org.freedesktop.DBus"
#define DBUS_PATH "/org/freedesktop/DBus"
#define DBUS_IFACE "org.freedesktop.DBus"
#define PORTAL_NAME "org.freedesktop.portal.Desktop"
#define BACKEND_NAME "org.freedesktop.impl.portal.desktop.hyprland"
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define SCREENCAST_IFACE "org.freedesktop.impl.portal.ScreenCast"
#define MAX_PENDING 2u
#define MAX_HANDLE_BYTES 1024u
#define MAX_TEXT_BYTES 512u
#define MAX_DICT_ENTRIES 64u
#define MAX_STARTS 2u
#define START_TIMEOUT_USEC (10ULL * 1000ULL * 1000ULL)
#define QUERY_TIMEOUT_USEC (1ULL * 1000ULL * 1000ULL)
#define MAX_COOKIE UINT32_MAX

#ifndef PORTAL_TEST_COUNTERS
#define PORTAL_TEST_COUNTERS 0
#endif

struct pending_start {
  bool active;
  uint64_t cookie;
  char portal_owner[128];
  char backend_owner[128];
  char requester_name[128];
  char request_handle[MAX_HANDLE_BYTES + 1u];
  char session_handle[MAX_HANDLE_BYTES + 1u];
  char app_id[MAX_TEXT_BYTES + 1u];
  uint32_t requester_pid;
  uint64_t started_at_usec;
};

struct completed_reply {
  bool valid;
  uint64_t cookie;
  char portal_owner[128];
  char backend_owner[128];
};

struct collector {
  sd_bus *monitor;
  sd_bus *query;
  char portal_owner[128];
  char backend_owner[128];
  char app_id[MAX_TEXT_BYTES + 1u];
  char backend_name[128];
  uint32_t main_pid;
  struct pending_start pending[MAX_PENDING];
  struct completed_reply completed[MAX_PENDING];
  unsigned starts_seen;
  unsigned completed_count;
  unsigned completed_cursor;
  bool test_counters;
  bool invalid;
#if PORTAL_TEST_COUNTERS
  unsigned body_reads;
  unsigned foreign_body_reads;
  unsigned reply_messages;
  unsigned reply_header_matches;
  unsigned reply_tuple_matches;
#endif
};

struct reply_metadata {
  uint32_t source_type;
  bool have_source_type;
  uint32_t stream_source_type;
  bool have_stream_source_type;
  char pipewire_serial[21];
  bool have_pipewire_serial;
  char mapping_id[MAX_TEXT_BYTES + 1u];
  bool have_mapping_id;
  char window_class[MAX_TEXT_BYTES + 1u];
  bool have_window_class;
  char output[MAX_TEXT_BYTES + 1u];
  bool have_output;
};

static volatile sig_atomic_t stop_requested;
#if PORTAL_TEST_COUNTERS
struct collector *portal_test_collector;
static bool portal_test_current_reply_foreign;
#endif

static void on_signal(int signal_number) {
  (void)signal_number;
  stop_requested = 1;
}

static uint64_t monotonic_usec(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return 0;
  return (uint64_t)now.tv_sec * 1000000ULL + (uint64_t)now.tv_nsec / 1000ULL;
}

static bool copy_bounded(char *destination, size_t capacity, const char *source, size_t maximum) {
  if (!destination || capacity == 0 || !source) return false;
  size_t length = strnlen(source, maximum + 1u);
  if (length == 0 || length > maximum || length >= capacity) return false;
  memcpy(destination, source, length + 1u);
  return true;
}

static bool valid_unique_name(const char *name) {
  if (!name || name[0] != ':' || name[1] != '1' || name[2] != '.') return false;
  const char *cursor = name + 3;
  if (!*cursor || strlen(name) >= 128u) return false;
  for (; *cursor; ++cursor) if (*cursor < '0' || *cursor > '9') return false;
  return true;
}

static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; ++cursor) {
    switch (*cursor) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\b': fputs("\\b", stdout); break;
      case '\f': fputs("\\f", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*cursor < 0x20) printf("\\u%04x", (unsigned)*cursor);
        else putchar(*cursor);
    }
  }
  putchar('"');
}

static void emit_invalid(struct collector *collector, const char *reason) {
  if (collector->invalid) return;
  collector->invalid = true;
  fputs("{\"event\":\"invalid\",\"reason\":", stdout);
  json_string(reason);
  fputs("}\n", stdout);
  fflush(stdout);
  fprintf(stderr, "portal metadata collector stopped: %s\n", reason);
}

static void emit_ready(const struct collector *collector, uint32_t backend_pid) {
  fputs("{\"event\":\"ready\",\"portalOwner\":", stdout);
  json_string(collector->portal_owner);
  fputs(",\"backendOwner\":", stdout);
  json_string(collector->backend_owner);
  printf(",\"backendPid\":%u}\n", backend_pid);
  fflush(stdout);
}

static void emit_start(const struct pending_start *start) {
  printf("{\"event\":\"start\",\"cookie\":%" PRIu64 ",\"requesterName\":", start->cookie);
  json_string(start->requester_name);
  printf(",\"requesterPid\":%u,\"appId\":", start->requester_pid);
  json_string(start->app_id);
  fputs("}\n", stdout);
  fflush(stdout);
}

static void emit_selection(uint64_t cookie, const struct reply_metadata *metadata) {
  printf("{\"event\":\"selection\",\"cookie\":%" PRIu64 ",\"sourceType\":%u,\"pipewireSerial\":",
         cookie, metadata->source_type);
  json_string(metadata->pipewire_serial);
  if (metadata->source_type == 1u) {
    fputs(",\"output\":", stdout);
    json_string(metadata->output);
  } else {
    fputs(",\"windowClass\":", stdout);
    json_string(metadata->window_class);
  }
  fputs("}\n", stdout);
  fflush(stdout);
}

static int get_name_owner(sd_bus *bus, const char *name, char *owner, size_t owner_size) {
  sd_bus_message *reply = NULL;
  sd_bus_error error = SD_BUS_ERROR_NULL;
  int result = sd_bus_call_method(bus, DBUS_NAME, DBUS_PATH, DBUS_IFACE, "GetNameOwner",
                                  &error, &reply, "s", name);
  const char *value = NULL;
  if (result >= 0) result = sd_bus_message_read(reply, "s", &value);
  if (result >= 0 && (!valid_unique_name(value) || !copy_bounded(owner, owner_size, value, 127u))) result = -EBADMSG;
  sd_bus_error_free(&error);
  sd_bus_message_unref(reply);
  return result;
}

static int get_connection_pid(sd_bus *bus, const char *name, uint32_t *pid) {
  sd_bus_message *reply = NULL;
  sd_bus_error error = SD_BUS_ERROR_NULL;
  int result = sd_bus_call_method(bus, DBUS_NAME, DBUS_PATH, DBUS_IFACE, "GetConnectionUnixProcessID",
                                  &error, &reply, "s", name);
  if (result >= 0) result = sd_bus_message_read(reply, "u", pid);
  if (result >= 0 && (*pid <= 1u || *pid > INT_MAX)) result = -ERANGE;
  sd_bus_error_free(&error);
  sd_bus_message_unref(reply);
  return result;
}

static bool owners_still_current(struct collector *collector) {
  char portal_owner[128] = {0};
  char backend_owner[128] = {0};
  if (get_name_owner(collector->query, PORTAL_NAME, portal_owner, sizeof(portal_owner)) < 0 ||
      get_name_owner(collector->query, collector->backend_name, backend_owner, sizeof(backend_owner)) < 0) return false;
  return strcmp(portal_owner, collector->portal_owner) == 0 &&
    strcmp(backend_owner, collector->backend_owner) == 0;
}

static bool destination_is_backend(const struct collector *collector, const char *destination) {
  return destination && (strcmp(destination, collector->backend_name) == 0 ||
                         strcmp(destination, collector->backend_owner) == 0);
}

static bool extract_path_requester(const char *path, const char *kind, char *unique_name, size_t unique_size) {
  if (!path || strnlen(path, MAX_HANDLE_BYTES + 1u) > MAX_HANDLE_BYTES) return false;
  char prefix[96];
  int prefix_length = snprintf(prefix, sizeof(prefix), "/org/freedesktop/portal/desktop/%s/1_", kind);
  if (prefix_length <= 0 || (size_t)prefix_length >= sizeof(prefix) || strncmp(path, prefix, (size_t)prefix_length) != 0) return false;
  const char *digits = path + prefix_length;
  const char *slash = strchr(digits, '/');
  if (!slash || slash == digits || (size_t)(slash - digits) > 10u) return false;
  for (const char *cursor = digits; cursor < slash; ++cursor) if (*cursor < '0' || *cursor > '9') return false;
  const char *token = slash + 1;
  if (!*token) return false;
  for (const char *cursor = token; *cursor; ++cursor)
    if (!((*cursor >= 'A' && *cursor <= 'Z') || (*cursor >= 'a' && *cursor <= 'z') ||
          (*cursor >= '0' && *cursor <= '9') || *cursor == '_')) return false;
  int written = snprintf(unique_name, unique_size, ":1.%.*s", (int)(slash - digits), digits);
  return written > 0 && (size_t)written < unique_size && valid_unique_name(unique_name);
}

static int find_pending(const struct collector *collector, uint64_t cookie,
                        const char *portal_owner, const char *backend_owner) {
  for (unsigned index = 0; index < MAX_PENDING; ++index) {
    const struct pending_start *pending = &collector->pending[index];
    if (pending->active && pending->cookie == cookie &&
        strcmp(pending->portal_owner, portal_owner) == 0 &&
        strcmp(pending->backend_owner, backend_owner) == 0) return (int)index;
  }
  return -1;
}

static bool is_completed(const struct collector *collector, uint64_t cookie,
                         const char *portal_owner, const char *backend_owner) {
  for (unsigned index = 0; index < MAX_PENDING; ++index) {
    const struct completed_reply *completed = &collector->completed[index];
    if (completed->valid && completed->cookie == cookie &&
        strcmp(completed->portal_owner, portal_owner) == 0 &&
        strcmp(completed->backend_owner, backend_owner) == 0) return true;
  }
  return false;
}

static int read_variant_u(sd_bus_message *message, uint32_t *value) {
  int result = sd_bus_message_enter_container(message, 'v', "u");
  if (result > 0) result = sd_bus_message_read(message, "u", value);
  if (result > 0) result = sd_bus_message_exit_container(message);
  return result < 0 ? result : result == 0 ? -EBADMSG : 0;
}

static int read_variant_t(sd_bus_message *message, uint64_t *value) {
  int result = sd_bus_message_enter_container(message, 'v', "t");
  if (result > 0) result = sd_bus_message_read(message, "t", value);
  if (result > 0) result = sd_bus_message_exit_container(message);
  return result < 0 ? result : result == 0 ? -EBADMSG : 0;
}

static int read_variant_s(sd_bus_message *message, char *value, size_t capacity) {
  const char *text = NULL;
  int result = sd_bus_message_enter_container(message, 'v', "s");
  if (result > 0) result = sd_bus_message_read(message, "s", &text);
  if (result > 0 && !copy_bounded(value, capacity, text, MAX_TEXT_BYTES)) result = -EBADMSG;
  if (result > 0) result = sd_bus_message_exit_container(message);
  return result < 0 ? result : result == 0 ? -EBADMSG : 0;
}

static int parse_stream_properties(sd_bus_message *message, struct reply_metadata *metadata) {
  int result = sd_bus_message_enter_container(message, 'a', "{sv}");
  if (result <= 0) return result < 0 ? result : -EBADMSG;
  unsigned entries = 0;
  bool seen_source = false, seen_serial = false, seen_mapping = false;
  while ((result = sd_bus_message_enter_container(message, 'e', "sv")) > 0) {
    const char *key = NULL;
    if (++entries > MAX_DICT_ENTRIES || sd_bus_message_read(message, "s", &key) <= 0 || !key) return -EBADMSG;
    if (strcmp(key, "source_type") == 0) {
      if (seen_source || read_variant_u(message, &metadata->stream_source_type) < 0) return -EBADMSG;
      seen_source = true;
      metadata->have_stream_source_type = true;
    } else if (strcmp(key, "pipewire-serial") == 0) {
      uint64_t serial = 0;
      if (seen_serial || read_variant_t(message, &serial) < 0 || serial == 0) return -EBADMSG;
      int written = snprintf(metadata->pipewire_serial, sizeof(metadata->pipewire_serial), "%" PRIu64, serial);
      if (written <= 0 || (size_t)written >= sizeof(metadata->pipewire_serial)) return -EBADMSG;
      seen_serial = true;
      metadata->have_pipewire_serial = true;
    } else if (strcmp(key, "mapping_id") == 0) {
      if (seen_mapping || read_variant_s(message, metadata->mapping_id, sizeof(metadata->mapping_id)) < 0) return -EBADMSG;
      seen_mapping = true;
      metadata->have_mapping_id = true;
    } else if (sd_bus_message_skip(message, "v") < 0) {
      return -EBADMSG;
    }
    if (sd_bus_message_exit_container(message) < 0) return -EBADMSG;
  }
  if (result < 0 || sd_bus_message_exit_container(message) < 0) return -EBADMSG;
  return 0;
}

static int parse_streams(sd_bus_message *message, struct reply_metadata *metadata) {
  int result = sd_bus_message_enter_container(message, 'a', "(ua{sv})");
  if (result <= 0) return result < 0 ? result : -EBADMSG;
  result = sd_bus_message_enter_container(message, 'r', "ua{sv}");
  if (result <= 0) return result < 0 ? result : -EBADMSG;
  uint32_t node_id = 0;
  if (sd_bus_message_read(message, "u", &node_id) <= 0 || node_id == 0 || parse_stream_properties(message, metadata) < 0 ||
      sd_bus_message_exit_container(message) < 0) return -EBADMSG;
  int extra = sd_bus_message_enter_container(message, 'r', "ua{sv}");
  if (extra != 0) return -EBADMSG;
  if (sd_bus_message_exit_container(message) < 0) return -EBADMSG;
  return 0;
}

static int parse_restore_properties(sd_bus_message *message, struct reply_metadata *metadata) {
  int result = sd_bus_message_enter_container(message, 'a', "{sv}");
  if (result <= 0) return result < 0 ? result : -EBADMSG;
  unsigned entries = 0;
  bool seen_class = false, seen_output = false;
  while ((result = sd_bus_message_enter_container(message, 'e', "sv")) > 0) {
    const char *key = NULL;
    if (++entries > MAX_DICT_ENTRIES || sd_bus_message_read(message, "s", &key) <= 0 || !key) return -EBADMSG;
    if (strcmp(key, "windowClass") == 0) {
      if (seen_class || read_variant_s(message, metadata->window_class, sizeof(metadata->window_class)) < 0) return -EBADMSG;
      seen_class = true;
      metadata->have_window_class = true;
    } else if (strcmp(key, "output") == 0) {
      if (seen_output || read_variant_s(message, metadata->output, sizeof(metadata->output)) < 0) return -EBADMSG;
      seen_output = true;
      metadata->have_output = true;
    } else if (sd_bus_message_skip(message, "v") < 0) {
      return -EBADMSG;
    }
    if (sd_bus_message_exit_container(message) < 0) return -EBADMSG;
  }
  if (result < 0 || sd_bus_message_exit_container(message) < 0) return -EBADMSG;
  return 0;
}

static int parse_restore_data(sd_bus_message *message, struct reply_metadata *metadata) {
  int result = sd_bus_message_enter_container(message, 'v', "(suv)");
  if (result <= 0) return result < 0 ? result : -EBADMSG;
  result = sd_bus_message_enter_container(message, 'r', "suv");
  if (result <= 0) return result < 0 ? result : -EBADMSG;
  const char *vendor = NULL;
  uint32_t version = 0;
  if (sd_bus_message_read(message, "su", &vendor, &version) <= 0 || !vendor ||
      strcmp(vendor, "hyprland") != 0 || version != 3u) return -EBADMSG;
  result = sd_bus_message_enter_container(message, 'v', "a{sv}");
  if (result <= 0 || parse_restore_properties(message, metadata) < 0 ||
      sd_bus_message_exit_container(message) < 0 || sd_bus_message_exit_container(message) < 0 ||
      sd_bus_message_exit_container(message) < 0) return -EBADMSG;
  return 0;
}

static int parse_owned_reply(sd_bus_message *message, struct reply_metadata *metadata) {
#if PORTAL_TEST_COUNTERS
  /* Sole reply-body decoder; the monitor passes only after header and tuple ownership checks. */
  if (portal_test_collector) {
    portal_test_collector->body_reads += 1u;
    if (portal_test_current_reply_foreign) portal_test_collector->foreign_body_reads += 1u;
  }
#endif
  const char *signature = sd_bus_message_get_signature(message, true);
  if (!signature || strcmp(signature, "ua{sv}") != 0) return -EBADMSG;
  uint32_t status = UINT32_MAX;
  if (sd_bus_message_read(message, "u", &status) <= 0 || status != 0u) return -EBADMSG;
  int result = sd_bus_message_enter_container(message, 'a', "{sv}");
  if (result <= 0) return result < 0 ? result : -EBADMSG;
  unsigned entries = 0;
  bool seen_source = false, seen_streams = false, seen_restore = false;
  while ((result = sd_bus_message_enter_container(message, 'e', "sv")) > 0) {
    const char *key = NULL;
    if (++entries > MAX_DICT_ENTRIES || sd_bus_message_read(message, "s", &key) <= 0 || !key) return -EBADMSG;
    if (strcmp(key, "source_type") == 0) {
      if (seen_source || read_variant_u(message, &metadata->source_type) < 0) return -EBADMSG;
      seen_source = true;
      metadata->have_source_type = true;
    } else if (strcmp(key, "streams") == 0) {
      if (seen_streams) return -EBADMSG;
      int variant = sd_bus_message_enter_container(message, 'v', "a(ua{sv})");
      if (variant <= 0 || parse_streams(message, metadata) < 0 || sd_bus_message_exit_container(message) < 0) return -EBADMSG;
      seen_streams = true;
    } else if (strcmp(key, "restore_data") == 0) {
      if (seen_restore || parse_restore_data(message, metadata) < 0) return -EBADMSG;
      seen_restore = true;
    } else if (sd_bus_message_skip(message, "v") < 0) {
      return -EBADMSG;
    }
    if (sd_bus_message_exit_container(message) < 0) return -EBADMSG;
  }
  if (result < 0 || sd_bus_message_exit_container(message) < 0) return -EBADMSG;
  if (!seen_source || !seen_streams || !seen_restore || !metadata->have_source_type ||
      (metadata->source_type != 1u && metadata->source_type != 2u) || !metadata->have_stream_source_type ||
      metadata->stream_source_type != metadata->source_type || !metadata->have_pipewire_serial) return -EBADMSG;
  if (metadata->source_type == 1u) {
    if (!metadata->have_output || !metadata->have_mapping_id ||
        strcmp(metadata->output, metadata->mapping_id) != 0) return -EBADMSG;
  } else if (!metadata->have_window_class) {
    return -EBADMSG;
  }
  return sd_bus_message_at_end(message, true) > 0 ? 0 : -EBADMSG;
}

static bool start_header_matches(const struct collector *collector, sd_bus_message *message) {
  uint8_t type = 0;
  const char *sender = sd_bus_message_get_sender(message);
  const char *destination = sd_bus_message_get_destination(message);
  const char *path = sd_bus_message_get_path(message);
  const char *interface = sd_bus_message_get_interface(message);
  const char *member = sd_bus_message_get_member(message);
  return sd_bus_message_get_type(message, &type) >= 0 && type == SD_BUS_MESSAGE_METHOD_CALL &&
    sender && strcmp(sender, collector->portal_owner) == 0 && destination_is_backend(collector, destination) &&
    path && strcmp(path, PORTAL_PATH) == 0 && interface && strcmp(interface, SCREENCAST_IFACE) == 0 &&
    member && strcmp(member, "Start") == 0;
}

static int process_start(struct collector *collector, sd_bus_message *message) {
  if (!start_header_matches(collector, message)) return 0;
  if (!owners_still_current(collector)) {
    emit_invalid(collector, "owner-changed");
    return -ESTALE;
  }
  uint64_t cookie = 0;
  if (sd_bus_message_get_cookie(message, &cookie) < 0 || cookie == 0 || cookie > MAX_COOKIE) {
    emit_invalid(collector, "malformed-owned-start-header");
    return -EBADMSG;
  }
  const char *signature = sd_bus_message_get_signature(message, true);
  const char *request_handle = NULL;
  const char *session_handle = NULL;
  if (!signature || strncmp(signature, "oo", 2u) != 0 || sd_bus_message_read(message, "oo", &request_handle, &session_handle) <= 0 ||
      !request_handle || !session_handle || strnlen(request_handle, MAX_HANDLE_BYTES + 1u) > MAX_HANDLE_BYTES ||
      strnlen(session_handle, MAX_HANDLE_BYTES + 1u) > MAX_HANDLE_BYTES) {
    emit_invalid(collector, "malformed-owned-start-prefix");
    return -EBADMSG;
  }
  char requester[128] = {0}, session_requester[128] = {0};
  bool valid_request_path = extract_path_requester(request_handle, "request", requester, sizeof(requester));
  bool valid_session_path = extract_path_requester(session_handle, "session", session_requester, sizeof(session_requester));
  if (!valid_request_path) {
    emit_invalid(collector, "malformed-request-path");
    return -EBADMSG;
  }
  uint32_t requester_pid = 0;
  if (get_connection_pid(collector->query, requester, &requester_pid) < 0) return 0;
  if (requester_pid != collector->main_pid) return 0;
  if (!valid_session_path || strcmp(requester, session_requester) != 0) {
    emit_invalid(collector, "mismatched-owned-session");
    return -EBADMSG;
  }
  if (!signature || strcmp(signature, "oossa{sv}") != 0) {
    emit_invalid(collector, "malformed-owned-start-signature");
    return -EBADMSG;
  }
  const char *app_id = NULL;
  if (sd_bus_message_read(message, "s", &app_id) <= 0 || !app_id ||
      strnlen(app_id, MAX_TEXT_BYTES + 1u) > MAX_TEXT_BYTES ||
      (app_id[0] != '\0' && strcmp(app_id, collector->app_id) != 0)) {
    emit_invalid(collector, "invalid-owned-app-id");
    return -EBADMSG;
  }
  if (!owners_still_current(collector)) {
    emit_invalid(collector, "owner-changed");
    return -ESTALE;
  }
  if (collector->starts_seen >= MAX_STARTS || find_pending(collector, cookie, collector->portal_owner, collector->backend_owner) >= 0 ||
      is_completed(collector, cookie, collector->portal_owner, collector->backend_owner)) {
    emit_invalid(collector, "duplicate-or-excess-start");
    return -E2BIG;
  }
  int slot = -1;
  for (unsigned index = 0; index < MAX_PENDING; ++index) if (!collector->pending[index].active) { slot = (int)index; break; }
  if (slot < 0) {
    emit_invalid(collector, "too-many-pending-starts");
    return -E2BIG;
  }
  struct pending_start *pending = &collector->pending[slot];
  memset(pending, 0, sizeof(*pending));
  pending->active = true;
  pending->cookie = cookie;
  pending->requester_pid = requester_pid;
  pending->started_at_usec = monotonic_usec();
  if (!copy_bounded(pending->portal_owner, sizeof(pending->portal_owner), collector->portal_owner, 127u) ||
      !copy_bounded(pending->backend_owner, sizeof(pending->backend_owner), collector->backend_owner, 127u) ||
      !copy_bounded(pending->requester_name, sizeof(pending->requester_name), requester, 127u) ||
      !copy_bounded(pending->request_handle, sizeof(pending->request_handle), request_handle, MAX_HANDLE_BYTES) ||
      !copy_bounded(pending->session_handle, sizeof(pending->session_handle), session_handle, MAX_HANDLE_BYTES) ||
      (app_id[0] && !copy_bounded(pending->app_id, sizeof(pending->app_id), app_id, MAX_TEXT_BYTES))) {
    memset(pending, 0, sizeof(*pending));
    emit_invalid(collector, "malformed-owned-start");
    return -EBADMSG;
  }
  if (!app_id[0]) pending->app_id[0] = '\0';
  ++collector->starts_seen;
  emit_start(pending);
  return 0;
}

static int process_reply(struct collector *collector, sd_bus_message *message) {
  uint8_t type = 0;
  if (sd_bus_message_get_type(message, &type) < 0 ||
      (type != SD_BUS_MESSAGE_METHOD_RETURN && type != SD_BUS_MESSAGE_METHOD_ERROR)) return 0;
#if PORTAL_TEST_COUNTERS
  collector->reply_messages += 1u;
  portal_test_current_reply_foreign = true;
#endif
  const char *sender = sd_bus_message_get_sender(message);
  const char *destination = sd_bus_message_get_destination(message);
  if (!sender || !destination || strcmp(sender, collector->backend_owner) != 0 ||
      strcmp(destination, collector->portal_owner) != 0) return 0;
#if PORTAL_TEST_COUNTERS
  collector->reply_header_matches += 1u;
#endif
  if (!owners_still_current(collector)) {
    emit_invalid(collector, "owner-changed");
    return -ESTALE;
  }
  uint64_t reply_cookie = 0;
  if (sd_bus_message_get_reply_cookie(message, &reply_cookie) < 0 || reply_cookie == 0 || reply_cookie > MAX_COOKIE) return 0;
  int slot = find_pending(collector, reply_cookie, destination, sender);
  if (slot < 0) {
    if (is_completed(collector, reply_cookie, destination, sender)) {
      emit_invalid(collector, "duplicate-owned-reply");
      return -EBADMSG;
    }
#if PORTAL_TEST_COUNTERS
    /* This counter is a guard: unmatched tuple/cookie replies must never enter the body parser. */
    (void)collector->foreign_body_reads;
#endif
    return 0;
  }
#if PORTAL_TEST_COUNTERS
  portal_test_current_reply_foreign = false;
  collector->reply_tuple_matches += 1u;
#endif
  struct pending_start pending = collector->pending[slot];
  if (type == SD_BUS_MESSAGE_METHOD_ERROR) {
    memset(&collector->pending[slot], 0, sizeof(collector->pending[slot]));
    emit_invalid(collector, "owned-start-error");
    return -EBADMSG;
  }
  struct reply_metadata metadata = {0};
  if (parse_owned_reply(message, &metadata) < 0) {
    memset(&collector->pending[slot], 0, sizeof(collector->pending[slot]));
    emit_invalid(collector, "malformed-owned-reply");
    return -EBADMSG;
  }
  memset(&collector->pending[slot], 0, sizeof(collector->pending[slot]));
  struct completed_reply *completed = &collector->completed[collector->completed_cursor++ % MAX_PENDING];
  completed->valid = true;
  completed->cookie = reply_cookie;
  memcpy(completed->portal_owner, pending.portal_owner, sizeof(completed->portal_owner));
  memcpy(completed->backend_owner, pending.backend_owner, sizeof(completed->backend_owner));
  if (collector->completed_count < MAX_PENDING) ++collector->completed_count;
  emit_selection(reply_cookie, &metadata);
  return 0;
}

static int setup_monitor(struct collector *collector) {
  char start_name_rule[512], start_owner_rule[512], reply_rule[512], error_rule[512];
  snprintf(start_name_rule, sizeof(start_name_rule),
           "type='method_call',sender='%s',destination='%s',path='%s',interface='%s',member='Start'",
           collector->portal_owner, collector->backend_name, PORTAL_PATH, SCREENCAST_IFACE);
  snprintf(start_owner_rule, sizeof(start_owner_rule),
           "type='method_call',sender='%s',destination='%s',path='%s',interface='%s',member='Start'",
           collector->portal_owner, collector->backend_owner, PORTAL_PATH, SCREENCAST_IFACE);
  snprintf(reply_rule, sizeof(reply_rule), "type='method_return',sender='%s',destination='%s'",
           collector->backend_owner, collector->portal_owner);
  snprintf(error_rule, sizeof(error_rule), "type='error',sender='%s',destination='%s'",
           collector->backend_owner, collector->portal_owner);
  const char *rules[] = {
    start_name_rule,
    start_owner_rule,
    reply_rule,
    error_rule,
    "type='signal',sender='org.freedesktop.DBus',path='/org/freedesktop/DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'",
    NULL
  };
  sd_bus_message *call = NULL, *reply = NULL;
  sd_bus_error error = SD_BUS_ERROR_NULL;
  int result = sd_bus_message_new_method_call(collector->monitor, &call, DBUS_NAME, DBUS_PATH,
                                               "org.freedesktop.DBus.Monitoring", "BecomeMonitor");
  if (result >= 0) result = sd_bus_message_append_strv(call, (char **)rules);
  if (result >= 0) result = sd_bus_message_append(call, "u", 0u);
  if (result >= 0) result = sd_bus_call(collector->monitor, call, 0, &error, &reply);
  sd_bus_error_free(&error);
  sd_bus_message_unref(reply);
  sd_bus_message_unref(call);
  return result;
}

static bool parse_positive_pid(const char *value, uint32_t *pid) {
  if (!value || !*value) return false;
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 10);
  if (errno || !end || *end || parsed <= 1ul || parsed > INT_MAX) return false;
  *pid = (uint32_t)parsed;
  return true;
}

static int parse_args(int argc, char **argv, struct collector *collector) {
  const char *pid = NULL;
  const char *app_id = "sharkord-desktop";
  const char *backend_name = BACKEND_NAME;
  for (int index = 1; index < argc; ++index) {
    if (strcmp(argv[index], "--pid") == 0 && index + 1 < argc) pid = argv[++index];
    else if (strcmp(argv[index], "--app-id") == 0 && index + 1 < argc) app_id = argv[++index];
    else if (strcmp(argv[index], "--backend-name") == 0 && index + 1 < argc) backend_name = argv[++index];
#if PORTAL_TEST_COUNTERS
    else if (strcmp(argv[index], "--test-counters") == 0) collector->test_counters = true;
#endif
    else return -EINVAL;
  }
  if (!parse_positive_pid(pid, &collector->main_pid) ||
      !app_id || strnlen(app_id, MAX_TEXT_BYTES + 1u) > MAX_TEXT_BYTES ||
      strcmp(backend_name, BACKEND_NAME) != 0 ||
      !copy_bounded(collector->backend_name, sizeof(collector->backend_name), backend_name, 127u)) return -EINVAL;
  memcpy(collector->app_id, app_id, strlen(app_id) + 1u);
  return 0;
}

static int run_collector(struct collector *collector) {
  int result = sd_bus_open_user(&collector->query);
  if (result < 0) { fprintf(stderr, "portal metadata collector startup: query bus (%d)\n", result); return result; }
  result = sd_bus_set_method_call_timeout(collector->query, QUERY_TIMEOUT_USEC);
  if (result < 0) { fprintf(stderr, "portal metadata collector startup: query timeout (%d)\n", result); return result; }
  result = sd_bus_open_user(&collector->monitor);
  if (result < 0) { fprintf(stderr, "portal metadata collector startup: monitor bus (%d)\n", result); return result; }
  result = get_name_owner(collector->query, PORTAL_NAME, collector->portal_owner, sizeof(collector->portal_owner));
  if (result < 0) { fprintf(stderr, "portal metadata collector startup: portal owner (%d)\n", result); return result; }
  result = get_name_owner(collector->query, collector->backend_name, collector->backend_owner, sizeof(collector->backend_owner));
  if (result < 0) { fprintf(stderr, "portal metadata collector startup: backend owner (%d)\n", result); return result; }
  uint32_t backend_pid = 0;
  result = get_connection_pid(collector->query, collector->backend_owner, &backend_pid);
  if (result < 0) { fprintf(stderr, "portal metadata collector startup: backend pid (%d)\n", result); return result; }
  result = setup_monitor(collector);
  if (result < 0) { fprintf(stderr, "portal metadata collector startup: install monitor (%d)\n", result); return result; }
  if (!owners_still_current(collector)) { fprintf(stderr, "portal metadata collector startup: owners changed\n"); return -ESTALE; }
  emit_ready(collector, backend_pid);

  while (!stop_requested && !collector->invalid) {
    sd_bus_message *message = NULL;
    result = sd_bus_process(collector->monitor, &message);
    if (result < 0) {
      emit_invalid(collector, "monitor-failed");
      break;
    }
    if (result > 0 && message) {
      uint8_t type = 0;
      sd_bus_message_get_type(message, &type);
      if (type == SD_BUS_MESSAGE_SIGNAL) {
        const char *sender = sd_bus_message_get_sender(message);
        const char *path = sd_bus_message_get_path(message);
        const char *interface = sd_bus_message_get_interface(message);
        const char *member = sd_bus_message_get_member(message);
        if (sender && strcmp(sender, DBUS_NAME) == 0 && path && strcmp(path, DBUS_PATH) == 0 &&
            interface && strcmp(interface, DBUS_IFACE) == 0 && member && strcmp(member, "NameOwnerChanged") == 0 &&
            !owners_still_current(collector)) emit_invalid(collector, "owner-changed");
      } else if (type == SD_BUS_MESSAGE_METHOD_CALL) {
        (void)process_start(collector, message);
      } else if (type == SD_BUS_MESSAGE_METHOD_RETURN || type == SD_BUS_MESSAGE_METHOD_ERROR) {
        (void)process_reply(collector, message);
      }
      sd_bus_message_unref(message);
    }
    uint64_t now = monotonic_usec();
    for (unsigned index = 0; index < MAX_PENDING && !collector->invalid; ++index) {
      struct pending_start *pending = &collector->pending[index];
      if (pending->active && now > pending->started_at_usec && now - pending->started_at_usec > START_TIMEOUT_USEC)
        emit_invalid(collector, "owned-start-timeout");
    }
    if (!stop_requested && !collector->invalid && result == 0) {
      result = sd_bus_wait(collector->monitor, 50000u);
      if (result < 0 && result != -EINTR) emit_invalid(collector, "monitor-failed");
    }
  }
#if PORTAL_TEST_COUNTERS
  if (collector->test_counters) {
    fprintf(stderr, "TEST_COUNTS bodyReads=%u foreignBodyReads=%u replyMessages=%u replyHeaderMatches=%u replyTupleMatches=%u\n",
            collector->body_reads, collector->foreign_body_reads, collector->reply_messages,
            collector->reply_header_matches, collector->reply_tuple_matches);
  }
#endif
  return collector->invalid ? 1 : 0;
}

int main(int argc, char **argv) {
  struct collector collector = {0};
#if PORTAL_TEST_COUNTERS
  portal_test_collector = &collector;
#endif
  if (parse_args(argc, argv, &collector) < 0) {
    fprintf(stderr, "portal metadata collector: invalid arguments\n");
    return 2;
  }
  (void)setvbuf(stdout, NULL, _IOLBF, 0);
  (void)signal(SIGTERM, on_signal);
  (void)signal(SIGINT, on_signal);
  int result = run_collector(&collector);
  if (result < 0 && !collector.invalid) {
    emit_invalid(&collector, "startup-failed");
    result = 1;
  }
  sd_bus_flush(collector.monitor);
  sd_bus_flush(collector.query);
  sd_bus_unref(collector.monitor);
  sd_bus_unref(collector.query);
  return result < 0 ? 1 : result;
}
