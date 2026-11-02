// AGPL-3.0. Adapted from OrcaSlicer PR #16587 (yw4z and OrcaSlicer contributors).
// https://github.com/OrcaSlicer/OrcaSlicer/pull/16587
#include "sampler.h"
#include <windows.h>
#include <algorithm>
#include <cmath>
#include <memory>
#include <utility>

namespace screen_color {
namespace {
bool running = false;
// Left-click, Enter or Space picks.Escape, right-click or switching apps, cancels picking
// Shift key slow downs mouse movement for preciese picking
// Electron owns process DPI awareness; all coordinates below are physical pixels.
class Overlay
{
public:
    static void start(Callback done);
    static void cancel() { if (s_overlay) s_overlay->finish(Status::Cancelled); }

private:
    static constexpr wchar_t WINDOW_CLASS[]    = L"OrcaSlicerNeoColorSampler";
    static constexpr int     LOUPE_SIZE        = 64;         // Side of the square loupe at 96 DPI
    static constexpr int     LOUPE_CELLS       = 9;          // Screen pixels per side; odd, so one sits in the middle
    static constexpr double  SLOW_SPEED        = 0.2;        // Cursor speed while Shift is held
    static constexpr UINT    WM_SAMPLER_MOVE   = WM_APP + 1; // Posted by the hook, which must return quickly
    static constexpr UINT    WM_SAMPLER_FINISH = WM_APP + 2; // wParam: picked

    // 32-bit top-down DIB selected into a memory DC, with direct access to its 0x00RRGGBB pixels
    struct Bitmap
    {
        HDC            dc     = nullptr;
        HBITMAP        bitmap = nullptr;
        HGDIOBJ        old    = nullptr;
        std::uint32_t* bits   = nullptr;
        int            width  = 0;
        int            height = 0;

        Bitmap() = default;
        Bitmap(const Bitmap&) = delete;
        Bitmap& operator=(const Bitmap&) = delete;
        ~Bitmap() { reset(); }
        bool create(int w, int h);
        void reset();
    };

    explicit Overlay(Callback done) : m_done(std::move(done)) {}

    bool          take_snapshot();
    std::uint32_t pixel(POINT p) const;
    void          follow_cursor();
    void          update_loupe();
    void          finish(Status status);

    static int monitor_dpi(HMONITOR monitor);
    static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
    static LRESULT CALLBACK mouse_hook(int code, WPARAM message, LPARAM lparam);

    Callback m_done;
    RECT     m_screen{};               // Virtual screen
    POINT    m_target{};               // Target pixel
    Bitmap   m_snapshot;
    Bitmap   m_loupe;                  // Loupe image: cells, target frame and border in one bitmap
    HWND     m_window       = nullptr; // Full-screen overlay showing snapshot
    HWND     m_loupe_window = nullptr; // Layered, click-through, owned by m_window
    bool     m_active       = false;   // Shown and focused; losing activation then cancels
    bool     m_finished     = false;

