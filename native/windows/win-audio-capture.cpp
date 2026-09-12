// Captures everything the default playback device is playing EXCEPT another process tree.
//
// Chromium can do the same thing (its `loopbackWithoutChrome` device activates WASAPI process
// loopback in exclude mode) but gates it behind a Windows 11 check, so this helper calls the API
// directly and reports honestly whether the OS accepted it. PCM goes to stdout as interleaved
// float32, which is exactly what the renderer's AudioData path expects.
//
// Usage: win-audio-capture.exe --exclude-pid <pid> [--rate 48000] [--channels 2]
// Exit codes: 0 = ran and exited cleanly, 2 = activation/initialisation failed (stdout stays empty).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;

constexpr wchar_t kDeviceId[] = VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK;

long Argument(int argc, char** argv, const char* name, long fallback) {
  long value = fallback;
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::strcmp(argv[i], name) == 0) value = std::strtol(argv[i + 1], nullptr, 10);
  }
  return value;
}

// Agility matters: the activation completes on an arbitrary thread, so the handler declares FtmBase
// (after RuntimeClass, which is the order WRL requires) instead of being a plain COM object.
class ActivationHandler final
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                          IActivateAudioInterfaceCompletionHandler>,
      public FtmBase {
 public:
  explicit ActivationHandler(HANDLE done) : done_(done) {}

  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activate_result = E_FAIL;
    ComPtr<IUnknown> activated;
    if (operation != nullptr) {
      operation->GetActivateResult(&activate_result, &activated);
    }
    if (SUCCEEDED(activate_result) && activated != nullptr) {
      activated.As(&client_);
    } else {
      failure_ = activate_result;
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

}  // namespace

int main(int argc, char** argv) {
  const long exclude_pid = Argument(argc, argv, "--exclude-pid", -1);
  const long sample_rate = Argument(argc, argv, "--rate", 48000);
  const long channels = Argument(argc, argv, "--channels", 2);

  if (exclude_pid <= 0) {
    std::fprintf(stderr, "usage: --exclude-pid <pid> [--rate 48000] [--channels 2]\n");
    return 2;
  }

  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 2;

  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = static_cast<DWORD>(exclude_pid);
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

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

  if (WaitForSingleObject(done, 5000) != WAIT_OBJECT_0) {
    std::fprintf(stderr, "activation timed out\n");
    return 2;
  }
  CloseHandle(done);

  if (FAILED(handler->failure()) || handler->client() == nullptr) {
    // The OS refused exclude mode: on this Windows build the capture does not exist.
    std::fprintf(stderr, "exclude-mode activation failed: 0x%08lX\n", static_cast<unsigned long>(handler->failure()));
    return 2;
  }

  ComPtr<IAudioClient> client = handler->client();

  // Process loopback is a virtual device: it has no mix format, the client picks one.
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = static_cast<WORD>(channels);
  format.nSamplesPerSec = static_cast<DWORD>(sample_rate);
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

  HANDLE samples = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (samples == nullptr) return 2;
  if (FAILED(client->SetEventHandle(samples))) return 2;

  ComPtr<IAudioCaptureClient> capture;
  if (FAILED(client->GetService(IID_PPV_ARGS(&capture)))) return 2;
  if (FAILED(client->Start())) return 2;

  std::fprintf(stderr, "capturing, excluding pid %ld\n",
               exclude_pid);  // stderr is the log, stdout is the audio
  std::vector<uint8_t> silence(static_cast<size_t>(format.nBlockAlign) * 480);

  for (;;) {
    if (WaitForSingleObject(samples, 1000) == WAIT_TIMEOUT) {
      if (GetStdHandle(STD_OUTPUT_HANDLE) == INVALID_HANDLE_VALUE) break;
      continue;
    }

    UINT32 packet = 0;
    if (FAILED(capture->GetNextPacketSize(&packet))) break;

    while (packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) {
        packet = 0;
        break;
      }

      const size_t bytes = static_cast<size_t>(frames) * format.nBlockAlign;
      bool ok = true;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        for (size_t offset = 0; offset < bytes && ok;) {
          const size_t chunk = (bytes - offset) < silence.size() ? (bytes - offset) : silence.size();
          ok = WriteAll(silence.data(), chunk);
          offset += chunk;
        }
      } else {
        ok = WriteAll(data, bytes);
      }

      capture->ReleaseBuffer(frames);
      if (!ok) {
        client->Stop();
        return 0;  // parent closed the pipe
      }
      if (FAILED(capture->GetNextPacketSize(&packet))) break;
    }
  }

  client->Stop();
  return 0;
}
