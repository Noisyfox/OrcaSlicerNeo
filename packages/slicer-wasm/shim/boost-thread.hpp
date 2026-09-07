// ----------------------------------------------------------------
// ------------ boost::thread compatibility shim for WASM --------
// ----------------------------------------------------------------
// libslic3r references Boost.Thread APIs from code that is either retained for
// compilation or outside the synchronous v1 bridge path. The Boost.Thread
// headers are therefore replaced with this small source-compatible surface.
//
// The threaded artifact maps boost::thread to std::thread and Emscripten
// pthreads. The serial artifact keeps the deferred serial behaviour used by
// the fallback build. The real parallel slice work remains oneTBB-owned.
//
// This is intentionally a subset (thread, attributes, id, this_thread, mutex,
// unique_lock, lock_guard, condition_variable). When a compile surfaces a
// missing boost::thread symbol, add it here — expected iterative work.
#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <functional>
#include <thread>
#include <type_traits>
#include <utility>

// Real (header-only) boost::posix_time for system_time/get_system_time and the
// ptime arithmetic used by upstream callers. This file only lives in the shim
// include directory, so the date_time header resolves from the staged Boost
// include tree.
#include <boost/date_time/posix_time/posix_time.hpp>

// boost::ref / boost::is_reference_wrapper are used by upstream thread call
// sites. The wrapper has get() but no call operator, so thread construction
// unwraps it before handing the callable to std::thread/std::function.
#include <boost/ref.hpp>

namespace boost {

// ---------------- mutex / lock types ---------------------------------------
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

template <class Mutex>
class lock_guard {
public:
  explicit lock_guard(Mutex& mutex) : mutex_(mutex) { mutex_.lock(); }
  lock_guard(const lock_guard&) = delete;
  lock_guard& operator=(const lock_guard&) = delete;
  ~lock_guard() { mutex_.unlock(); }

private:
  Mutex& mutex_;
};

template <class Mutex>
class unique_lock {
public:
  unique_lock() = default;
  explicit unique_lock(Mutex& mutex) : lock_(mutex) {}
  unique_lock(std::defer_lock_t tag) : lock_(tag) {}
  unique_lock(std::try_to_lock_t tag) : lock_(tag) {}
  unique_lock(std::adopt_lock_t tag) : lock_(tag) {}
  unique_lock(const unique_lock&) = delete;
  unique_lock& operator=(const unique_lock&) = delete;
  unique_lock(unique_lock&&) noexcept = default;
  unique_lock& operator=(unique_lock&&) noexcept = default;
  ~unique_lock() = default;

  void lock() { lock_.lock(); }
  bool try_lock() { return lock_.try_lock(); }
  void unlock() { lock_.unlock(); }
  bool owns_lock() const noexcept { return lock_.owns_lock(); }
  explicit operator bool() const noexcept { return owns_lock(); }
  Mutex* mutex() const noexcept { return lock_.mutex(); }
  Mutex* release() noexcept { return lock_.release(); }

private:
  std::unique_lock<Mutex> lock_;
};

// ---------------- condition_variable --------------------------------------
// condition_variable_any accepts the compatibility mutex and lock types. Its
// wait implementation atomically unlocks the caller's lock while sleeping and
// reacquires it before returning. The previous shim constructed a second
// std::unique_lock on an already-owned mutex, which could deadlock.
using system_time = boost::posix_time::ptime;

inline system_time get_system_time()
{
  return boost::posix_time::microsec_clock::universal_time();
}

inline std::chrono::microseconds to_std_duration(const boost::posix_time::time_duration& duration)
{
  return std::chrono::microseconds(duration.total_microseconds());
}

inline std::chrono::microseconds to_std_duration_until(const system_time& deadline)
{
  const auto now = boost::posix_time::microsec_clock::universal_time();
  if (deadline <= now)
    return std::chrono::microseconds::zero();
  return to_std_duration(deadline - now);
}

class condition_variable {
public:
  condition_variable() = default;
  condition_variable(const condition_variable&) = delete;
  condition_variable& operator=(const condition_variable&) = delete;

  template <class Lock>
  void wait(Lock& lock)
  {
    cv_.wait(lock);
  }

  template <class Lock, class Predicate>
  void wait(Lock& lock, Predicate predicate)
  {
    cv_.wait(lock, std::move(predicate));
  }

