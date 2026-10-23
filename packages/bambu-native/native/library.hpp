// One platform loader; every platform uses the same Orca function declarations.
#pragma once
#include <memory>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#include <Windows.h>
#else
#include <dlfcn.h>
#endif

class Library {
public:
    explicit Library(const std::string& path) {
#ifdef _WIN32
        const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), static_cast<int>(path.size()), nullptr, 0);
        if (!count) throw std::runtime_error("Invalid plugin path");
        std::wstring wide(count, L'\0');
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), static_cast<int>(path.size()), wide.data(), count);
        handle_ = LoadLibraryExW(wide.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
#else
        handle_ = dlopen(path.c_str(), RTLD_LAZY | RTLD_LOCAL);
#endif
        if (!handle_) throw std::runtime_error("Unable to load bundled Bambu plugin");
    }
    ~Library() {
#ifdef _WIN32
        if (handle_) FreeLibrary(handle_);
#else
        if (handle_) dlclose(handle_);
#endif
    }
    Library(const Library&) = delete;
    Library& operator=(const Library&) = delete;
    template<typename T> T symbol(const char* name) const {
#ifdef _WIN32
        auto result = GetProcAddress(handle_, name);
#else
        auto result = dlsym(handle_, name);
#endif
        if (!result) throw std::runtime_error(std::string("Missing plugin export: ") + name);
        return reinterpret_cast<T>(result);
    }
private:
#ifdef _WIN32
    HMODULE handle_ = nullptr;
#else
    void* handle_ = nullptr;
#endif
};
