// ----------------------------------------------------------------
// ------------ Serial TBB shim for the WASM slice spike ----------
// ----------------------------------------------------------------
// libslic3r parallelizes with Intel TBB (tbb::parallel_for/reduce, blocked
// ranges, enumerable_thread_specific, ...). Porting oneTBB to Emscripten is a
// project of its own, so Phase 0 runs single-threaded: this header provides
// serial, header-only stand-ins for the TBB primitives libslic3r uses. The
// build (build.sh) generates per-name forwarding headers (tbb/parallel_for.h,
// ...) that all include this file, and puts the shim ahead of any real TBB on
// the include path.
//
// Correctness note: every "parallel" primitive here runs the work inline on the
// calling thread. That is behaviorally correct for slicing (order-independent
// work), just slower. Threads come later (Phase 4) via a real oneTBB WASM build.
//
// This is intentionally a *subset*. When a compile surfaces a missing TBB
// symbol, add it here — that is expected iterative work, not a dead end.
#pragma once

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <deque>
#include <functional>
#include <list>
#include <map>
#include <memory>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

// Version macros some libslic3r TUs read via <tbb/version.h>.
#ifndef TBB_INTERFACE_VERSION
#define TBB_INTERFACE_VERSION 12050
#define TBB_INTERFACE_VERSION_MAJOR 12
#define TBB_VERSION_MAJOR 2021
#define TBB_VERSION_MINOR 5
#endif

namespace tbb {

// ---------------- Ranges ----------------
template <typename Value>
class blocked_range {
public:
  using const_iterator = Value;
  using size_type = std::size_t;

  blocked_range(Value begin, Value end, size_type grainsize = 1)
      : begin_(begin), end_(end), grainsize_(grainsize) {}

  const_iterator begin() const { return begin_; }
  const_iterator end() const { return end_; }
  size_type size() const { return size_type(end_ - begin_); }
  size_type grainsize() const { return grainsize_; }
  bool empty() const { return !(begin_ < end_); }
  bool is_divisible() const { return false; }

private:
  Value begin_;
  Value end_;
  size_type grainsize_;
};

template <typename RowValue, typename ColValue = RowValue>
class blocked_range2d {
public:
  using row_range_type = blocked_range<RowValue>;
  using col_range_type = blocked_range<ColValue>;

  blocked_range2d(RowValue row_begin, RowValue row_end, ColValue col_begin, ColValue col_end)
      : rows_(row_begin, row_end), cols_(col_begin, col_end) {}
  blocked_range2d(RowValue row_begin, RowValue row_end, std::size_t row_grain, ColValue col_begin,
                  ColValue col_end, std::size_t col_grain)
      : rows_(row_begin, row_end, row_grain), cols_(col_begin, col_end, col_grain) {}

