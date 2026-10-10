"""Bounded, truthful local CPU/GPU/RAM sampling for the CLI HUD."""
import ctypes
import math
import os
import re
import shutil
import subprocess
import threading
import time
import uuid


class SystemTelemetry:
    """Sample on one daemon worker; snapshot() never waits for a device probe."""

    def __init__(self, interval=1.5, cpu_reader=None, ram_reader=None,
                 gpu_reader=None):
        self.interval = max(0.5, min(10.0, float(interval)))
        self._cpu_reader = cpu_reader or self._read_cpu
        self._ram_reader = ram_reader or self._read_ram
        self._gpu_reader = gpu_reader or self._read_gpu
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._cpu_previous = None
        self._sample = {
            "at": None, "cpu_pct": None, "gpu_pct": None,
            "gpu_name": None, "gpu_memory_used": None,
            "gpu_memory_total": None, "gpu_status": "waiting",
            "gpu_metric": None,
            "ram_used": None, "ram_total": None,
        }

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="reach-cli-telemetry", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        worker = self._thread
        if worker and worker is not threading.current_thread():
            worker.join(timeout=0.1)

    def snapshot(self):
        with self._lock:
            return dict(self._sample)

    def sample_once(self):
        """Take one reading; call from the worker, not the input thread."""
        try:
            cpu = self._cpu_reader()
        except Exception:
            cpu = None
        try:
            memory = self._ram_reader() or {}
        except Exception:
            memory = {}
        try:
            gpu = self._gpu_reader() or {}
        except Exception as exc:
            gpu = {"available": False, "reason": str(exc)}
        sample = {
            "at": time.time(),
            "cpu_pct": self._valid_percent(cpu),
            "gpu_pct": self._valid_percent(gpu.get("pct")),
            "gpu_name": gpu.get("name"),
            "gpu_memory_used": self._valid_number(gpu.get("memory_used")),
            "gpu_memory_total": self._valid_number(gpu.get("memory_total")),
            "gpu_metric": str(gpu.get("metric") or "") or None,
            "gpu_status": ("available" if gpu.get("available") else
                           str(gpu.get("reason") or "unavailable")),
            "ram_used": self._valid_number(memory.get("used")),
            "ram_total": self._valid_number(memory.get("total")),
        }
        with self._lock:
            self._sample = sample
        return dict(sample)

    def _run(self):
        while not self._stop.is_set():
            started = time.monotonic()
            self.sample_once()
            self._stop.wait(max(0.05, self.interval - (time.monotonic() - started)))

    @staticmethod
    def _valid_number(value):
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return number if math.isfinite(number) and number >= 0 else None

    @classmethod
    def _valid_percent(cls, value):
        number = cls._valid_number(value)
        return min(100.0, number) if number is not None else None

    def _read_cpu(self):
        if os.name == "nt":
            return self._read_cpu_windows()
        if os.path.isfile("/proc/stat"):
            return self._read_cpu_proc()
        return None

    def _read_cpu_proc(self):
        try:
            with open("/proc/stat", "r", encoding="ascii") as handle:
                parts = handle.readline().split()
            if not parts or parts[0] != "cpu":
                return None
            counters = [int(value) for value in parts[1:]]
            if len(counters) < 5:
                return None
            total = sum(counters)
            idle = counters[3] + counters[4]
        except (OSError, ValueError):
            return None
        previous = self._cpu_previous
        self._cpu_previous = (total, idle)
        if previous is None:
            return None
        delta_total = total - previous[0]
        delta_idle = idle - previous[1]
        if delta_total <= 0:
            return None
        return 100.0 * max(0, delta_total - delta_idle) / delta_total

    def _read_cpu_windows(self):
        class FileTime(ctypes.Structure):
            _fields_ = [("low", ctypes.c_ulong), ("high", ctypes.c_ulong)]

        idle, kernel, user = FileTime(), FileTime(), FileTime()
        try:
            ok = ctypes.WinDLL("kernel32", use_last_error=True).GetSystemTimes(
                ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
            if not ok:
                return None
        except (AttributeError, OSError):
            return None

        def ticks(value):
            return (int(value.high) << 32) | int(value.low)

        idle_ticks = ticks(idle)
        total_ticks = ticks(kernel) + ticks(user)
        previous = self._cpu_previous
        self._cpu_previous = (total_ticks, idle_ticks)
        if previous is None:
            return None
        delta_total = total_ticks - previous[0]
        delta_idle = idle_ticks - previous[1]
        if delta_total <= 0:
            return None
        return 100.0 * max(0, delta_total - delta_idle) / delta_total

    @staticmethod
    def _read_ram():
        if os.name == "nt":
            class MemoryStatusEx(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MemoryStatusEx()
            status.dwLength = ctypes.sizeof(status)
            try:
                ok = ctypes.WinDLL("kernel32", use_last_error=True).GlobalMemoryStatusEx(
                    ctypes.byref(status))
            except (AttributeError, OSError):
                return {}
            if not ok or not status.ullTotalPhys:
                return {}
            return {"used": status.ullTotalPhys - status.ullAvailPhys,
                    "total": status.ullTotalPhys}

        if os.path.isfile("/proc/meminfo"):
            values = {}
            try:
                with open("/proc/meminfo", "r", encoding="ascii") as handle:
                    for line in handle:
                        key, _, raw = line.partition(":")
                        if key in ("MemTotal", "MemAvailable"):
                            values[key] = int(raw.strip().split()[0]) * 1024
            except (OSError, ValueError, IndexError):
                return {}
            total = values.get("MemTotal")
            available = values.get("MemAvailable")
            if total and available is not None:
                return {"used": max(0, total - available), "total": total}
        return {}

    @staticmethod
    def _read_gpu():
        executable = shutil.which("nvidia-smi")
        nvidia_failure = "nvidia-smi unavailable"
        if executable:
            try:
                result = subprocess.run(
                    [executable, "--query-gpu=name,utilization.gpu,memory.used,memory.total",
                     "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=0.8,
                    stdin=subprocess.DEVNULL, check=False, shell=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                nvidia_failure = "GPU sample timed out"
            else:
                if result.returncode == 0 and result.stdout.strip():
                    first = result.stdout.splitlines()[0].split(",")
                    if len(first) >= 4:
                        def number(raw):
                            try:
                                value = float(raw.strip())
                            except (TypeError, ValueError):
                                return None
                            return value if math.isfinite(value) and value >= 0 else None

                        return {
                            "available": True,
                            "name": first[0].strip() or None,
                            "pct": number(first[1]),
                            "memory_used": number(first[2]),
                            "memory_total": number(first[3]),
                            "metric": "GPU utilization",
                        }
                nvidia_failure = "GPU sample unavailable"

        if os.name == "nt":
            sample = _read_windows_gpu_counters()
            if sample.get("available"):
                return sample
            return sample
        return {"available": False, "reason": nvidia_failure}


_PDH_SUCCESS = 0
_PDH_MORE_DATA = 0x800007D2
_PDH_FMT_DOUBLE = 0x00000200
_PDH_FMT_LARGE = 0x00000400
_PDH_MAX_PATH_CHARS = 2_000_000
_PDH_MAX_3D_COUNTERS = 1024
_DXGI_ERROR_NOT_FOUND = 0x887A0002
_DXGI_ADAPTER_FLAG_SOFTWARE = 0x2
_COUNTER_SAMPLE_STATUSES = (0, 1)  # PDH_CSTATUS_VALID_DATA, NEW_DATA
_MIB = 1024.0 * 1024.0


class _PdhValueUnion(ctypes.Union):
    _fields_ = [("long_value", ctypes.c_long),
                ("double_value", ctypes.c_double),
                ("large_value", ctypes.c_longlong),
                ("ansi_string_value", ctypes.c_char_p),
                ("wide_string_value", ctypes.c_wchar_p)]


class _PdhFormattedValue(ctypes.Structure):
    _fields_ = [("status", ctypes.c_uint32), ("value", _PdhValueUnion)]


class _DxgiGuid(ctypes.Structure):
    _fields_ = [("data1", ctypes.c_uint32), ("data2", ctypes.c_uint16),
                ("data3", ctypes.c_uint16), ("data4", ctypes.c_ubyte * 8)]


class _DxgiLuid(ctypes.Structure):
    _fields_ = [("low_part", ctypes.c_uint32), ("high_part", ctypes.c_int32)]


class _DxgiAdapterDesc1(ctypes.Structure):
    _fields_ = [("description", ctypes.c_wchar * 128),
                ("vendor_id", ctypes.c_uint32),
                ("device_id", ctypes.c_uint32),
                ("subsys_id", ctypes.c_uint32),
                ("revision", ctypes.c_uint32),
                ("dedicated_video_memory", ctypes.c_size_t),
                ("dedicated_system_memory", ctypes.c_size_t),
                ("shared_system_memory", ctypes.c_size_t),
                ("adapter_luid", _DxgiLuid),
                ("flags", ctypes.c_uint32)]


def _dxgi_video_adapters():
    """Read hardware adapter names, VRAM totals, and LUIDs using built-in DXGI."""
    dxgi = ctypes.WinDLL("dxgi", use_last_error=True)
    iid = _DxgiGuid.from_buffer_copy(
        uuid.UUID("770aae78-f26f-4dba-a829-253c83d1b387").bytes_le)
    factory = ctypes.c_void_p()
    create_factory = dxgi.CreateDXGIFactory1
    create_factory.argtypes = [ctypes.POINTER(_DxgiGuid),
                               ctypes.POINTER(ctypes.c_void_p)]
    create_factory.restype = ctypes.c_long
    result = create_factory(ctypes.byref(iid), ctypes.byref(factory))
    if result != _PDH_SUCCESS or not factory.value:
        return []

    adapters = []
    factory_table = ctypes.cast(
        factory, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    enum_adapters = ctypes.WINFUNCTYPE(
        ctypes.c_long, ctypes.c_void_p, ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_void_p))(factory_table[12])
    release_factory = ctypes.WINFUNCTYPE(
        ctypes.c_ulong, ctypes.c_void_p)(factory_table[2])
    try:
        for index in range(64):
            adapter = ctypes.c_void_p()
            result = enum_adapters(factory, index, ctypes.byref(adapter))
            if result & 0xFFFFFFFF == _DXGI_ERROR_NOT_FOUND:
                break
            if result != _PDH_SUCCESS or not adapter.value:
                continue
            adapter_table = ctypes.cast(
                adapter, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            get_desc = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p,
                ctypes.POINTER(_DxgiAdapterDesc1))(adapter_table[10])
            release_adapter = ctypes.WINFUNCTYPE(
                ctypes.c_ulong, ctypes.c_void_p)(adapter_table[2])
            try:
                desc = _DxgiAdapterDesc1()
                if get_desc(adapter, ctypes.byref(desc)) == _PDH_SUCCESS:
                    adapters.append({
                        "name": desc.description.strip() or None,
                        "vendor_id": int(desc.vendor_id),
                        "high": int(desc.adapter_luid.high_part) & 0xFFFFFFFF,
                        "low": int(desc.adapter_luid.low_part) & 0xFFFFFFFF,
                        "dedicated_bytes": int(desc.dedicated_video_memory),
                        "software": bool(desc.flags & _DXGI_ADAPTER_FLAG_SOFTWARE),
                    })
            finally:
                release_adapter(adapter)
    finally:
        release_factory(factory)
    return adapters


def _expand_pdh_paths(pdh, wildcard):
    expand = pdh.PdhExpandWildCardPathW
    expand.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p,
                       ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32),
                       ctypes.c_uint32]
    expand.restype = ctypes.c_uint32
    required = ctypes.c_uint32(0)
    result = expand(None, wildcard, None, ctypes.byref(required), 0)
    if result not in (_PDH_MORE_DATA, _PDH_SUCCESS):
        return []
    if required.value < 2 or required.value > _PDH_MAX_PATH_CHARS:
        return []
    buffer = ctypes.create_unicode_buffer(required.value)
    result = expand(None, wildcard, buffer, ctypes.byref(required), 0)
    if result != _PDH_SUCCESS:
        return []
    return [path for path in buffer[:required.value].split("\0") if path]


def _read_windows_gpu_counters():
    """Read primary hardware GPU 3D use and local-memory PDH counters."""
    try:
        adapters = [item for item in _dxgi_video_adapters()
                    if not item["software"]]
        if not adapters:
            return {"available": False,
                    "reason": "Windows GPU adapter unavailable"}
        adapter = max(adapters, key=lambda item: item["dedicated_bytes"])
        luid = "luid_0x%08x_0x%08x" % (adapter["high"], adapter["low"])
        pdh = ctypes.WinDLL("pdh", use_last_error=True)
        engine_paths = [path for path in _expand_pdh_paths(
            pdh, r"\GPU Engine(*)\Utilization Percentage")
            if luid in path.lower() and re.search(
                r"_eng_(\d+)_engtype_3d\)", path, re.IGNORECASE)]
        memory_paths = [path for path in _expand_pdh_paths(
            pdh, r"\GPU Local Adapter Memory(*)\Local Usage")
            if luid in path.lower()]
        if len(engine_paths) > _PDH_MAX_3D_COUNTERS:
            engine_paths = []  # never report partial system utilization

        query = ctypes.c_void_p()
        pdh.PdhOpenQueryW.argtypes = [ctypes.c_wchar_p, ctypes.c_size_t,
                                      ctypes.POINTER(ctypes.c_void_p)]
        pdh.PdhOpenQueryW.restype = ctypes.c_uint32
        if pdh.PdhOpenQueryW(None, 0, ctypes.byref(query)) != _PDH_SUCCESS:
            return {"available": False,
                    "reason": "Windows GPU counter query unavailable"}
        pdh.PdhAddCounterW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p,
                                       ctypes.c_size_t,
                                       ctypes.POINTER(ctypes.c_void_p)]
        pdh.PdhAddCounterW.restype = ctypes.c_uint32
        pdh.PdhCollectQueryData.argtypes = [ctypes.c_void_p]
        pdh.PdhCollectQueryData.restype = ctypes.c_uint32
        pdh.PdhGetFormattedCounterValue.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32),
            ctypes.POINTER(_PdhFormattedValue)]
        pdh.PdhGetFormattedCounterValue.restype = ctypes.c_uint32
        pdh.PdhCloseQuery.argtypes = [ctypes.c_void_p]
        pdh.PdhCloseQuery.restype = ctypes.c_uint32

        engine_counters, memory_counter = [], None
        try:
            for path in engine_paths:
                match = re.search(r"_eng_(\d+)_engtype_3d\)", path,
                                  re.IGNORECASE)
                if not match:
                    continue
                counter = ctypes.c_void_p()
                if pdh.PdhAddCounterW(query, path, 0,
                                      ctypes.byref(counter)) == _PDH_SUCCESS:
                    engine_counters.append((int(match.group(1)), counter))
            for path in memory_paths[:1]:
                counter = ctypes.c_void_p()
                if pdh.PdhAddCounterW(query, path, 0,
                                      ctypes.byref(counter)) == _PDH_SUCCESS:
                    memory_counter = counter
                    break

            if not engine_counters and memory_counter is None:
                return {"available": False,
                        "reason": "Windows GPU counters unavailable"}
            if pdh.PdhCollectQueryData(query) != _PDH_SUCCESS:
                return {"available": False,
                        "reason": "Windows GPU counter sample unavailable"}
            if engine_counters:
                time.sleep(0.15)
                if pdh.PdhCollectQueryData(query) != _PDH_SUCCESS:
                    engine_counters = []

            engine_load = {}
            for engine_id, counter in engine_counters:
                value, value_type = _PdhFormattedValue(), ctypes.c_uint32()
                result = pdh.PdhGetFormattedCounterValue(
                    counter, _PDH_FMT_DOUBLE, ctypes.byref(value_type),
                    ctypes.byref(value))
                if (result == _PDH_SUCCESS and
                        value.status in _COUNTER_SAMPLE_STATUSES and
                        math.isfinite(value.value.double_value) and
                        value.value.double_value >= 0):
                    engine_load[engine_id] = (
                        engine_load.get(engine_id, 0.0) +
                        value.value.double_value)

            memory_used = None
            if memory_counter is not None:
                value, value_type = _PdhFormattedValue(), ctypes.c_uint32()
                result = pdh.PdhGetFormattedCounterValue(
                    memory_counter, _PDH_FMT_LARGE, ctypes.byref(value_type),
                    ctypes.byref(value))
                if (result == _PDH_SUCCESS and
                        value.status in _COUNTER_SAMPLE_STATUSES and
                        value.value.large_value >= 0):
                    memory_used = value.value.large_value / _MIB

            gpu_pct = (min(100.0, max(engine_load.values()))
                       if engine_load else None)
            available = gpu_pct is not None or memory_used is not None
            if not available:
                return {"available": False,
                        "reason": "Windows GPU counter sample unavailable"}
            total_mib = (adapter["dedicated_bytes"] / _MIB
                         if adapter["dedicated_bytes"] > 0 else None)
            return {
                "available": True,
                "name": adapter["name"],
                "pct": gpu_pct,
                "memory_used": memory_used,
                "memory_total": total_mib,
                "metric": ("3D engine utilization" if gpu_pct is not None
                           else "local GPU memory"),
            }
        finally:
            if query.value:
                pdh.PdhCloseQuery(query)
    except (AttributeError, OSError, ctypes.ArgumentError, ValueError,
            OverflowError):
        return {"available": False,
                "reason": "Windows GPU counters unavailable"}
