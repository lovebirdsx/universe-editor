// Windows process bindings for process-tree containment and exit observation
// (Node-API, no node-addon-api). Every job is created with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and WITHOUT any breakaway flag: members'
// descendants stay in the job, and the OS kills the whole tree when the last handle
// closes (including when the main process dies).
//
// Handles cross the JS boundary as BigInt. JS owns their lifetime and never reuses a
// handle after close(), so no finalizer/external is needed.
#include <node_api.h>
#include <windows.h>
#include <tlhelp32.h>

#include <cstdint>
#include <cwchar>
#include <new>
#include <string>
#include <vector>

namespace {

// assign() status: 0 = ok, >0 = Win32 error code, kRefusedSelf = guard against
// containing (and therefore killing) the editor's own main process.
constexpr int32_t kRefusedSelf = -1;

napi_value ThrowWin32(napi_env env, const char* what, DWORD err) {
  std::string msg = std::string(what) + " failed: win32 error " + std::to_string(err);
  napi_throw_error(env, std::to_string(err).c_str(), msg.c_str());
  return nullptr;
}

bool GetJob(napi_env env, napi_value value, HANDLE* out) {
  uint64_t raw = 0;
  bool lossless = false;
  if (napi_get_value_bigint_uint64(env, value, &raw, &lossless) != napi_ok || !lossless) {
    napi_throw_type_error(env, nullptr, "job handle must be a BigInt");
    return false;
  }
  *out = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(raw));
  return true;
}

napi_value CreateJob(napi_env env, napi_callback_info) {
  // Non-inheritable (null attributes): children must never hold a reference, or
  // closing our handle would not release the job.
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) return ThrowWin32(env, "CreateJobObject", GetLastError());

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = {};
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info))) {
    DWORD err = GetLastError();
    CloseHandle(job);
    return ThrowWin32(env, "SetInformationJobObject", err);
  }

  napi_value result;
  napi_create_bigint_uint64(env, static_cast<uint64_t>(reinterpret_cast<uintptr_t>(job)), &result);
  return result;
}

napi_value Assign(napi_env env, napi_callback_info cbinfo) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, cbinfo, &argc, argv, nullptr, nullptr);
  HANDLE job;
  uint32_t pid = 0;
  if (argc < 2 || !GetJob(env, argv[0], &job) ||
      napi_get_value_uint32(env, argv[1], &pid) != napi_ok) {
    napi_throw_type_error(env, nullptr, "assign(job: bigint, pid: number)");
    return nullptr;
  }

  napi_value result;
  if (pid == 0 || pid == GetCurrentProcessId()) {
    napi_create_int32(env, kRefusedSelf, &result);
    return result;
  }

  // QUERY_LIMITED_INFORMATION is what GetExitCodeProcess needs — without it the exited
  // check below silently fails and a zombie surfaces as a confusing ACCESS_DENIED.
  HANDLE proc = OpenProcess(
      PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (proc == nullptr) {
    napi_create_int32(env, static_cast<int32_t>(GetLastError()), &result);
    return result;
  }
  // A zombie (exited, handle still referenced elsewhere) would fail the assign with a
  // confusing ACCESS_DENIED; report it as what it is.
  DWORD exitCode = 0;
  if (GetExitCodeProcess(proc, &exitCode) && exitCode != STILL_ACTIVE) {
    CloseHandle(proc);
    napi_create_int32(env, static_cast<int32_t>(ERROR_PROCESS_ABORTED), &result);
    return result;
  }
  int32_t status = AssignProcessToJobObject(job, proc) ? 0 : static_cast<int32_t>(GetLastError());
  if (status == ERROR_ACCESS_DENIED) {
    // A process that has begun exiting cannot join a job and is refused this way, while
    // the check above can still see STILL_ACTIVE. Re-check once so short-lived children
    // (ripgrep) report "already exited" instead of a containment failure.
    DWORD after = 0;
    if (GetExitCodeProcess(proc, &after) && after != STILL_ACTIVE) {
      status = static_cast<int32_t>(ERROR_PROCESS_ABORTED);
    }
  }
  CloseHandle(proc);
  napi_create_int32(env, status, &result);
  return result;
}