  template <class Lock>
  bool timed_wait(Lock& lock, const system_time& deadline)
  {
    return cv_.wait_for(lock, to_std_duration_until(deadline)) != std::cv_status::timeout;
  }

  template <class Lock>
  bool timed_wait(Lock& lock, const boost::posix_time::time_duration& duration)
  {
    return cv_.wait_for(lock, to_std_duration(duration)) != std::cv_status::timeout;
  }

  template <class Lock, class Predicate>
  bool timed_wait(Lock& lock, const system_time& deadline, Predicate predicate)
  {
    return cv_.wait_for(lock, to_std_duration_until(deadline), std::move(predicate));
  }

  template <class Lock, class Predicate>
  bool timed_wait(Lock& lock, const boost::posix_time::time_duration& duration, Predicate predicate)
  {
    return cv_.wait_for(lock, to_std_duration(duration), std::move(predicate));
  }

  template <class Lock, class Rep, class Period>
  std::cv_status wait_for(Lock& lock, const std::chrono::duration<Rep, Period>& duration)
  {
    return cv_.wait_for(lock, duration);
  }

  template <class Lock, class Rep, class Period, class Predicate>
  bool wait_for(Lock& lock, const std::chrono::duration<Rep, Period>& duration, Predicate predicate)
  {
    return cv_.wait_for(lock, duration, std::move(predicate));
  }

  void notify_one() noexcept { cv_.notify_one(); }
  void notify_all() noexcept { cv_.notify_all(); }

private:
  std::condition_variable_any cv_;
};

// ---------------- thread ---------------------------------------------------
#ifdef ORCA_WASM_THREADING

// Threaded artifact: preserve the Boost-facing API while using the standard
// library's Emscripten-pthread implementation underneath. std::thread has no
// portable stack-size API, so attributes are accepted for source compatibility
// but the requested size is intentionally not applied here.
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
  template <class Fn> explicit thread(Fn&& fn) : thread_(make_invoker(std::forward<Fn>(fn))) {}
  template <class Fn> thread(attributes&, Fn&& fn) : thread_(make_invoker(std::forward<Fn>(fn))) {}
  thread(const thread&) = delete;
  thread& operator=(const thread&) = delete;
  thread(thread&&) noexcept = default;
  thread& operator=(thread&&) noexcept = default;
  ~thread() = default;

  id get_id() const noexcept { return thread_.get_id(); }
  using native_handle_type = std::thread::native_handle_type;
  native_handle_type native_handle() { return thread_.native_handle(); }
  bool joinable() const noexcept { return thread_.joinable(); }
  void join() { thread_.join(); }
  void detach() { thread_.detach(); }
  void swap(thread& other) noexcept { thread_.swap(other.thread_); }
  static unsigned int hardware_concurrency() noexcept { return std::thread::hardware_concurrency(); }

private:
  template <class Fn>
  static auto make_invoker(Fn&& fn)
  {
    using T = typename std::decay<Fn>::type;
    if constexpr (boost::is_reference_wrapper<T>::value) {
      return [fn = std::forward<Fn>(fn)]() mutable { fn.get()(); };
    } else {
      return std::forward<Fn>(fn);
    }
  }

  std::thread thread_;
};

#else

// Serial artifact: code that must compile but is outside the synchronous v1
// slice path runs only when join() or detach() is called.
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
  using native_handle_type = std::thread::native_handle_type;
  native_handle_type native_handle() const { return native_handle_type{}; }
  bool joinable() const { return !joined_ && static_cast<bool>(fn_); }
  void join() { run_once(); }
  void detach() { run_once(); }
  void swap(thread& other) {
    std::swap(fn_, other.fn_);
    std::swap(joined_, other.joined_);
    std::swap(ran_, other.ran_);
    std::swap(id_, other.id_);
  }
  static unsigned int hardware_concurrency() { return 1; }

private:
  template <class Fn>
  static std::function<void()> make_invoker(Fn&& fn)
  {
    using T = typename std::decay<Fn>::type;
    if constexpr (boost::is_reference_wrapper<T>::value) {
      return [fn = std::forward<Fn>(fn)]() mutable { fn.get()(); };
    } else {
      return std::function<void()>(std::forward<Fn>(fn));
    }
  }

  void run_once()
  {
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

#endif

namespace this_thread {
inline thread::id get_id() { return std::this_thread::get_id(); }
}  // namespace this_thread

}  // namespace boost