  const row_range_type& rows() const { return rows_; }
  const col_range_type& cols() const { return cols_; }
  bool empty() const { return rows_.empty() || cols_.empty(); }

private:
  row_range_type rows_;
  col_range_type cols_;
};

// ---------------- Partitioners (ignored serially) ----------------
struct auto_partitioner {};
struct simple_partitioner {};
struct static_partitioner {};
struct affinity_partitioner {};

// ---------------- parallel_for ----------------
template <typename Range, typename Body>
void parallel_for(const Range& range, const Body& body) {
  body(range);
}
template <typename Range, typename Body, typename Partitioner>
void parallel_for(const Range& range, const Body& body, const Partitioner&) {
  body(range);
}
template <typename Index, typename Function>
void parallel_for(Index first, Index last, const Function& f) {
  for (Index i = first; i < last; ++i) f(i);
}
template <typename Index, typename Function>
void parallel_for(Index first, Index last, Index step, const Function& f) {
  for (Index i = first; i < last; i += step) f(i);
}

// ---------------- parallel_for_each ----------------
template <typename Iterator, typename Function>
void parallel_for_each(Iterator first, Iterator last, const Function& f) {
  for (; first != last; ++first) f(*first);
}
template <typename Container, typename Function>
void parallel_for_each(Container& c, const Function& f) {
  for (auto& element : c) f(element);
}

// ---------------- parallel_reduce ----------------
// Functional form: one chunk, so the reduction never runs.
template <typename Range, typename Value, typename RealBody, typename Reduction>
Value parallel_reduce(const Range& range, const Value& identity, const RealBody& real_body,
                      const Reduction&) {
  return real_body(range, identity);
}
template <typename Range, typename Value, typename RealBody, typename Reduction,
          typename Partitioner>
Value parallel_reduce(const Range& range, const Value& identity, const RealBody& real_body,
                      const Reduction&, const Partitioner&) {
  return real_body(range, identity);
}
// Imperative form: the body accumulates into itself; no split/join needed.
template <typename Range, typename Body>
void parallel_reduce(const Range& range, Body& body) {
  body(range);
}
template <typename Range, typename Body, typename Partitioner>
void parallel_reduce(const Range& range, Body& body, const Partitioner&) {
  body(range);
}

// ---------------- parallel_sort / parallel_invoke ----------------
template <typename Iterator>
void parallel_sort(Iterator first, Iterator last) {
  std::sort(first, last);
}
template <typename Iterator, typename Compare>
void parallel_sort(Iterator first, Iterator last, Compare comp) {
  std::sort(first, last, comp);
}
template <typename... Functions>
void parallel_invoke(Functions&&... fns) {
  (std::forward<Functions>(fns)(), ...);
}

// ---------------- enumerable_thread_specific ----------------
// One logical thread, so at most one stored value. Backed by std::list so the
// container-iteration + combine patterns libslic3r uses keep working.
template <typename T>
class enumerable_thread_specific {
public:
  using value_type = T;
  using iterator = typename std::list<T>::iterator;
  using const_iterator = typename std::list<T>::const_iterator;

  enumerable_thread_specific() : init_([] { return T(); }) {}
  enumerable_thread_specific(const T& exemplar) : init_([exemplar] { return exemplar; }) {}
  template <typename Finit,
            typename = std::enable_if_t<!std::is_same<std::decay_t<Finit>, T>::value>>
  enumerable_thread_specific(Finit finit) : init_(std::move(finit)) {}

  T& local() {
    if (storage_.empty()) storage_.push_back(init_());
    return storage_.back();
  }
  T& local(bool& exists) {
    exists = !storage_.empty();
    return local();
  }

  iterator begin() { return storage_.begin(); }
  iterator end() { return storage_.end(); }
  const_iterator begin() const { return storage_.begin(); }
  const_iterator end() const { return storage_.end(); }
  std::size_t size() const { return storage_.size(); }
  bool empty() const { return storage_.empty(); }
  void clear() { storage_.clear(); }

  template <typename Combine>
  T combine(Combine combine_fn) const {
    T result = const_cast<enumerable_thread_specific*>(this)->init_();
    for (const auto& value : storage_) result = combine_fn(result, value);
    return result;
  }

private:
  std::list<T> storage_;
  std::function<T()> init_;
};

// ---------------- combinable ----------------
template <typename T>
class combinable {
public:
  combinable() : init_([] { return T(); }) {}
  template <typename Finit>
  combinable(Finit finit) : init_(std::move(finit)) {}

