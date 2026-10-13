#define _GNU_SOURCE
#include <systemd/sd-bus.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define PORTAL_NAME "org.freedesktop.portal.Desktop"
#define BACKEND_NAME "org.freedesktop.impl.portal.desktop.hyprland"
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define SCREENCAST_IFACE "org.freedesktop.impl.portal.ScreenCast"
#define BUFFER_SIZE (64u * 1024u)

struct fixture {
  sd_bus *frontend;
  sd_bus *backend;
  char foreign_id[32];
  char scenario[32];
  unsigned backend_calls;
  unsigned frontend_replies;
  sd_bus_slot *call_slots[2];
};

static char helper_stdout[BUFFER_SIZE];
static size_t helper_stdout_size;
static char helper_stderr[BUFFER_SIZE];
static size_t helper_stderr_size;
static int helper_out_fd = -1;
static int helper_err_fd = -1;
static pid_t helper_pid = -1;

static int fail(const char *stage, int result) {
  if (result >= 0) return 0;
  fprintf(stderr, "fixture %s failed (%d)\n", stage, result);
  return 1;
}

static void append_capture(int fd, char *buffer, size_t *size) {
  char chunk[4096];
  for (;;) {
    ssize_t count = read(fd, chunk, sizeof(chunk));
    if (count > 0) {
      size_t remaining = BUFFER_SIZE - 1u - *size;
      size_t copy = (size_t)count < remaining ? (size_t)count : remaining;
      memcpy(buffer + *size, chunk, copy);
      *size += copy;
      buffer[*size] = '\0';
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    return;
  }
}

static void pump_helper(void) {
  if (helper_out_fd >= 0) append_capture(helper_out_fd, helper_stdout, &helper_stdout_size);
  if (helper_err_fd >= 0) append_capture(helper_err_fd, helper_stderr, &helper_stderr_size);
}

static int make_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int create_foreign_connection(char *unique_name, size_t name_size, int *release_fd, pid_t *pid_out) {
  int ready[2], release[2];
  if (pipe(ready) < 0 || pipe(release) < 0) return -1;
  pid_t child = fork();
  if (child < 0) return -1;
  if (child == 0) {
    close(ready[0]);
    close(release[1]);
    sd_bus *bus = NULL;
    const char *name = NULL;
    if (sd_bus_open_user(&bus) < 0 || sd_bus_get_unique_name(bus, &name) < 0 || !name) _exit(2);
    if (write(ready[1], name, strlen(name) + 1u) < 0) _exit(3);
    char byte;
    (void)read(release[0], &byte, 1);
    sd_bus_unref(bus);
    _exit(0);
  }
  close(ready[1]);
  close(release[0]);
  ssize_t count = read(ready[0], unique_name, name_size);
  close(ready[0]);
  if (count <= 0 || (size_t)count >= name_size) return -1;
  unique_name[count] = '\0';
  *release_fd = release[1];
  *pid_out = child;
  return 0;
}

static int open_entry(sd_bus_message *message, const char *key) {
  int result = sd_bus_message_open_container(message, 'e', "sv");
  if (result < 0) return result;
  return sd_bus_message_append(message, "s", key);
}

static int close_entry(sd_bus_message *message) {
  int result = sd_bus_message_close_container(message);
  if (result < 0) return result;
  return sd_bus_message_close_container(message);
}

static int add_u(sd_bus_message *message, const char *key, uint32_t value) {
  int result = open_entry(message, key);
  if (result >= 0) result = sd_bus_message_open_container(message, 'v', "u");
  if (result >= 0) result = sd_bus_message_append(message, "u", value);
  if (result >= 0) result = close_entry(message);
  return result;
}

static int add_t(sd_bus_message *message, const char *key, uint64_t value) {
  int result = open_entry(message, key);
  if (result >= 0) result = sd_bus_message_open_container(message, 'v', "t");
  if (result >= 0) result = sd_bus_message_append(message, "t", value);
  if (result >= 0) result = close_entry(message);
  return result;
}

static int add_s(sd_bus_message *message, const char *key, const char *value) {
  int result = open_entry(message, key);
  if (result >= 0) result = sd_bus_message_open_container(message, 'v', "s");
  if (result >= 0) result = sd_bus_message_append(message, "s", value);
  if (result >= 0) result = close_entry(message);
  return result;
}

static int add_streams(sd_bus_message *message, int foreign) {
  int result = open_entry(message, "streams");
  if (result >= 0) result = sd_bus_message_open_container(message, 'v', "a(ua{sv})");
  if (result >= 0) result = sd_bus_message_open_container(message, 'a', "(ua{sv})");
  if (result >= 0) result = sd_bus_message_open_container(message, 'r', "ua{sv}");
  if (result >= 0) result = sd_bus_message_append(message, "u", 51u);
  if (result >= 0) result = sd_bus_message_open_container(message, 'a', "{sv}");
  if (result >= 0) result = add_u(message, "source_type", 2u);
  if (result >= 0) result = add_t(message, "pipewire-serial", 901u);
  if (result >= 0) result = add_s(message, "unused-private-field", foreign ? "FOREIGN_SECRET_SENTINEL" : "OWN_PRIVATE_SENTINEL");
  if (result >= 0) result = sd_bus_message_close_container(message);
  if (result >= 0) result = sd_bus_message_close_container(message);
  if (result >= 0) result = sd_bus_message_close_container(message);
  if (result >= 0) result = close_entry(message);
  return result;
}

static int add_restore(sd_bus_message *message, int foreign) {
  int result = open_entry(message, "restore_data");
  if (result >= 0) result = sd_bus_message_open_container(message, 'v', "(suv)");
  if (result >= 0) result = sd_bus_message_open_container(message, 'r', "suv");
  if (result >= 0) result = sd_bus_message_append(message, "su", "hyprland", 3u);
  if (result >= 0) result = sd_bus_message_open_container(message, 'v', "a{sv}");
  if (result >= 0) result = sd_bus_message_open_container(message, 'a', "{sv}");
  if (result >= 0) result = add_s(message, "windowClass", foreign ? "FOREIGN_SECRET_SENTINEL" : "fixture-class");
  if (result >= 0) result = add_t(message, "windowHandle", 812u);
  if (result >= 0) result = add_s(message, "token", foreign ? "FOREIGN_SECRET_SENTINEL" : "OWN_TOKEN_SENTINEL");
  if (result >= 0) result = add_t(message, "timeIssued", 1791830000u);
  if (result >= 0) result = sd_bus_message_close_container(message);
  if (result >= 0) result = sd_bus_message_close_container(message);
  if (result >= 0) result = sd_bus_message_close_container(message);
  if (result >= 0) result = close_entry(message);
  return result;
}

static int send_success_reply(sd_bus *bus, sd_bus_message *call, int foreign) {
  sd_bus_message *reply = NULL;
  int result = sd_bus_message_new_method_return(call, &reply);
  if (result >= 0) result = sd_bus_message_append(reply, "u", 0u);
  if (result >= 0) result = sd_bus_message_open_container(reply, 'a', "{sv}");
  if (result >= 0) result = add_u(reply, "source_type", 2u);
  if (result >= 0) result = add_streams(reply, foreign);
  if (result >= 0) result = add_restore(reply, foreign);
  if (result >= 0) result = sd_bus_message_close_container(reply);
  if (result >= 0) result = sd_bus_send(bus, reply, NULL);
  if (result >= 0) result = sd_bus_flush(bus);
  sd_bus_message_unref(reply);
  return result;
}

static int send_malformed_reply(sd_bus *bus, sd_bus_message *call) {
  sd_bus_message *reply = NULL;
  int result = sd_bus_message_new_method_return(call, &reply);
  if (result >= 0) result = sd_bus_message_append(reply, "s", "OWN_MALFORMED_SECRET");
  if (result >= 0) result = sd_bus_send(bus, reply, NULL);
  if (result >= 0) result = sd_bus_flush(bus);
  sd_bus_message_unref(reply);
  return result;
}

static int frontend_reply(sd_bus_message *message, void *userdata, sd_bus_error *ret_error) {
  (void)message;
  (void)ret_error;
  struct fixture *fixture = userdata;
  fixture->frontend_replies += 1u;
  return 1;
}

static int backend_method(sd_bus_message *message, void *userdata, sd_bus_error *ret_error) {
  (void)ret_error;
  struct fixture *fixture = userdata;
  const char *request = NULL;
  const char *session = NULL;
  int result = sd_bus_message_read(message, "oo", &request, &session);
  if (result < 0 || !request || !session) return result < 0 ? result : -EINVAL;
  fixture->backend_calls += 1u;
  int foreign = strstr(request, fixture->foreign_id) != NULL;
  if (strcmp(fixture->scenario, "cancel") == 0 && !foreign) return 1;
  if (strcmp(fixture->scenario, "malformed") == 0 && !foreign) return send_malformed_reply(fixture->backend, message);
  result = send_success_reply(fixture->backend, message, foreign);
  if (result >= 0 && strcmp(fixture->scenario, "duplicate") == 0 && !foreign) {
    result = send_success_reply(fixture->backend, message, foreign);
  }
  return result < 0 ? result : 1;
}

static int create_portal_paths(const char *unique_name, char *request, size_t request_size, char *session, size_t session_size) {
  const char *dot = strchr(unique_name, '.');
  if (!dot || !dot[1]) return -1;
  char numeric[24];
  if (snprintf(numeric, sizeof(numeric), "%s", dot + 1) >= (int)sizeof(numeric)) return -1;
  int a = snprintf(request, request_size, "/org/freedesktop/portal/desktop/request/1_%s/fixture", numeric);
  int b = snprintf(session, session_size, "/org/freedesktop/portal/desktop/session/1_%s/fixture_session", numeric);
  return a > 0 && b > 0 && (size_t)a < request_size && (size_t)b < session_size ? 0 : -1;
}

static int send_start(sd_bus *frontend, const char *unique_name, struct fixture *fixture, unsigned slot_index) {
  char request[256], session[256];
  int result = create_portal_paths(unique_name, request, sizeof(request), session, sizeof(session));
  if (result < 0) return result;
  sd_bus_message *message = NULL;
  result = sd_bus_message_new_method_call(frontend, &message, BACKEND_NAME, PORTAL_PATH, SCREENCAST_IFACE, "Start");
  if (result >= 0) result = sd_bus_message_append(message, "ooss", request, session, "sharkord-desktop", "");
  if (result >= 0) result = sd_bus_message_open_container(message, 'a', "{sv}");
  if (result >= 0) result = sd_bus_message_close_container(message);
  if (result >= 0) result = sd_bus_call_async(frontend, &fixture->call_slots[slot_index], message,
                                               frontend_reply, fixture, 5000000u);
  sd_bus_message_unref(message);
  return result;
}

static unsigned count_token(const char *text, const char *token) {
  unsigned count = 0;
  size_t length = strlen(token);
  for (const char *cursor = text; (cursor = strstr(cursor, token)) != NULL; cursor += length) ++count;
  return count;
}

static int wait_until(const char *token, unsigned backend_calls, unsigned timeout_ms, struct fixture *fixture) {
  struct timespec start, now;
  clock_gettime(CLOCK_MONOTONIC, &start);
  for (;;) {
    pump_helper();
    while (sd_bus_process(fixture->backend, NULL) > 0) {}
    while (sd_bus_process(fixture->frontend, NULL) > 0) {}
    pump_helper();
    if ((!token || strstr(helper_stdout, token)) && fixture->backend_calls >= backend_calls) return 0;
    clock_gettime(CLOCK_MONOTONIC, &now);
    uint64_t elapsed = (uint64_t)(now.tv_sec - start.tv_sec) * 1000u +
      (uint64_t)(now.tv_nsec - start.tv_nsec + 1000000000L) / 1000000u - 1000u;
    if (elapsed >= timeout_ms) return -1;
    struct pollfd fds[] = {{ .fd = helper_out_fd, .events = POLLIN }, { .fd = helper_err_fd, .events = POLLIN }};
    (void)poll(fds, 2, 5);
  }
}

static int start_helper(const char *path, pid_t expected_pid) {
  int output[2], errors[2];
  if (pipe(output) < 0 || pipe(errors) < 0) return -1;
  helper_pid = fork();
  if (helper_pid < 0) return -1;
  if (helper_pid == 0) {
    close(output[0]);
    close(errors[0]);
    dup2(output[1], STDOUT_FILENO);
    dup2(errors[1], STDERR_FILENO);
    close(output[1]);
    close(errors[1]);
    char pid_text[32];
    snprintf(pid_text, sizeof(pid_text), "%ld", (long)expected_pid);
    execl(path, path, "--pid", pid_text, "--app-id", "sharkord-desktop", "--backend-name", BACKEND_NAME, "--test-counters", (char *)NULL);
    _exit(127);
  }
  close(output[1]);
  close(errors[1]);
  helper_out_fd = output[0];
  helper_err_fd = errors[0];
  if (make_nonblocking(helper_out_fd) < 0 || make_nonblocking(helper_err_fd) < 0) return -1;
  return 0;
}

static void stop_helper(void) {
  if (helper_pid <= 0) return;
  (void)kill(helper_pid, SIGTERM);
  int status = 0;
  (void)waitpid(helper_pid, &status, 0);
  pump_helper();
  helper_pid = -1;
  if (helper_out_fd >= 0) close(helper_out_fd);
  if (helper_err_fd >= 0) close(helper_err_fd);
  helper_out_fd = helper_err_fd = -1;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s <native-helper-path> <scenario>\n", argv[0]);
    return 2;
  }
  struct fixture fixture = {0};
  if (strlen(argv[2]) >= sizeof(fixture.scenario)) return 2;
  memcpy(fixture.scenario, argv[2], strlen(argv[2]) + 1u);
  const char *scenarios[] = {"happy", "malformed", "duplicate", "owner-change", "no-pid", "cancel"};
  int known_scenario = 0;
  for (size_t index = 0; index < sizeof(scenarios) / sizeof(scenarios[0]); ++index)
    if (strcmp(fixture.scenario, scenarios[index]) == 0) known_scenario = 1;
  if (!known_scenario) return 2;

  sd_bus *app = NULL;
  sd_bus_slot *backend_slot = NULL;
  const char *app_name = NULL;
  char foreign_name[64] = {0};
  int foreign_release_fd = -1;
  pid_t foreign_pid = 0;
  int result = 1;
  if (fail("frontend connection", sd_bus_open_user(&fixture.frontend)) ||
      fail("backend connection", sd_bus_open_user(&fixture.backend)) ||
      fail("app connection", sd_bus_open_user(&app))) goto finish;
  if (fail("frontend name", sd_bus_request_name(fixture.frontend, PORTAL_NAME, 0)) ||
      fail("backend name", sd_bus_request_name(fixture.backend, BACKEND_NAME, 0)) ||
      fail("app unique name", sd_bus_get_unique_name(app, &app_name))) goto finish;
  if (create_foreign_connection(foreign_name, sizeof(foreign_name), &foreign_release_fd, &foreign_pid) < 0) {
    fprintf(stderr, "fixture foreign connection failed\n");
    goto finish;
  }
  const char *foreign_dot = strchr(foreign_name, '.');
  if (!foreign_dot || snprintf(fixture.foreign_id, sizeof(fixture.foreign_id), "1_%s", foreign_dot + 1) >= (int)sizeof(fixture.foreign_id)) {
    fprintf(stderr, "fixture foreign id is invalid\n");
    goto finish;
  }
  if (strcmp(fixture.scenario, "no-pid") == 0) {
    snprintf(fixture.foreign_id, sizeof(fixture.foreign_id), "1_9999999");
  }
  if (fail("backend method registration", sd_bus_add_object(fixture.backend, &backend_slot, PORTAL_PATH, backend_method, &fixture))) goto finish;
  if (start_helper(argv[1], getpid()) < 0) {
    fprintf(stderr, "fixture helper start failed\n");
    goto finish;
  }
  if (wait_until("\"event\":\"ready\"", 0, 3000, &fixture) < 0) {
    stop_helper();
    fprintf(stderr, "native helper did not report ready\nstdout=%s\nstderr=%s\n", helper_stdout, helper_stderr);
    goto finish;
  }

  if (strcmp(fixture.scenario, "happy") == 0) {
    if (send_start(fixture.frontend, app_name, &fixture, 0) < 0 ||
        send_start(fixture.frontend, foreign_name, &fixture, 1) < 0 ||
        wait_until("\"event\":\"selection\"", 2, 4000, &fixture) < 0) goto unexpected;
    struct timespec settle = {.tv_sec = 0, .tv_nsec = 150000000};
    nanosleep(&settle, NULL);
    pump_helper();
    if (fixture.frontend_replies != 2 || count_token(helper_stdout, "\"event\":\"start\"") != 1 ||
        count_token(helper_stdout, "\"event\":\"selection\"") != 1 ||
        strstr(helper_stdout, "FOREIGN_SECRET_SENTINEL") || strstr(helper_stdout, "OWN_TOKEN_SENTINEL") ||
        strstr(helper_stdout, "windowHandle") || strstr(helper_stderr, "FOREIGN_SECRET_SENTINEL") ||
        strstr(helper_stderr, "OWN_TOKEN_SENTINEL")) goto unexpected;
    stop_helper();
    if (!strstr(helper_stderr, "TEST_COUNTS bodyReads=1 foreignBodyReads=0")) goto unexpected;
    printf("private-bus happy passed: own start+selection only; foreign reply body reads=0; private sentinels absent\n");
    result = 0;
  } else if (strcmp(fixture.scenario, "malformed") == 0) {
    if (send_start(fixture.frontend, app_name, &fixture, 0) < 0 ||
        wait_until("\"event\":\"invalid\"", 1, 3000, &fixture) < 0 ||
        strstr(helper_stdout, "OWN_MALFORMED_SECRET") || strstr(helper_stderr, "OWN_MALFORMED_SECRET") ||
        strstr(helper_stdout, "\"event\":\"selection\"")) goto unexpected;
    stop_helper();
    if (!strstr(helper_stderr, "TEST_COUNTS bodyReads=1 foreignBodyReads=0")) goto unexpected;
    printf("private-bus malformed-owned-reply passed: invalidated without forwarding body\n");
    result = 0;
  } else if (strcmp(fixture.scenario, "duplicate") == 0) {
    if (send_start(fixture.frontend, app_name, &fixture, 0) < 0 ||
        wait_until("\"event\":\"invalid\"", 1, 3000, &fixture) < 0 ||
        !strstr(helper_stdout, "duplicate-owned-reply") || count_token(helper_stdout, "\"event\":\"selection\"") != 1) goto unexpected;
    stop_helper();
    if (!strstr(helper_stderr, "TEST_COUNTS bodyReads=1 foreignBodyReads=0")) goto unexpected;
    printf("private-bus duplicate-owned-reply passed: second body not decoded, observer invalidated\n");
    result = 0;
  } else if (strcmp(fixture.scenario, "owner-change") == 0) {
    if (sd_bus_release_name(fixture.backend, BACKEND_NAME) < 0 ||
        wait_until("\"event\":\"invalid\"", 0, 3000, &fixture) < 0 ||
        !strstr(helper_stdout, "owner-changed") || strstr(helper_stdout, "\"event\":\"selection\"")) goto unexpected;
    stop_helper();
    if (!strstr(helper_stderr, "TEST_COUNTS bodyReads=0 foreignBodyReads=0")) goto unexpected;
    printf("private-bus owner-change passed: observer invalidated before accepting metadata\n");
    result = 0;
  } else if (strcmp(fixture.scenario, "no-pid") == 0) {
    if (send_start(fixture.frontend, ":1.9999999", &fixture, 0) < 0 || wait_until(NULL, 1, 3000, &fixture) < 0) goto unexpected;
    struct timespec settle = {.tv_sec = 0, .tv_nsec = 150000000};
    nanosleep(&settle, NULL);
    pump_helper();
    if (strstr(helper_stdout, "\"event\":\"start\"") || strstr(helper_stdout, "\"event\":\"selection\"") ||
        strstr(helper_stdout, "\"event\":\"invalid\"")) goto unexpected;
    stop_helper();
    if (!strstr(helper_stderr, "TEST_COUNTS bodyReads=0 foreignBodyReads=0")) goto unexpected;
    printf("private-bus missing-requester-PID passed: foreign request/reply ignored without body read\n");
    result = 0;
  } else if (strcmp(fixture.scenario, "cancel") == 0) {
    if (send_start(fixture.frontend, app_name, &fixture, 0) < 0 ||
        wait_until("\"event\":\"start\"", 1, 3000, &fixture) < 0) goto unexpected;
    stop_helper();
    if (strstr(helper_stdout, "\"event\":\"selection\"") ||
        !strstr(helper_stderr, "TEST_COUNTS bodyReads=0 foreignBodyReads=0")) goto unexpected;
    printf("private-bus cancellation passed: pending request stopped without late selection\n");
    result = 0;
  }
  goto finish;

unexpected:
  if (helper_pid > 0) stop_helper();
  fprintf(stderr, "private-bus scenario %s failed\nstdout=%s\nstderr=%s\nbackendCalls=%u frontendReplies=%u\n",
          fixture.scenario, helper_stdout, helper_stderr, fixture.backend_calls, fixture.frontend_replies);
finish:
  if (helper_pid > 0) stop_helper();
  if (foreign_release_fd >= 0) {
    (void)write(foreign_release_fd, "x", 1);
    close(foreign_release_fd);
  }
  if (foreign_pid > 0) (void)waitpid(foreign_pid, NULL, 0);
  sd_bus_slot_unref(backend_slot);
  sd_bus_unref(app);
  sd_bus_unref(fixture.backend);
  sd_bus_unref(fixture.frontend);
  return result;
}
