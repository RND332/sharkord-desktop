// Usage: win-audio-capture.exe --exclude-pid <pid> [--include-window <hwnd>] [--rate 48000] [--channels 2]
// stdout is interleaved float32 PCM; stderr carries one `READY <resolved-pid>` line once the
// capture is running. Exit codes: 0 = ran and exited cleanly, 2 = refused or failed,
// 3 = the OS refused process loopback for this target, 4 = the chosen window's app went away.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <utility>
#include <vector>

namespace {

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;

constexpr wchar_t kDeviceId[] = VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK;

constexpr unsigned long kMaxProcessId = 0xFFFFFFFFUL;
constexpr unsigned long kMinWindowHandle = 1;
constexpr unsigned long kMaxWindowHandle = 0xFFFFFFFFUL;
constexpr long kMinSampleRate = 8000;
constexpr long kMaxSampleRate = 192000;
constexpr long kMinChannels = 1;
constexpr long kMaxChannels = 8;
constexpr DWORD kActivationTimeoutMs = 5000;
constexpr int kMaxProcessTreeDepth = 1024;

struct Options {
  unsigned long exclude_pid = 0;
  unsigned long window_handle = 0;
  long sample_rate = 0;
  long channels = 0;
};

bool HasDigits(const char* text) {
  return text != nullptr && text[0] >= '0' && text[0] <= '9';
}

bool ParseUnsigned(const char* text, unsigned long min, unsigned long max, unsigned long* out) {
  if (!HasDigits(text)) return false;
  errno = 0;
  char* end = nullptr;
  const unsigned long value = std::strtoul(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < min || value > max) return false;
  *out = value;
  return true;
}

bool ParseLong(const char* text, long min, long max, long* out) {
  if (!HasDigits(text)) return false;
  errno = 0;
  char* end = nullptr;
  const long value = std::strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < min || value > max) return false;
  *out = value;
  return true;
}

bool ParseOptions(int argc, char** argv, Options* out) {
  for (int i = 1; i < argc; i += 2) {
    if (i + 1 >= argc) return false;
    const char* name = argv[i];
    const char* value = argv[i + 1];
    if (std::strcmp(name, "--exclude-pid") == 0) {
      if (out->exclude_pid != 0 || !ParseUnsigned(value, 1, kMaxProcessId, &out->exclude_pid)) return false;
    } else if (std::strcmp(name, "--include-window") == 0) {
      if (out->window_handle != 0 ||
          !ParseUnsigned(value, kMinWindowHandle, kMaxWindowHandle, &out->window_handle)) {
        return false;
      }
    } else if (std::strcmp(name, "--rate") == 0) {
      if (out->sample_rate != 0 || !ParseLong(value, kMinSampleRate, kMaxSampleRate, &out->sample_rate)) {
        return false;
      }
    } else if (std::strcmp(name, "--channels") == 0) {
      if (out->channels != 0 || !ParseLong(value, kMinChannels, kMaxChannels, &out->channels)) return false;
    } else {
      return false;
    }
  }
  if (out->exclude_pid == 0) return false;
  if (out->sample_rate == 0) out->sample_rate = 48000;
  if (out->channels == 0) out->channels = 2;
  return true;
}

bool ProcessParents(std::vector<std::pair<DWORD, DWORD>>* parents) {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  bool complete = false;
  if (Process32FirstW(snapshot, &entry)) {
    complete = true;
    do {
      parents->emplace_back(entry.th32ProcessID, entry.th32ParentProcessID);
    } while (Process32NextW(snapshot, &entry));
    if (GetLastError() != ERROR_NO_MORE_FILES) complete = false;
  }
  CloseHandle(snapshot);
  return complete;
}

bool ParentOf(const std::vector<std::pair<DWORD, DWORD>>& parents, DWORD pid, DWORD* parent) {
  for (const auto& row : parents) {
    if (row.first == pid) {
      *parent = row.second;
      return true;
    }
  }
  return false;
}

