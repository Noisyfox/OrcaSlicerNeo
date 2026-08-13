// ----------------------------------------------------------------
// ------------ Serial boost::thread shim for the WASM build -------
// ----------------------------------------------------------------
// libslic3r references boost::thread in code that is dead in the v1 WASM
// slice path (GUI host control, cloud task API, thread-naming helpers) but
// must still COMPILE: Print.cpp (boost::mutex/unique_lock), GCodeSender,
// ProjectTask, Thread.{hpp,cpp}, PrintConfig.cpp, MultiMaterialSegmentation,
// TriangleMeshSlicer. Boost.Thread has no Emscripten backend ("Boost threads
// unavailable on this platform"), so — like the TBB shim — we provide serial
// header-only stand-ins. v1 runs single-threaded; nothing here actually
// spawns a thread: thread() stores the callable and runs it once on
// join()/detach().
//
// This is intentionally a *subset* (thread, attributes, id, this_thread,
// mutex, unique_lock, lock_guard). When a compile surfaces a missing
// boost::thread symbol, add it here — expected iterative work.
#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <functional>
#include <thread>
#include <type_traits>
#include <utility>

// Real (header-only) boost::posix_time for system_time/get_system_time and the
// ptime arithmetic bbs_3mf.cpp's backup manager does (seconds() offsets,
// comparisons). Resolves from the Emscripten-built Boost archive on the
// include path — this file only lives in the shim include dir.
#include <boost/date_time/posix_time/posix_time.hpp>

// boost::ref / boost::is_reference_wrapper — bbs_3mf.cpp starts its backup
// manager thread as boost::thread(boost::ref(*this)); the shim must unwrap
// the reference_wrapper before stuffing the callable into std::function.
#include <boost/ref.hpp>

namespace boost {

// ---------------- mutex (serial: real std::mutex, but only one thread) ----
class mutex {
public:
  mutex() = default;
  mutex(const mutex&) = delete;
  mutex& operator=(const mutex&) = delete;

  void lock() { m_.lock(); }
  bool try_lock() { return m_.try_lock(); }
  void unlock() { m_.unlock(); }
  std::mutex& native_handle() { return m_; }
  using scoped_lock = std::lock_guard<std::mutex>;

private:
  std::mutex m_;
};

// ---------------- lock_guard / unique_lock (std-compatible) ----------------
template <class Mutex>
class lock_guard {
public:
  explicit lock_guard(Mutex& m) : m_(m) { m_.lock(); }
  lock_guard(const lock_guard&) = delete;
  lock_guard& operator=(const lock_guard&) = delete;
  ~lock_guard() { m_.unlock(); }

private:
  Mutex& m_;
};

template <class Mutex>
class unique_lock {
public:
  unique_lock() = default;
  explicit unique_lock(Mutex& m) : m_(&m) { m_->lock(); }
  unique_lock(const unique_lock&) = delete;
  unique_lock& operator=(const unique_lock&) = delete;
  ~unique_lock() { if (m_ != nullptr && owns_) { m_->unlock(); } }

  void lock() { if (m_ != nullptr) { m_->lock(); owns_ = true; } }
  void unlock() { if (m_ != nullptr) { m_->unlock(); owns_ = false; } }
  bool owns_lock() const { return owns_; }
  Mutex* mutex() const { return m_; }

private:
  Mutex* m_ = nullptr;
  bool owns_ = false;
};

// ---------------- condition_variable / system_time (bbs_3mf.cpp) -----------
// _BBS_Backup_Manager (Format/bbs_3mf.cpp) uses boost::condition_variable with
// timed_wait on a boost::system_time deadline plus posix_time arithmetic. The
// real Boost.Thread is unavailable on Emscripten, so — like the rest of this
// shim — provide serial stand-ins over std::condition_variable. Nothing
// actually blocks: the whole module runs single-threaded.
using system_time = boost::posix_time::ptime;

inline system_time get_system_time() { return boost::posix_time::microsec_clock::universal_time(); }

class condition_variable {
public:
  condition_variable() = default;
  condition_variable(const condition_variable&) = delete;
  condition_variable& operator=(const condition_variable&) = delete;

  template <class Mutex> void wait(unique_lock<Mutex>& lk)
  {
    std::unique_lock<std::mutex> ul(lk.mutex()->native_handle());
    cv_.wait(ul);
  }

  template <class Mutex> bool timed_wait(unique_lock<Mutex>& lk, const system_time& abs_time)
  {
    std::unique_lock<std::mutex> ul(lk.mutex()->native_handle());
    return cv_.wait_until(ul, std::chrono::system_clock::from_time_t(boost::posix_time::to_time_t(abs_time))) ==
           std::cv_status::no_timeout;
  }

  void notify_one() noexcept { cv_.notify_one(); }
  void notify_all() noexcept { cv_.notify_all(); }

private:
  std::condition_variable cv_;
};

// ---------------- thread (serial: runs the callable once, on join/detach) --
class thread {
public:
  using id = std::thread::id;

  class attributes {
  public:
    attributes() = default;
    void set_stack_size(std::size_t size) { stack_size_ = size; }
    std::size_t get_stack_size() const { return stack_size_; }

  private:
    std::size_t stack_size_ = 0;
  };

  thread() = default;
  template <class Fn> explicit thread(Fn fn) : fn_(make_invoker(std::move(fn))) {}
  template <class Fn> thread(attributes&, Fn fn) : fn_(make_invoker(std::move(fn))) {}
  thread(const thread&) = delete;
  thread& operator=(const thread&) = delete;
  thread(thread&&) = default;
  thread& operator=(thread&&) = default;
  ~thread() { /* serial shim: never joins implicitly */ }

  id get_id() const { return id_; }
  // Thread.cpp::set_thread_name (dead in the WASM slice — GUI thread naming)
  // calls native_handle() and passes it to pthread_setname_np; a null handle
  // is fine for the serial shim.
  using native_handle_type = std::thread::native_handle_type;
  native_handle_type native_handle() const { return native_handle_type{}; }
  bool joinable() const { return !joined_ && static_cast<bool>(fn_); }
  void join() { run_once(); }
  void detach() { run_once(); }
  void swap(thread& other) {
    std::swap(fn_, other.fn_);
    std::swap(joined_, other.joined_);
    std::swap(ran_, other.ran_);
  }
  static unsigned int hardware_concurrency() { return 1; }

private:
  // Unwrap boost::reference_wrapper (used by bbs_3mf.cpp as
  // boost::thread(boost::ref(*this))): boost's wrapper has get()/conversion
  // but no operator(), so std::function can't hold it directly. Call through
  // get(); everything else goes into std::function as-is.
  template <class Fn>
  static std::function<void()> make_invoker(Fn&& fn)
  {
    using T = typename std::decay<Fn>::type;
    if constexpr (boost::is_reference_wrapper<T>::value) {
      return [fn]() mutable { fn.get()(); };
    } else {
      return std::function<void()>(std::forward<Fn>(fn));
    }
  }

  void run_once() {
    if (fn_ && !ran_) {
      ran_ = true;
      fn_();
    }
    joined_ = true;
  }

  std::function<void()> fn_;
  bool joined_ = false;
  bool ran_ = false;
  id id_;
};

namespace this_thread {
inline thread::id get_id() { return std::this_thread::get_id(); }
}  // namespace this_thread

}  // namespace boost