    static inline Overlay* s_overlay      = nullptr;
    static inline HHOOK    s_hook         = nullptr; // Swallows mouse buttons to prevent clicking items under sampler
    static inline bool     s_move_pending = false;
    static inline double   m_x            = 0.;      // Cursor position the hook last saw or set,
    static inline double   m_y            = 0.;      // kept fractional for slow movement
};

bool Overlay::Bitmap::create(int w, int h)
{
    reset();
    BITMAPINFO info{};
    info.bmiHeader.biSize        = sizeof(info.bmiHeader);
    info.bmiHeader.biWidth       = w;
    info.bmiHeader.biHeight      = -h; // Top-down rows
    info.bmiHeader.biPlanes      = 1;
    info.bmiHeader.biBitCount    = 32;
    info.bmiHeader.biCompression = BI_RGB;
    void* data = nullptr;
    bitmap = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &data, nullptr, 0);
    dc     = bitmap ? CreateCompatibleDC(nullptr) : nullptr;
    if (!dc) {
        reset();
        return false;
    }
    old    = SelectObject(dc, bitmap);
    bits   = static_cast<std::uint32_t*>(data);
    width  = w;
    height = h;
    return true;
}

void Overlay::Bitmap::reset()
{
    if (dc) {
        SelectObject(dc, old);
        DeleteDC(dc);
    }
    if (bitmap)
        DeleteObject(bitmap);
    dc     = nullptr;
    bitmap = nullptr;
    old    = nullptr;
    bits   = nullptr;
    width  = 0;
    height = 0;
}

// Loaded at runtime so the sampler still starts where shcore.dll lacks it
int Overlay::monitor_dpi(HMONITOR monitor)
{
    using GetDpiForMonitorFn = HRESULT(WINAPI*)(HMONITOR, int, UINT*, UINT*);
    static const auto get_dpi = [] {
        HMODULE shcore = LoadLibraryW(L"shcore.dll");
        return shcore ? reinterpret_cast<GetDpiForMonitorFn>(reinterpret_cast<void*>(GetProcAddress(shcore, "GetDpiForMonitor"))) : nullptr;
    }();
    UINT dpi_x = 96, dpi_y = 96;
    if (get_dpi)
        get_dpi(monitor, 0 /* MDT_EFFECTIVE_DPI */, &dpi_x, &dpi_y);
    return std::clamp<int>(dpi_x, 96, 4 * 96);
}

bool Overlay::take_snapshot()
{
    m_screen.left   = GetSystemMetrics(SM_XVIRTUALSCREEN);
    m_screen.top    = GetSystemMetrics(SM_YVIRTUALSCREEN);
    m_screen.right  = m_screen.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
    m_screen.bottom = m_screen.top  + GetSystemMetrics(SM_CYVIRTUALSCREEN);
    const int w = m_screen.right  - m_screen.left;
    const int h = m_screen.bottom - m_screen.top;
    if (w <= 0 || h <= 0 || !m_snapshot.create(w, h))
        return false;
    HDC screen = GetDC(nullptr);
    if (!screen)
        return false;
    // CAPTUREBLT includes layered windows (menus, tooltips, many modern apps)
    const bool ok = BitBlt(m_snapshot.dc, 0, 0, w, h, screen, m_screen.left, m_screen.top, SRCCOPY | CAPTUREBLT) != FALSE;
    ReleaseDC(nullptr, screen);
    GdiFlush();
    return ok;
}

std::uint32_t Overlay::pixel(POINT p) const
{
    const int x = p.x - m_screen.left;
    const int y = p.y - m_screen.top;
    return ((x >= 0 && y >= 0 && x < m_snapshot.width && y < m_snapshot.height)
        ? m_snapshot.bits[static_cast<std::size_t>(y) * m_snapshot.width + x]
        : 0); // Black past the screen edge
}

void Overlay::follow_cursor()
{
    POINT cursor{};
    if (!GetCursorPos(&cursor) || (cursor.x == m_target.x && cursor.y == m_target.y))
        return;
    m_target = cursor;
    update_loupe();
}

// Draws every loupe pixel (magnified cells, target frame and border) into one bitmap with borders
void Overlay::update_loupe()
{
    HMONITOR    monitor = MonitorFromPoint(m_target, MONITOR_DEFAULTTONEAREST);
    MONITORINFO info{};
    info.cbSize = sizeof(info);
    GetMonitorInfoW(monitor, &info);
    const int side = LOUPE_SIZE * monitor_dpi(monitor) / 96;
    if (side != m_loupe.width && !m_loupe.create(side, side))
        return;

    // Centered on target pixel, then shifted to stay fully on its monitor
    const RECT& bounds = info.rcMonitor;
    POINT pos{
        std::clamp<LONG>(m_target.x - side / 2, bounds.left, std::max<LONG>(bounds.left, bounds.right  - side)),
        std::clamp<LONG>(m_target.y - side / 2, bounds.top , std::max<LONG>(bounds.top , bounds.bottom - side))
    };

    const auto cell  = [side](int offset) { return offset * LOUPE_CELLS / side; };                    // Cell of a loupe pixel
    const auto first = [side](int index ) { return (index * side + LOUPE_CELLS - 1) / LOUPE_CELLS; }; // First pixel of a cell
    // Target cell is the one under cursor; off center when loupe was shifted
    const int  t_col = cell(m_target.x - pos.x);
    const int  t_row = cell(m_target.y - pos.y);

    for (int y = 0; y < side; ++y) {
        const int row = cell(y);
        for (int x = 0; x < side; ++x) {
            const int col = cell(x);
            // Distance to loupe edge or to target cell's edge inside target cell
            int ring = std::min({x, y, side - 1 - x, side - 1 - y});
            if (col == t_col && row == t_row)
                ring = std::min({ring, x - first(col), first(col + 1) - 1 - x, y - first(row), first(row + 1) - 1 - y});
            m_loupe.bits[y * side + x] = ring == 0 ? 0x000000u // Black outer line
                                       : ring == 1 ? 0xFFFFFFu // White inner line
                                       : pixel(POINT{m_target.x + col - t_col, m_target.y + row - t_row});
        }
    }

    SIZE  size{side, side};
    POINT origin{0, 0};
    UpdateLayeredWindow(m_loupe_window, nullptr, &pos, &size, m_loupe.dc, &origin, 0, nullptr, ULW_OPAQUE);
}

// Windows, mouse hook and overlay state are gone before callback runs,
// so callback may start another sampler or close dialog that asked for this one
void Overlay::finish(Status status)
{
    if (m_finished)
        return;
    m_finished = true;
    const std::uint32_t value = pixel(m_target);
    Callback done = std::move(m_done);
    DestroyWindow(m_window);                   // Also destroys owned loupe window; WM_NCDESTROY frees this overlay
    SetCursor(LoadCursor(nullptr, IDC_ARROW)); // Show an arrow until window under cursor sets its own
    done({status, value & 0xFFFFFF});
}

LRESULT CALLBACK Overlay::mouse_hook(int code, WPARAM message, LPARAM lparam)
{
    if (code != HC_ACTION || !s_overlay)
        return CallNextHookEx(nullptr, code, message, lparam);
    const POINT pt = reinterpret_cast<const MSLLHOOKSTRUCT*>(lparam)->pt;
    switch (message) {
    case WM_MOUSEMOVE: {
        // Shift: swallows move and advance cursor by a fraction without system-wide changes
        const bool slow = GetAsyncKeyState(VK_SHIFT) < 0;
        if (slow) {
            const RECT& scr = s_overlay->m_screen;
            m_x = std::clamp(m_x + (pt.x - std::lround(m_x)) * SLOW_SPEED, double(scr.left), double(scr.right  - 1));
            m_y = std::clamp(m_y + (pt.y - std::lround(m_y)) * SLOW_SPEED, double(scr.top) , double(scr.bottom - 1));
            SetCursorPos(static_cast<int>(std::lround(m_x)), static_cast<int>(std::lround(m_y)));
        } else {
            m_x = pt.x;
            m_y = pt.y;
        }
        if (!s_move_pending) // Coalesced; overlay reads latest position when it handles message
            s_move_pending = PostMessageW(s_overlay->m_window, WM_SAMPLER_MOVE, 0, 0) != FALSE;
        return slow ? 1 : CallNextHookEx(nullptr, code, message, lparam);
    }
    case WM_LBUTTONUP:
    case WM_RBUTTONUP:
        PostMessageW(s_overlay->m_window, WM_SAMPLER_FINISH, message == WM_LBUTTONUP, 0);
        return 1;
    case WM_LBUTTONDOWN:
    case WM_RBUTTONDOWN:
    case WM_MBUTTONDOWN:
    case WM_MBUTTONUP:
    case WM_XBUTTONDOWN:
    case WM_XBUTTONUP:
    case WM_MOUSEWHEEL:
    case WM_MOUSEHWHEEL:
        return 1; // Swallowed: nothing under the overlay sees these
    default:
        return CallNextHookEx(nullptr, code, message, lparam);
    }
}

LRESULT CALLBACK Overlay::window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    Overlay* overlay = s_overlay;
    if (!overlay || hwnd != overlay->m_window) // Loupe window, and the overlay while it is being created
        return DefWindowProcW(hwnd, message, wparam, lparam);

