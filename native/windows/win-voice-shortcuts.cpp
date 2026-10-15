#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <iostream>
#include <thread>

int main() {
    const UINT modifiers = MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT;
    const bool microphone = RegisterHotKey(nullptr, 1, modifiers, 'M') != 0;
    const DWORD microphoneError = microphone ? 0 : GetLastError();
    if (microphone) std::cout << "REGISTERED Ctrl+Shift+M" << std::endl;
    else std::cerr << "Ctrl+Shift+M registration failed: " << microphoneError << std::endl;
    const bool deafen = RegisterHotKey(nullptr, 2, modifiers, 'D') != 0;
    const DWORD deafenError = deafen ? 0 : GetLastError();
    if (deafen) std::cout << "REGISTERED Ctrl+Shift+D" << std::endl;
    else std::cerr << "Ctrl+Shift+D registration failed: " << deafenError << std::endl;
    if (!microphone && !deafen) return 2;

    MSG message{};
    // create the message queue before the pipe monitor can post WM_QUIT.
    PeekMessage(&message, nullptr, 0, 0, PM_NOREMOVE);
    const DWORD thread = GetCurrentThreadId();
    // closing the parent pipe also releases the bindings after a client crash.
    std::thread([thread]() {
        char ignored;
        while (std::cin.get(ignored)) {}
        PostThreadMessage(thread, WM_QUIT, 0, 0);
    }).detach();
    std::cout << "READY" << std::endl;

    int status;
    while ((status = static_cast<int>(GetMessage(&message, nullptr, 0, 0))) > 0) {
        if (message.message != WM_HOTKEY) continue;
        if (message.wParam == 1 && microphone) std::cout << "KeyM" << std::endl;
        if (message.wParam == 2 && deafen) std::cout << "KeyD" << std::endl;
    }
    if (microphone) UnregisterHotKey(nullptr, 1);
    if (deafen) UnregisterHotKey(nullptr, 2);
    if (status == -1) std::cerr << "Hotkey message loop failed: " << GetLastError() << std::endl;
    return status == -1 ? 1 : 0;
}