  T& local() {
    if (!value_) value_ = std::make_unique<T>(init_());
    return *value_;
  }
  template <typename Combine>
  T combine(Combine combine_fn) const {
    return value_ ? *value_ : const_cast<combinable*>(this)->init_();
    (void)combine_fn;  // single value: nothing to combine
  }

private:
  std::unique_ptr<T> value_;
  std::function<T()> init_;
};

// ---------------- Mutexes (no-op serially) ----------------
class spin_mutex {
public:
  class scoped_lock {
  public:
    scoped_lock() = default;
    explicit scoped_lock(spin_mutex&) {}
    void acquire(spin_mutex&) {}
    bool try_acquire(spin_mutex&) { return true; }
    void release() {}
  };
  void lock() {}
  void unlock() {}
  bool try_lock() { return true; }
};
using mutex = spin_mutex;
using spin_rw_mutex = spin_mutex;
using queuing_mutex = spin_mutex;

// ---------------- task_group / task_arena / this_task_arena ----------------
class task_group {
public:
  template <typename Function>
  void run(Function&& f) {
    std::forward<Function>(f)();
  }
  template <typename Function>
  void run_and_wait(Function&& f) {
    std::forward<Function>(f)();
  }
  void wait() {}
  void cancel() {}
};

class task_arena {
public:
  static constexpr int automatic = -1;
  task_arena(int = automatic, int = 1) {}
  void initialize() {}
  void initialize(int) {}
  template <typename Function>
  auto execute(Function&& f) -> decltype(f()) {
    return std::forward<Function>(f)();
  }
};

namespace this_task_arena {
inline int max_concurrency() { return 1; }
inline int current_thread_index() { return 0; }
template <typename Function>
auto isolate(Function&& f) -> decltype(f()) {
  return std::forward<Function>(f)();
}
}  // namespace this_task_arena

// ---------------- global_control (old + oneTBB spellings) ----------------
class global_control {
public:
  enum parameter { max_allowed_parallelism, thread_stack_size };
  global_control(parameter, std::size_t) {}
  static std::size_t active_value(parameter) { return 1; }
};

// Legacy scheduler init (removed in oneTBB, still referenced by old code).
class task_scheduler_init {
public:
  static constexpr int automatic = -1;
  static constexpr int deferred = -2;
  task_scheduler_init(int = automatic, std::size_t = 0) {}
  void initialize(int = automatic) {}
  void terminate() {}
  bool is_active() const { return true; }
  static int default_num_threads() { return 1; }
};

// ---------------- Allocators (fall back to std) ----------------
template <typename T>
using cache_aligned_allocator = std::allocator<T>;
template <typename T>
using scalable_allocator = std::allocator<T>;
template <typename T>
using tbb_allocator = std::allocator<T>;

// ---------------- concurrent_vector (serial: plain vector) ----------------
template <typename T, typename Allocator = cache_aligned_allocator<T>>
class concurrent_vector : public std::vector<T, Allocator> {
  using base = std::vector<T, Allocator>;

public:
  using base::base;
  using iterator = typename base::iterator;

  iterator push_back(const T& value) {
    base::push_back(value);
    return this->end() - 1;
  }
  iterator push_back(T&& value) {
    base::push_back(std::move(value));
    return this->end() - 1;
  }
  iterator grow_by(std::size_t n) {
    const std::size_t old = this->size();
    this->resize(old + n);
    return this->begin() + old;
  }
  iterator grow_by(std::size_t n, const T& value) {
    const std::size_t old = this->size();
    this->resize(old + n, value);
    return this->begin() + old;
  }
};

// ---------------- tick_count ----------------
class tick_count {
public:
  struct interval_t {
    double value;
    double seconds() const { return value; }
  };
  tick_count() : point_() {}
  static tick_count now() {
    tick_count t;
    t.point_ = std::chrono::steady_clock::now();
    return t;
  }
  friend interval_t operator-(const tick_count& a, const tick_count& b) {
    return interval_t{std::chrono::duration<double>(a.point_ - b.point_).count()};
  }

private:
  std::chrono::steady_clock::time_point point_;
};

// ---------------- Concurrent containers (serial) ----------------
template <typename Key, typename T, typename Hash = std::hash<Key>,
          typename Eq = std::equal_to<Key>,
          typename Alloc = std::allocator<std::pair<const Key, T>>>
class concurrent_unordered_map : public std::unordered_map<Key, T, Hash, Eq, Alloc> {
  using base = std::unordered_map<Key, T, Hash, Eq, Alloc>;

public:
  using base::base;
};

template <typename Key, typename T, typename Comp = std::less<Key>,
          typename Alloc = std::allocator<std::pair<const Key, T>>>
class concurrent_map : public std::map<Key, T, Comp, Alloc> {
  using base = std::map<Key, T, Comp, Alloc>;

public:
  using base::base;
};

template <typename T, typename Alloc = std::allocator<T>>
class concurrent_queue {
public:
  void push(const T& value) { queue_.push_back(value); }
  bool try_pop(T& out) {
    if (queue_.empty()) return false;
    out = std::move(queue_.front());
    queue_.pop_front();
    return true;
  }
  bool empty() const { return queue_.empty(); }
  std::size_t unsafe_size() const { return queue_.size(); }
  void clear() { queue_.clear(); }

private:
  std::deque<T, Alloc> queue_;
};

}  // namespace tbb

// oneTBB also exposes everything under the oneapi::tbb alias.
namespace oneapi {
namespace tbb = ::tbb;
}