    switch (message) {
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        const RECT& r = ps.rcPaint; // Client coordinates match the snapshot's
        BitBlt(dc, r.left, r.top, r.right - r.left, r.bottom - r.top, overlay->m_snapshot.dc, r.left, r.top, SRCCOPY);
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_ERASEBKGND:
        return 1;
    case WM_SETCURSOR:
        // Hidden only while it is over overlay; this is no ShowCursor counter,
        // so system shows cursor again as soon as overlay is gone, even if app crashes
        SetCursor(nullptr);
        return TRUE;
    case WM_SAMPLER_MOVE:
        s_move_pending = false;
        overlay->follow_cursor();
        return 0;
    case WM_SAMPLER_FINISH:
        overlay->follow_cursor();
        overlay->finish(wparam != 0 ? Status::Picked : Status::Cancelled);
        return 0;
    case WM_KEYDOWN:
        if (wparam == VK_ESCAPE)
            overlay->finish(Status::Cancelled);
        else if (wparam == VK_RETURN || wparam == VK_SPACE)
            overlay->finish(Status::Picked);
        return 0;
    case WM_ACTIVATE:
        // Switching away (Alt+Tab, Win key) cancels instead of leaving a frozen screen behind
        if (LOWORD(wparam) == WA_INACTIVE && overlay->m_active)
            overlay->finish(Status::Cancelled);
        return 0;
    case WM_CANCELMODE:
    case WM_CLOSE:
        overlay->finish(Status::Cancelled);
        return 0;
    case WM_DPICHANGED:
        return 0; // Keep covering whole virtual screen; never resize to suggested rect
    case WM_NCDESTROY: {
        if (s_hook)
            UnhookWindowsHookEx(s_hook);
        s_hook         = nullptr;
        s_overlay      = nullptr;
        s_move_pending = false;
        running      = false;
        // Destroyed without finish() (e.g. at app exit): still report a cancel
        Callback done = overlay->m_finished ? nullptr : std::move(overlay->m_done);
        delete overlay;
        if (done)
            done({Status::Cancelled});
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    default:
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
}

void Overlay::start(Callback done)
{
    HINSTANCE instance = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&Overlay::window_proc), &instance)) { done({Status::Failed}); return; }
    WNDCLASSEXW wc{};
    wc.cbSize        = sizeof(wc);
    wc.lpfnWndProc   = window_proc;
    wc.hInstance     = instance;
    wc.lpszClassName = WINDOW_CLASS; // No class cursor: hidden over overlay
    const bool registered = RegisterClassExW(&wc) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;

    std::unique_ptr<Overlay> overlay(new Overlay(std::move(done)));
    if (registered && overlay->take_snapshot()) {
        const RECT& s = overlay->m_screen;
        // Topmost tool window over every monitor; no taskbar button and no Alt+Tab entry
        overlay->m_window = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, WINDOW_CLASS, L"", WS_POPUP,
                                            s.left, s.top, s.right - s.left, s.bottom - s.top, nullptr, nullptr, instance, nullptr);
    }
    if (!overlay->m_window) {
        Callback callback = std::move(overlay->m_done);
        overlay.reset();
        callback({Status::Failed});
        return;
    }

    // From here overlay window owns overlay: finish() reports result and frees everything
    Overlay* o = overlay.release();
    s_overlay  = o;
    running  = true;
    o->m_loupe_window = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                                        WINDOW_CLASS, L"", WS_POPUP, 0, 0, 0, 0, o->m_window, nullptr, instance, nullptr);
    // Runs on this GUI thread, which pumps messages. Without it clicks could reach other windows
    s_hook = SetWindowsHookExW(WH_MOUSE_LL, mouse_hook, instance, 0);
    if (!o->m_loupe_window || !s_hook || !GetCursorPos(&o->m_target)) {
        o->finish(Status::Failed);
        return;
    }
    m_x = o->m_target.x;
    m_y = o->m_target.y;
    o->update_loupe();

    ShowWindow(o->m_window, SW_SHOW);
    ShowWindow(o->m_loupe_window, SW_SHOWNOACTIVATE);
    SetForegroundWindow(o->m_window);
    SetFocus(o->m_window);
    SetCursor(nullptr); // Hide it now rather than on first move
    UpdateWindow(o->m_window);
    if (s_overlay != o) // Showing can already end sampling (e.g. WM_CANCELMODE), which frees overlay
        return;
    o->m_active = GetForegroundWindow() == o->m_window;
    if (!o->m_active) // Without focus Escape would never reach overlay; give up rather than trap user
        o->finish(Status::Failed);
}


}
bool Available() { return true; }
void Start(Callback done) {
    if (running) { done({Status::Failed}); return; }
    Overlay::start(std::move(done));
}
void Cancel() { Overlay::cancel(); }
}