napi_value Terminate(napi_env env, napi_callback_info cbinfo) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, cbinfo, &argc, argv, nullptr, nullptr);
  HANDLE job;
  uint32_t exitCode = 1;
  if (argc < 1 || !GetJob(env, argv[0], &job)) return nullptr;
  if (argc >= 2) napi_get_value_uint32(env, argv[1], &exitCode);

  napi_value result;
  napi_get_boolean(env, TerminateJobObject(job, exitCode) != 0, &result);
  return result;
}

napi_value Close(napi_env env, napi_callback_info cbinfo) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, cbinfo, &argc, argv, nullptr, nullptr);
  HANDLE job;
  if (argc < 1 || !GetJob(env, argv[0], &job)) return nullptr;

  napi_value result;
  napi_get_boolean(env, CloseHandle(job) != 0, &result);
  return result;
}

napi_value ListPids(napi_env env, napi_callback_info cbinfo) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, cbinfo, &argc, argv, nullptr, nullptr);
  HANDLE job;
  if (argc < 1 || !GetJob(env, argv[0], &job)) return nullptr;

  size_t capacity = 64;
  std::vector<char> buffer;
  for (;;) {
    buffer.assign(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + capacity * sizeof(ULONG_PTR), 0);
    auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
    if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, list,
                                  static_cast<DWORD>(buffer.size()), nullptr)) {
      napi_value array;
      napi_create_array_with_length(env, list->NumberOfProcessIdsInList, &array);
      for (DWORD i = 0; i < list->NumberOfProcessIdsInList; i++) {
        napi_value pid;
        napi_create_uint32(env, static_cast<uint32_t>(list->ProcessIdList[i]), &pid);
        napi_set_element(env, array, i, pid);
      }
      return array;
    }
    DWORD err = GetLastError();
    if (err != ERROR_MORE_DATA) return ThrowWin32(env, "QueryInformationJobObject", err);
    capacity *= 4;
  }
}

// Whole-machine pid -> ppid snapshot. The orphan sweep needs it because a process whose
// parent exited is no longer reachable from getProcessList(root): the link is gone, not
// the process. Deliberately has no fixed capacity: truncating the snapshot would make a
// still-alive parent look dead and turn its children into false orphans.
//
// szExeFile comes from the same PROCESSENTRY32W row, so the executable name is free: the
// sweep can log what it killed without spawning tasklist for names the snapshot already
// holds.
struct ProcessRow {
  uint32_t pid;
  uint32_t ppid;
  std::wstring name;
};

std::string WideToUtf8(const wchar_t* wide) {
  const int length = static_cast<int>(wcslen(wide));
  if (length == 0) return {};
  const int bytes = WideCharToMultiByte(CP_UTF8, 0, wide, length, nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string out(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide, length, out.data(), bytes, nullptr, nullptr);
  return out;
}

napi_value ListProcesses(napi_env env, napi_callback_info) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {
    return ThrowWin32(env, "CreateToolhelp32Snapshot", GetLastError());
  }

  PROCESSENTRY32W entry = {};
  entry.dwSize = sizeof(entry);
  std::vector<ProcessRow> rows;
  if (!Process32FirstW(snapshot, &entry)) {
    DWORD err = GetLastError();
    CloseHandle(snapshot);
    return ThrowWin32(env, "Process32FirstW", err);
  }
  do {
    if (entry.th32ProcessID != 0) {
      rows.push_back({entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile});
    }
  } while (Process32NextW(snapshot, &entry));
  DWORD err = GetLastError();
  CloseHandle(snapshot);
  // Process32NextW reports the normal end of enumeration this way.
  if (err != ERROR_NO_MORE_FILES) return ThrowWin32(env, "Process32NextW", err);

  napi_value array;
  napi_create_array_with_length(env, rows.size(), &array);
  for (size_t i = 0; i < rows.size(); i++) {
    napi_value item;
    napi_create_object(env, &item);
    napi_value pid;
    napi_create_uint32(env, rows[i].pid, &pid);
    napi_set_named_property(env, item, "pid", pid);
    napi_value ppid;
    napi_create_uint32(env, rows[i].ppid, &ppid);
    napi_set_named_property(env, item, "ppid", ppid);
    const std::string name = WideToUtf8(rows[i].name.c_str());
    if (!name.empty()) {
      napi_value value;
      napi_create_string_utf8(env, name.c_str(), name.size(), &value);
      napi_set_named_property(env, item, "name", value);
    }
    napi_set_element(env, array, static_cast<uint32_t>(i), item);
  }
  return array;
}