bool Contains(const std::vector<DWORD>& path, DWORD pid) {
  for (const DWORD seen : path) {
    if (seen == pid) return true;
  }
  return false;
}

std::vector<DWORD> Lineage(const std::vector<std::pair<DWORD, DWORD>>& parents, DWORD pid) {
  std::vector<DWORD> path;
  path.push_back(pid);
  for (int depth = 0; depth < kMaxProcessTreeDepth && pid != 0; ++depth) {
    DWORD parent = 0;
    if (!ParentOf(parents, pid, &parent)) break;
    if (Contains(path, parent)) break;
    path.push_back(parent);
    pid = parent;
  }
  return path;
}

bool ShareLineage(const std::vector<DWORD>& left, const std::vector<DWORD>& right) {
  for (const DWORD pid : left) {
    if (Contains(right, pid)) return true;
  }
  return false;
}

DWORD WindowOwner(HWND window) {
  if (window == nullptr || !IsWindow(window)) return 0;
  DWORD owner = 0;
  GetWindowThreadProcessId(window, &owner);
  return owner;
}

bool ProcessAlive(HANDLE process) {
  DWORD code = 0;
  return process != nullptr && GetExitCodeProcess(process, &code) && code == STILL_ACTIVE;
}

const char* WindowTargetProblem(HWND window, DWORD expected_pid, HANDLE process) {
  if (!ProcessAlive(process)) return "its process is gone";
  if (WindowOwner(window) != expected_pid) return "the window changed hands";
  return nullptr;
}

struct Handles {
  HANDLE samples = nullptr;
  HANDLE window_process = nullptr;
  HANDLE caller_process = nullptr;

  ~Handles() {
    if (samples != nullptr) CloseHandle(samples);
    if (window_process != nullptr) CloseHandle(window_process);
    if (caller_process != nullptr) CloseHandle(caller_process);
  }
};

// The handler completes on an arbitrary thread, so it declares FtmBase as part of the runtime class
// (this is how Chromium declares the same handler); without it COM cannot marshal it.
class ActivationHandler final
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                          Microsoft::WRL::FtmBase,
                                          IActivateAudioInterfaceCompletionHandler> {
 public:
  explicit ActivationHandler(HANDLE done) : done_(done) {}

  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activate_result = E_FAIL;
    ComPtr<IUnknown> activated;
    if (operation != nullptr) {
      const HRESULT call = operation->GetActivateResult(&activate_result, &activated);
      if (FAILED(call)) activate_result = call;
    }
    if (SUCCEEDED(activate_result) && activated != nullptr) {
      const HRESULT as = activated.As(&client_);
      if (FAILED(as)) activate_result = as;
    }
    if (FAILED(activate_result)) {
      failure_ = activate_result;
    } else if (client_ == nullptr) {
      failure_ = E_NOINTERFACE;
    }
    SetEvent(done_);
    return S_OK;
  }

  ComPtr<IAudioClient> client() const { return client_; }
  HRESULT failure() const { return failure_; }

 private:
  HANDLE done_;
  ComPtr<IAudioClient> client_;
  HRESULT failure_ = S_OK;
};

bool WriteAll(const void* data, size_t size) {
  const HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  const auto* bytes = static_cast<const uint8_t*>(data);
  size_t written = 0;
  while (written < size) {
    DWORD chunk = 0;
    if (!WriteFile(out, bytes + written, static_cast<DWORD>(size - written), &chunk, nullptr) || chunk == 0) {
      return false;  // parent went away
    }
    written += chunk;
  }
  return true;
}

int StopAndExit(IAudioClient* client, int code) {
  if (client != nullptr) client->Stop();
  return code;
}

}  // namespace

int main(int argc, char** argv) {
  Options options;
  if (!ParseOptions(argc, argv, &options)) {
    std::fprintf(stderr, "usage: --exclude-pid <pid> [--include-window <hwnd>] [--rate 48000] [--channels 2]\n");
    return 2;
  }

  Handles handles;
  const HWND window = reinterpret_cast<HWND>(static_cast<ULONG_PTR>(options.window_handle));
  DWORD target_pid = static_cast<DWORD>(options.exclude_pid);
  PROCESS_LOOPBACK_MODE loopback_mode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  std::vector<std::pair<DWORD, DWORD>> parents;
  if (!ProcessParents(&parents)) {
    std::fprintf(stderr, "cannot read the process list\n");
    return 2;
  }

  DWORD caller_pid = 0;
  if (!ParentOf(parents, GetCurrentProcessId(), &caller_pid) || caller_pid == 0) {
    std::fprintf(stderr, "cannot find the process that started this helper\n");
    return 2;
  }
  handles.caller_process = OpenProcess(SYNCHRONIZE, FALSE, caller_pid);
  if (handles.caller_process == nullptr) {
    std::fprintf(stderr, "cannot watch the process that started this helper\n");
    return 2;
  }

  if (options.window_handle != 0) {
    const DWORD owner = WindowOwner(window);
    if (owner == 0) {
      std::fprintf(stderr, "refusing the window source: the window is gone\n");
      return 2;
    }

    handles.window_process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, owner);
    if (!ProcessAlive(handles.window_process)) {
      std::fprintf(stderr, "refusing the window source: its process cannot be watched\n");
      return 2;
    }

    const DWORD self = GetCurrentProcessId();
    const std::vector<DWORD> our_lineage = Lineage(parents, self);
    const std::vector<DWORD> window_lineage = Lineage(parents, owner);
    if (Contains(window_lineage, options.exclude_pid) || Contains(our_lineage, owner)) {
      std::fprintf(stderr, "refusing the window source: it belongs to this app\n");
      return 2;
    }
    if (!ShareLineage(our_lineage, window_lineage)) {
      std::fprintf(stderr, "refusing the window source: its process tree could not be read\n");
      return 2;
    }

    target_pid = owner;
    loopback_mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  }

  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 2;

  if (options.window_handle != 0) {
    const char* problem = WindowTargetProblem(window, target_pid, handles.window_process);
    if (problem != nullptr) {
      std::fprintf(stderr, "refusing the window source: %s\n", problem);
      return 2;
    }
  }

  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = target_pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = loopback_mode;

  PROPVARIANT prop{};
  prop.vt = VT_BLOB;
  prop.blob.cbSize = sizeof(params);
  prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (done == nullptr) return 2;

  ComPtr<ActivationHandler> handler = Make<ActivationHandler>(done);
  ComPtr<IActivateAudioInterfaceAsyncOperation> activation;
  HRESULT hr = ActivateAudioInterfaceAsync(kDeviceId, __uuidof(IAudioClient), &prop, handler.Get(), &activation);
  if (FAILED(hr)) {
    std::fprintf(stderr, "activation call failed: 0x%08lX\n", static_cast<unsigned long>(hr));
    return 2;
  }

  if (WaitForSingleObject(done, kActivationTimeoutMs) != WAIT_OBJECT_0) {
    std::fprintf(stderr, "activation timed out\n");
    CloseHandle(done);
    return 2;
  }
  CloseHandle(done);

  if (FAILED(handler->failure()) || handler->client() == nullptr) {
    const HRESULT failure = FAILED(handler->failure()) ? handler->failure() : E_NOINTERFACE;
    std::fprintf(stderr, "process loopback activation failed: 0x%08lX\n", static_cast<unsigned long>(failure));
    const bool unsupported = failure == E_INVALIDARG || failure == E_NOTIMPL ||
                             failure == HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED);
    return unsupported ? 3 : 2;
  }

  ComPtr<IAudioClient> client = handler->client();

  // Process loopback is a virtual device: it has no mix format, the client picks one.
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = static_cast<WORD>(options.channels);
  format.nSamplesPerSec = static_cast<DWORD>(options.sample_rate);
  format.wBitsPerSample = 32;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;

  // Process loopback has no mix format of its own: the client picks the format and the engine
  // converts, which is what AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM is for.
  const REFERENCE_TIME buffer_duration = 0;  // let the engine choose, as Microsoft's sample does
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                              AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                          buffer_duration, 0, &format, nullptr);
  if (FAILED(hr)) {
    std::fprintf(stderr, "initialize failed: 0x%08lX\n", static_cast<unsigned long>(hr));
    return 2;
  }

  handles.samples = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (handles.samples == nullptr) return 2;
  if (FAILED(client->SetEventHandle(handles.samples))) {
    std::fprintf(stderr, "cannot attach the sample event\n");
    return 2;
  }

  ComPtr<IAudioCaptureClient> capture;
  if (FAILED(client->GetService(IID_PPV_ARGS(&capture)))) {
    std::fprintf(stderr, "cannot open the capture client\n");
    return 2;
  }

  if (FAILED(client->Start())) {
    std::fprintf(stderr, "cannot start the capture\n");
    return 2;
  }

  if (options.window_handle != 0) {
    const char* problem = WindowTargetProblem(window, target_pid, handles.window_process);
    if (problem != nullptr) {
      std::fprintf(stderr, "the shared window cannot be captured: %s\n", problem);
      return StopAndExit(client.Get(), 4);
    }
  }

  std::fprintf(stderr, "READY %lu\n", static_cast<unsigned long>(target_pid));
  std::fflush(stderr);

  std::vector<uint8_t> silence(static_cast<size_t>(format.nBlockAlign) * 480);

  for (;;) {
    HANDLE waits[3] = {nullptr, nullptr, nullptr};
    DWORD count = 0;
    if (handles.caller_process != nullptr) waits[count++] = handles.caller_process;
    const DWORD window_slot = handles.window_process != nullptr ? count++ : 0;
    if (handles.window_process != nullptr) waits[window_slot] = handles.window_process;
    const DWORD samples_slot = count++;
    waits[samples_slot] = handles.samples;

    const DWORD wait = WaitForMultipleObjects(count, waits, FALSE, 1000);
    if (wait == WAIT_FAILED) {
      std::fprintf(stderr, "wait failed: 0x%08lX\n", static_cast<unsigned long>(GetLastError()));
      return StopAndExit(client.Get(), 2);
    }
    if (handles.caller_process != nullptr && wait == WAIT_OBJECT_0) {
      return StopAndExit(client.Get(), 0);
    }
    if (handles.window_process != nullptr && wait == WAIT_OBJECT_0 + window_slot) {
      std::fprintf(stderr, "the shared window's process ended\n");
      return StopAndExit(client.Get(), 4);
    }

    if (options.window_handle != 0 && WindowOwner(window) != target_pid) {
      std::fprintf(stderr, "the shared window is gone\n");
      return StopAndExit(client.Get(), 4);
    }
    if (wait != WAIT_OBJECT_0 + samples_slot) continue;

    UINT32 packet = 0;
    if (FAILED(capture->GetNextPacketSize(&packet))) {
      std::fprintf(stderr, "cannot read the capture\n");
      return StopAndExit(client.Get(), 2);
    }

    while (packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) {
        std::fprintf(stderr, "cannot read the capture buffer\n");
        return StopAndExit(client.Get(), 2);
      }

      const size_t bytes = static_cast<size_t>(frames) * format.nBlockAlign;
      bool ok = true;
      if (bytes > 0) {
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          for (size_t offset = 0; offset < bytes && ok;) {
            const size_t chunk = (bytes - offset) < silence.size() ? (bytes - offset) : silence.size();
            ok = WriteAll(silence.data(), chunk);
            offset += chunk;
          }
        } else {
          ok = WriteAll(data, bytes);
        }
      }

      capture->ReleaseBuffer(frames);
      if (!ok) {
        return StopAndExit(client.Get(), 0);  // parent closed the pipe
      }
      if (FAILED(capture->GetNextPacketSize(&packet))) {
        std::fprintf(stderr, "cannot read the capture\n");
        return StopAndExit(client.Get(), 2);
      }
    }
  }
}