// Async wait for another process to exit, so the JS watchdog can record the code
// without a polling loop and without blocking its event loop. The wait runs on the
// libuv thread pool; the returned promise settles with the raw DWORD exit code
// (unsigned 32-bit — NTSTATUS values such as 0xC0000005 stay intact).
struct WaitExitData {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  uint32_t pid = 0;
  DWORD exitCode = 0;
  DWORD error = 0;
};

void ExecuteWaitExit(napi_env, void* raw) {
  auto* data = static_cast<WaitExitData*>(raw);
  // QUERY_LIMITED_INFORMATION is enough for GetExitCodeProcess and works on
  // same-user processes the caller can see. A process that already vanished has
  // no process object left; there is no exit code to recover, so report the error.
  HANDLE proc =
      OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, data->pid);
  if (proc == nullptr) {
    data->error = GetLastError();
    return;
  }
  DWORD wait = WaitForSingleObject(proc, INFINITE);
  if (wait == WAIT_OBJECT_0) {
    if (!GetExitCodeProcess(proc, &data->exitCode)) data->error = GetLastError();
  } else {
    data->error = wait == WAIT_FAILED ? GetLastError() : ERROR_GEN_FAILURE;
  }
  CloseHandle(proc);
}

void CompleteWaitExit(napi_env env, napi_status status, void* raw) {
  auto* data = static_cast<WaitExitData*>(raw);
  if (status == napi_ok && data->error == 0) {
    napi_value result;
    napi_create_uint32(env, data->exitCode, &result);
    napi_resolve_deferred(env, data->deferred, result);
  } else {
    const DWORD err = data->error == 0 ? ERROR_GEN_FAILURE : data->error;
    std::string msg =
        "waitForProcessExit failed: win32 error " + std::to_string(err);
    napi_value message;
    napi_value error;
    napi_create_string_utf8(env, msg.c_str(), msg.size(), &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, data->deferred, error);
  }
  napi_delete_async_work(env, data->work);
  delete data;
}

napi_value WaitForProcessExit(napi_env env, napi_callback_info cbinfo) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, cbinfo, &argc, argv, nullptr, nullptr);
  uint32_t pid = 0;
  if (argc < 1 || napi_get_value_uint32(env, argv[0], &pid) != napi_ok || pid == 0) {
    napi_throw_type_error(env, nullptr, "waitForProcessExit(pid: number)");
    return nullptr;
  }
  // Waiting on ourselves never completes: the thread pool would pin one thread
  // for the lifetime of the process and the promise could never settle.
  if (pid == GetCurrentProcessId()) {
    napi_throw_error(env, nullptr, "waitForProcessExit cannot wait for the calling process");
    return nullptr;
  }

  auto* data = new (std::nothrow) WaitExitData();
  if (data == nullptr) {
    napi_throw_error(env, nullptr, "waitForProcessExit: out of memory");
    return nullptr;
  }
  data->pid = pid;

  napi_value promise;
  napi_create_promise(env, &data->deferred, &promise);
  napi_value resourceName;
  napi_create_string_utf8(env, "waitForProcessExit", NAPI_AUTO_LENGTH, &resourceName);
  if (napi_create_async_work(env, nullptr, resourceName, ExecuteWaitExit, CompleteWaitExit, data,
                              &data->work) != napi_ok ||
      napi_queue_async_work(env, data->work) != napi_ok) {
    if (data->work != nullptr) napi_delete_async_work(env, data->work);
    delete data;
    napi_throw_error(env, nullptr, "waitForProcessExit: failed to queue async work");
    return nullptr;
  }
  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"createJob", nullptr, CreateJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"assign", nullptr, Assign, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminate", nullptr, Terminate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"listPids", nullptr, ListPids, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"listProcesses", nullptr, ListProcesses, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"waitForProcessExit", nullptr, WaitForProcessExit, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
