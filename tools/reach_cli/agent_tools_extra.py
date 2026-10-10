"""Workspace tools and lifecycle for subprocesses started by this CLI session.

The registry lives in agent_tools. This module has no credentials or remote
integrations; every mutation/execution uses the caller's existing approval gate.
"""

import codecs
import ctypes
import difflib
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import unicodedata

OUTPUT_LIMIT = 40000
FILE_LIMIT = 2 * 1024 * 1024
PROCESS_BUFFER = 65536
MAX_PROCESSES = 8


def safe_text(value, limit=OUTPUT_LIMIT):
    """Remove terminal controls and common credential values from untrusted text."""
    text = str(value)
    text = re.sub(r"\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])", "", text)
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", "", text)
    text = "".join(char for char in text if unicodedata.category(char) != "Cf")
    text = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----",
                  "[redacted private key]", text, flags=re.S)
    text = re.sub(r"(?i)(\b(?:authorization\s*:\s*(?:bearer|basic)|bearer)\s+)\S+",
                  r"\1[redacted]", text)
    key = r"(?:[\w-]*(?:api[_-]?key|token|password|passwd|secret|credential)|access_key|authorization)"
    prefix = r"(?i)([\"']?\b" + key + r"[\"']?\s*[:=]\s*)"
    text = re.sub(prefix + r"([\"'])(.*?)\2", lambda match: match.group(1) + match.group(2) + "[redacted]" + match.group(2), text)
    text = re.sub(prefix + r"(?![\"'])[^\s,;&}\]]+", r"\1[redacted]", text)
    text = re.sub(r"(?i)(--(?:api[_-]?key|token|password|secret)\s+)\S+", r"\1[redacted]", text)
    text = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b", "[redacted]", text)
    text = re.sub(r"(?i)(https?://)[^/@\s]+@", r"\1[redacted]@", text)
    if len(text) > limit:
        text = text[:limit] + "\n... [truncated at %d chars]" % limit
    return text


def resolve_path(workpath, rel, write=False, root=False):
    """Contain paths after symlink resolution; writes refuse all reparse links."""
    if not isinstance(rel, str):
        raise ValueError("path must be a relative string")
    rel = rel.replace("\\", "/")
    if (not rel and not root) or rel.startswith("/") or ":" in rel:
        raise ValueError("path must be relative to the workpath")
    if any(part == ".." for part in rel.split("/")) or any(ord(c) < 32 for c in rel):
        raise ValueError("path cannot contain parent traversal or control characters")
    base = os.path.realpath(os.path.abspath(workpath))
    target = os.path.abspath(os.path.join(base, *rel.split("/")))
    resolved = os.path.realpath(target)
    try:
        contained = os.path.commonpath([base, resolved]) == base
    except ValueError:
        contained = False
    if not contained or (resolved == base and not root):
        raise ValueError("path escapes the workpath or targets its root")
    if write:
        cursor = base
        for part in os.path.relpath(target, base).split(os.sep):
            cursor = os.path.join(cursor, part)
            try:
                info = os.lstat(cursor)
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("write paths cannot traverse symlinks or reparse points")
    return target


def _file(workpath, args, write=False):
    target = resolve_path(workpath, args.get("path", ""), write=write)
    if not os.path.isfile(target):
        raise ValueError("no such file: %s" % args.get("path"))
    return target


def _read(target):
    if os.path.getsize(target) > FILE_LIMIT:
        raise ValueError("file exceeds the 2 MiB text limit; use numbered read ranges or approved commands")
    with open(target, "r", encoding="utf-8") as handle:
        return handle.read()


def _display_file(target, text):
    if os.path.basename(target).startswith(".env"):
        text = re.sub(r"(?m)^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=).*$", r"\1[redacted]", text)
    return safe_text(text)


def _redact_json(value):
    if isinstance(value, dict):
        return {key: "[redacted]" if re.search(r"(?i)(api.?key|token|password|passwd|secret|credential|authorization)", key)
                else _redact_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    return value


def _approved(ctx, name, description):
    approve = ctx.get("approve")
    return bool(approve and approve(name, safe_text(description, 10000)))


def _denied(name):
    return "%s denied by the user" % name


def _atomic_write(target, content, overwrite=True):
    if len(content.encode("utf-8")) > FILE_LIMIT:
        raise ValueError("content exceeds the 2 MiB write limit")
    parent = os.path.dirname(target)
    if not os.path.isdir(parent):
        raise ValueError("parent directory does not exist; use mkdir first")
    descriptor, temporary = tempfile.mkstemp(prefix=".reach-write-", dir=parent)
    try:
        if os.path.isfile(target):
            os.chmod(temporary, stat.S_IMODE(os.stat(target).st_mode))
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            descriptor = None
            handle.write(content)
        if overwrite:
            os.replace(temporary, target)
        else:
            # Exclusive creation works on filesystems without hard links too
            # and never replaces a destination created after the last check.
            with open(temporary, "rb") as reader, open(target, "xb") as writer:
                shutil.copyfileobj(reader, writer, 65536)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)


def tool_file_info(workpath, args, ctx):
    target = resolve_path(workpath, args.get("path", ""), root=True)
    info = os.stat(target)
    return json.dumps({"path": args.get("path") or ".", "type": "directory" if stat.S_ISDIR(info.st_mode) else "file",
                       "size_bytes": info.st_size, "modified_unix": info.st_mtime,
                       "symlink": os.path.islink(target)}, sort_keys=True)


def tool_batch_read(workpath, args, ctx):
    paths = args.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= 20:
        raise ValueError("paths must contain 1 to 20 relative file paths")
    out = []
    for path in paths:
        try:
            target = _file(workpath, {"path": path})
            out.append("=== %s ===\n%s" % (path, _display_file(target, _read(target))))
        except (OSError, ValueError, UnicodeError) as exc:
            out.append("=== %s ===\nerror: %s" % (path, exc))
        if sum(len(part) for part in out) >= OUTPUT_LIMIT:
            break
    return safe_text("\n\n".join(out))


def tool_read_json(workpath, args, ctx):
    target = _file(workpath, args)
    data = json.loads(_read(target))
    pointer = args.get("pointer", "")
    if pointer:
        if not isinstance(pointer, str) or not pointer.startswith("/"):
            raise ValueError("pointer must be an RFC 6901 JSON pointer, such as /scripts/test")
        for key in pointer[1:].split("/"):
            key = key.replace("~1", "/").replace("~0", "~")
            if isinstance(data, list):
                if not key.isdigit() or int(key) >= len(data):
                    raise ValueError("JSON pointer does not exist")
                data = data[int(key)]
            elif isinstance(data, dict) and key in data:
                data = data[key]
            else:
                raise ValueError("JSON pointer does not exist")
    # Selecting a sensitive scalar must not remove the label needed for redaction.
    if pointer and re.search(r"(?i)(api.?key|token|password|secret|authorization)", pointer):
        return "[redacted sensitive value]"
    return _display_file(target, json.dumps(_redact_json(data), ensure_ascii=False, indent=2))


def tool_write_file(workpath, args, ctx):
    target = resolve_path(workpath, args.get("path", ""), write=True)
    content = args.get("content")
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    if os.path.exists(target) and not args.get("overwrite", False):
        raise ValueError("file exists; set overwrite=true after reading it")
    expected = args.get("expected_sha256")
    if expected and (not os.path.isfile(target) or _hash(target) != expected):
        raise ValueError("file changed: expected_sha256 does not match; read again")
    if not _approved(ctx, "write_file", "%s (%d characters, overwrite=%s)" % (args["path"], len(content), bool(args.get("overwrite")))):
        return _denied("write_file")
    target = resolve_path(workpath, args["path"], write=True)
    if os.path.exists(target) and not args.get("overwrite", False):
        raise ValueError("file appeared during approval; refusing overwrite")
    if expected and (not os.path.isfile(target) or _hash(target) != expected):
        raise ValueError("file changed during approval; expected_sha256 does not match")
    _atomic_write(target, content, overwrite=bool(args.get("overwrite", False)))
    return "wrote %s (%d characters)" % (args["path"], len(content))


def tool_write_json(workpath, args, ctx):
    if "data" not in args:
        raise ValueError("write_json needs data")
    adjusted = dict(args, content=json.dumps(args["data"], ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    # One approval, labeled by the operation actually requested.
    adjusted_ctx = dict(ctx, approve=lambda _name, detail: _approved(ctx, "write_json", detail))
    return tool_write_file(workpath, adjusted, adjusted_ctx).replace("write_file denied", "write_json denied")


def tool_append_file(workpath, args, ctx):
    target = _file(workpath, args, write=True)
    content = args.get("content")
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    current = _read(target)
    if not _approved(ctx, "append_file", "%s (+%d characters)" % (args["path"], len(content))):
        return _denied("append_file")
    target = _file(workpath, args, write=True)
    _atomic_write(target, _read(target) + content)
    return "appended %d characters to %s" % (len(content), args["path"])


def tool_replace_all(workpath, args, ctx):
    target = _file(workpath, args, write=True)
    search, replace = args.get("search"), args.get("replace")
    if not isinstance(search, str) or not search or not isinstance(replace, str):
        raise ValueError("search must be a nonempty string and replace must be a string")
    expected = args.get("expected_count")
    if isinstance(expected, bool) or not isinstance(expected, int) or expected < 1:
        raise ValueError("expected_count must be a positive integer")
    current = _read(target)
    count = current.count(search)
    if count != expected:
        raise ValueError("expected %d occurrences, found %d; read/search the file again" % (expected, count))
    if not _approved(ctx, "replace_all", "%s (%d exact replacements)" % (args["path"], count)):
        return _denied("replace_all")
    target = _file(workpath, args, write=True)
    current = _read(target)
    if current.count(search) != expected:
        raise ValueError("file changed during approval; occurrence count no longer matches")
    _atomic_write(target, current.replace(search, replace))
    return "replaced %d occurrences in %s" % (count, args["path"])


def tool_mkdir(workpath, args, ctx):
    target = resolve_path(workpath, args.get("path", ""), write=True)
    if os.path.exists(target):
        raise ValueError("path already exists")
    if not _approved(ctx, "mkdir", args["path"]):
        return _denied("mkdir")
    os.makedirs(resolve_path(workpath, args["path"], write=True), exist_ok=False)
    return "created directory %s" % args["path"]


def _pair(workpath, args):
    source = resolve_path(workpath, args.get("source", ""), write=True)
    destination = resolve_path(workpath, args.get("destination", ""), write=True)
    if not os.path.isfile(source):
        raise ValueError("source must be an existing regular file")
    if os.path.exists(destination):
        raise ValueError("destination already exists; choose a new path")
    if not os.path.isdir(os.path.dirname(destination)):
        raise ValueError("destination parent does not exist; use mkdir first")
    return source, destination


def tool_copy(workpath, args, ctx):
    source, destination = _pair(workpath, args)
    if not _approved(ctx, "copy", "%s -> %s" % (args["source"], args["destination"])):
        return _denied("copy")
    source, destination = _pair(workpath, args)
    # Exclusive creation protects a destination appearing after approval/check.
    with open(source, "rb") as reader, open(destination, "xb") as writer:
        shutil.copyfileobj(reader, writer, 65536)
    shutil.copystat(source, destination, follow_symlinks=False)
    return "copied %s to %s" % (args["source"], args["destination"])


def tool_move(workpath, args, ctx):
    source, destination = _pair(workpath, args)
    if not _approved(ctx, "move", "%s -> %s" % (args["source"], args["destination"])):
        return _denied("move")
    source, destination = _pair(workpath, args)
    # os.rename replaces a late destination on POSIX. A new hard link is an
    # atomic no-replace operation; unlink only after the link succeeds. Paths
    # crossing filesystems fail without altering either original file.
    try:
        if os.name == "nt":
            # Windows rename already refuses an existing destination.
            os.rename(source, destination)
        else:
            os.link(source, destination, follow_symlinks=False)
    except FileExistsError:
        raise ValueError("destination appeared during move; refusing overwrite")
    except OSError as exc:
        raise ValueError("move requires same-filesystem hard-link support; use approved copy then remove (%s)" % exc)
    if os.name != "nt":
        os.unlink(source)
    return "moved %s to %s" % (args["source"], args["destination"])


def tool_remove(workpath, args, ctx):
    target = resolve_path(workpath, args.get("path", ""), write=True)
    if not os.path.exists(target):
        raise ValueError("path does not exist")
    if os.path.isdir(target) and os.listdir(target):
        raise ValueError("directory is not empty; recursive removal is not supported")
    if not _approved(ctx, "remove", args["path"]):
        return _denied("remove")
    target = resolve_path(workpath, args["path"], write=True)
    if os.path.isdir(target):
        os.rmdir(target)
    else:
        os.unlink(target)
    return "removed %s" % args["path"]


def _hash(target):
    if os.path.getsize(target) > 100 * 1024 * 1024:
        raise ValueError("hash/compare file exceeds the 100 MiB limit")
    digest = hashlib.sha256()
    with open(target, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tool_hash_file(workpath, args, ctx):
    return "sha256 %s  %s" % (_hash(_file(workpath, args)), args["path"])


def tool_compare_files(workpath, args, ctx):
    left = _file(workpath, {"path": args.get("left")})
    right = _file(workpath, {"path": args.get("right")})
    if _hash(left) == _hash(right):
        return "files are identical"
    if args.get("binary", False):
        return "files differ (SHA-256 hashes differ)"
    return safe_text("files differ\n" + "".join(difflib.unified_diff(
        _read(left).splitlines(True), _read(right).splitlines(True),
        fromfile=args["left"], tofile=args["right"], n=3)))


def _argv(args):
    argv = args.get("argv")
    if not isinstance(argv, list) or not 1 <= len(argv) <= 128 or not all(isinstance(item, str) and "\x00" not in item for item in argv):
        raise ValueError("argv must be a list of 1 to 128 strings, without NUL characters")
    if not argv[0].strip():
        raise ValueError("argv[0] must name an executable")
    if sum(len(item) for item in argv) > 8192:
        raise ValueError("argv exceeds the 8192 character review limit")
    return argv


def _review_argv(argv):
    """Redact credential flag pairs structurally, preserving execution argv."""
    out, redact_next = [], False
    sensitive = re.compile(r"(?i)^[-/]+[\w-]*(?:api[_-]?key|token|password|passwd|secret|credential)$")
    for item in argv:
        if redact_next:
            out.append("[redacted]")
            redact_next = False
            continue
        flag, separator, value = item.partition("=")
        if sensitive.match(flag):
            out.append(flag + "=[redacted]" if separator else flag)
            redact_next = not bool(separator)
        else:
            out.append(safe_text(item, 8192))
    return json.dumps(out, ensure_ascii=False)


class _WindowsJob:
    """Terminate only the process tree placed in this new private job."""
    def __init__(self, process):
        self.handle = None
        if os.name != "nt":
            return
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
        class Extended(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateJobObjectW(None, None)
        if not handle:
            raise OSError(ctypes.get_last_error(), "could not create owned process job")
        info = Extended()
        info.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
        try:
            if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise OSError(ctypes.get_last_error(), "could not configure owned process job")
            if not kernel.AssignProcessToJobObject(handle, wintypes.HANDLE(int(process._handle))):
                raise OSError(ctypes.get_last_error(), "could not contain owned process tree")
        except BaseException:
            kernel.CloseHandle(handle)
            raise
        self.kernel, self.handle = kernel, handle

    def terminate(self):
        if self.handle:
            self.kernel.TerminateJobObject(self.handle, 1)

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class _OwnedPosixProcess(subprocess.Popen):
    """Keep the session leader waitable until its entire owned group is stopped.

    WNOWAIT records natural completion without releasing its PID. The retained
    leader therefore prevents the numeric PGID being reused before cleanup.
    """
    def __init__(self, *args, **kwargs):
        if not all(hasattr(os, name) for name in ("waitid", "P_PID", "WNOWAIT", "WEXITED", "WNOHANG")):
            raise OSError("owned process tools require POSIX waitid/WNOWAIT support")
        self.reaped = False
        super().__init__(*args, **kwargs)

    def poll(self):
        if self.returncode is None:
            info = os.waitid(os.P_PID, self.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if info is not None:
                self.returncode = info.si_status if info.si_code == os.CLD_EXITED else -info.si_status
        return self.returncode

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        while self.poll() is None:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(self.args, timeout)
            time.sleep(0.01)
        return self.returncode

    def reap(self):
        if not self.reaped:
            os.waitpid(self.pid, 0)
            self.reaped = True


_WINDOWS_RUNNER = """import json, subprocess, sys
try:
    argv = json.loads(sys.stdin.buffer.readline().decode('utf-8'))
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL)
    raise SystemExit(child.wait())
except (OSError, ValueError) as exc:
    print('error: could not start command: ' + str(exc), flush=True)
    raise SystemExit(127)
"""


class _OwnedProcess:
    def __init__(self, argv, cwd):
        self.argv, self.cwd = list(argv), os.path.realpath(cwd)
        self.started, self.output, self.dropped = time.monotonic(), "", 0
        self.lock, self.job = threading.Lock(), None
        options = {"cwd": cwd, "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
                   "stderr": subprocess.STDOUT, "bufsize": 0}
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
            # Gate the actual target until the private job contains this
            # isolated supervisor. A target cannot create an uncontained child
            # in the time between CreateProcess and AssignProcessToJobObject.
            options["stdin"] = subprocess.PIPE
            command = [sys.executable, "-I", "-S", "-u", "-c", _WINDOWS_RUNNER]
        else:
            options["start_new_session"] = True
            command = argv
        launcher = subprocess.Popen if os.name == "nt" else _OwnedPosixProcess
        self.process = launcher(command, **options)
        try:
            self.job = _WindowsJob(self.process)
            if os.name == "nt":
                self.process.stdin.write((json.dumps(argv) + "\n").encode("utf-8"))
                self.process.stdin.close()
        except BaseException:
            if self.job:
                self.job.terminate()
                self.job.close()
            self.process.terminate()
            self.process.wait(timeout=2)
            if self.process.stdin is not None:
                self.process.stdin.close()
            self.process.stdout.close()
            raise
        self.reader = threading.Thread(target=self._read_output, name="reach-owned-output", daemon=True)
        self.reader.start()

    def _read_output(self):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while True:
                chunk = self.process.stdout.read(4096)
                if not chunk:
                    break
                self._append(decoder.decode(chunk))
            self._append(decoder.decode(b"", final=True))
        except (OSError, ValueError):
            pass
        finally:
            self.process.stdout.close()

    def _append(self, text):
        with self.lock:
            self.output += text
            excess = max(0, len(self.output) - PROCESS_BUFFER)
            if excess:
                self.output = self.output[excess:]
                self.dropped += excess

    def status(self, handle):
        with self.lock:
            output_size, dropped = len(self.output), self.dropped
        return {"handle": handle, "running": self.process.poll() is None,
                "exit_code": self.process.returncode, "elapsed_seconds": round(time.monotonic() - self.started, 3),
                "output_characters": output_size, "discarded_characters": dropped}

    def stop(self):
        if os.name == "nt":
            self.job.terminate()
        elif not self.process.reaped:
            # WNOWAIT retains even an exited leader, so this PGID cannot be
            # reused for an unrelated process before our final waitpid.
            if os.getpgid(self.process.pid) != self.process.pid:
                raise RuntimeError("owned process group identity changed")
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                self.job.terminate()
            else:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.process.wait(timeout=2)
        if os.name != "nt" and not self.process.reaped:
            # The command may have exited before its descendants. Its retained
            # leader still proves that this exact group belongs to this session.
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.reap()
        self.reader.join(timeout=1)
        if self.job:
            self.job.close()


def _cwd(workpath, args):
    cwd = resolve_path(workpath, args.get("cwd", ""), root=True)
    if not os.path.isdir(cwd):
        raise ValueError("cwd must be an existing directory within the workpath")
    return cwd


def _processes(ctx):
    return ctx.setdefault("processes", {})


def _owned(workpath, args, ctx):
    handle = args.get("handle")
    item = _processes(ctx).get(handle)
    if not isinstance(handle, str) or not isinstance(item, _OwnedProcess):
        raise ValueError("unknown owned process handle; use process_list (arbitrary PIDs are not accepted)")
    base = os.path.realpath(workpath)
    if os.path.commonpath([base, item.cwd]) != base:
        raise ValueError("process belongs to a different workpath")
    return handle, item


def tool_run_command(workpath, args, ctx):
    argv, cwd = _argv(args), _cwd(workpath, args)
    timeout = args.get("timeout", 60)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 180:
        raise ValueError("timeout must be greater than 0 and at most 180 seconds")
    if not _approved(ctx, "run_command", "%s (cwd=%s, timeout=%ss)" % (_review_argv(argv), args.get("cwd") or ".", timeout)):
        return _denied("run_command")
    item = _OwnedProcess(argv, cwd)
    try:
        try:
            item.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            item.stop()
            return "error: command timed out after %ss; owned process tree stopped" % timeout
        # Do not wait on descendant-held stdout before stopping the owned
        # tree: a completed command could otherwise leave late side effects.
        item.stop()
        with item.lock:
            output, dropped = item.output, item.dropped
        prefix = "exit code %s\n" % item.process.returncode
        if dropped:
            prefix += "[retained last %d characters; discarded %d]\n" % (PROCESS_BUFFER, dropped)
        return safe_text(prefix + (output.strip() or "(no output)"))
    finally:
        item.stop()


def tool_process_start(workpath, args, ctx):
    argv, cwd = _argv(args), _cwd(workpath, args)
    processes = _processes(ctx)
    for item in processes.values():
        if item.process.poll() is not None:
            item.stop()
    if sum(item.process.poll() is None for item in processes.values()) >= MAX_PROCESSES:
        raise ValueError("eight owned processes are already running; stop one first")
    if not _approved(ctx, "process_start", "%s (cwd=%s; stdin disabled)" % (_review_argv(argv), args.get("cwd") or ".")):
        return _denied("process_start")
    handle = "proc-" + uuid.uuid4().hex[:12]
    item = _OwnedProcess(argv, cwd)
    processes[handle] = item
    # Keep completed receipts bounded as well as live process count.
    for old in list(processes):
        if len(processes) <= 32:
            break
        if old != handle and processes[old].process.poll() is not None:
            processes.pop(old).stop()
    return json.dumps(item.status(handle), sort_keys=True)


def tool_process_list(workpath, args, ctx):
    base = os.path.realpath(workpath)
    return json.dumps([item.status(handle) for handle, item in _processes(ctx).items()
                       if os.path.commonpath([base, item.cwd]) == base], sort_keys=True)


def tool_process_poll(workpath, args, ctx):
    handle, item = _owned(workpath, args, ctx)
    wait = args.get("wait_seconds", 0)
    if isinstance(wait, bool) or not isinstance(wait, (int, float)) or not 0 <= wait <= 2:
        raise ValueError("wait_seconds must be between 0 and 2")
    if wait:
        try:
            item.process.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            pass
    return json.dumps(item.status(handle), sort_keys=True)


def tool_process_output(workpath, args, ctx):
    handle, item = _owned(workpath, args, ctx)
    with item.lock:
        output, dropped = item.output, item.dropped
    return safe_text("%s: retained %d characters, discarded %d\n%s" % (handle, len(output), dropped, output or "(no output yet)"))


def tool_process_stop(workpath, args, ctx):
    handle, item = _owned(workpath, args, ctx)
    if not _approved(ctx, "process_stop", "stop owned process %s" % handle):
        return _denied("process_stop")
    item.stop()
    return "stopped owned process %s (exit %s)" % (handle, item.process.returncode)


def cleanup_owned_processes(workpath, ctx):
    """Session cleanup only: never inspect or signal unrelated OS processes."""
    errors = []
    for handle, item in list(_processes(ctx).items()):
        # /workpath can change during a session. The private registry remains
        # the ownership proof; exit must clean its old-workpath children too.
        if not isinstance(item, _OwnedProcess):
            errors.append(safe_text("%s: invalid owned-process record" % handle, 300))
            continue
        try:
            item.stop()
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            errors.append(safe_text("%s: %s" % (handle, exc), 300))
        finally:
            ctx["processes"].pop(handle, None)
    return errors


def _revision(value, default="HEAD"):
    value = value or default
    if not isinstance(value, str) or value.startswith("-") or any(ord(c) < 32 for c in value):
        raise ValueError("revision must be a Git revision, without options or control characters")
    return value


def _git(workpath, argv, timeout=15):
    # No pager, filters, external diff, hooks or index refresh side effects.
    command = ["git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", *argv]
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
    try:
        done = subprocess.run(command, cwd=workpath, env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, errors="replace", timeout=timeout)
    except FileNotFoundError:
        return "error: Git is not installed or is not on PATH"
    except subprocess.TimeoutExpired:
        return "error: Git inspection timed out after %ss" % timeout
    if done.returncode:
        return safe_text("error: Git inspection failed (exit %d): %s" % (done.returncode, done.stderr.strip()))
    return safe_text(done.stdout.strip() or "(no changes/output)")


def _git_path(workpath, args):
    path = args.get("path", "")
    if not path:
        return []
    resolve_path(workpath, path, root=True)
    return [path]


def tool_git_status(workpath, args, ctx):
    return _git(workpath, ["status", "--short", "--branch", "--untracked-files=normal", "--", *_git_path(workpath, args)])


def tool_git_diff(workpath, args, ctx):
    argv = ["diff", "--no-ext-diff", "--no-textconv"]
    if args.get("staged"):
        argv.append("--cached")
    if args.get("revision"):
        argv.append(_revision(args["revision"]))
    return _git(workpath, argv + ["--", *_git_path(workpath, args)])


def tool_git_log(workpath, args, ctx):
    count = args.get("count", 10)
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 50:
        raise ValueError("count must be between 1 and 50")
    return _git(workpath, ["log", "--format=%h %ad %s", "--date=short", "-n", str(count),
                           _revision(args.get("revision")), "--", *_git_path(workpath, args)])


def tool_git_show(workpath, args, ctx):
    revision = _revision(args.get("revision"))
    path = args.get("path")
    if path:
        resolve_path(workpath, path)
        return _git(workpath, ["show", "--no-ext-diff", "--no-textconv", revision + ":" + path.replace("\\", "/")])
    return _git(workpath, ["show", "--no-ext-diff", "--no-textconv", "--format=short", revision, "--"])


def tool_git_branches(workpath, args, ctx):
    return _git(workpath, ["branch", "--list", "--all", "--format=%(refname:short) %(objectname:short) %(subject)"])


def tool_git_blame(workpath, args, ctx):
    path = args.get("path")
    _file(workpath, {"path": path})
    start, end = args.get("start_line", 1), args.get("end_line", 200)
    if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int) or start < 1 or end < start or end - start >= 500:
        raise ValueError("line range must contain 1 to 500 lines, starting at line 1 or later")
    return _git(workpath, ["blame", "--no-progress", "-L", "%d,%d" % (start, end), _revision(args.get("revision")), "--", path])


_S = {"type": "string"}
_B = {"type": "boolean"}
_I = {"type": "integer"}
_ARGV = {"type": "array", "items": _S, "minItems": 1, "maxItems": 128}


def _entry(run, category, approval, help_text, example, properties, required):
    return {"run": run, "category": category, "approval": approval, "help": help_text,
            "example": dict(action=run.__name__[5:], **example), "parameters": (properties, required)}


EXTRA_TOOLS = {
    "file_info": _entry(tool_file_info, "files", False, "Inspect file/directory type, byte size and modification time without reading contents.", {"path": "src"}, {"path": _S}, ["path"]),
    "batch_read": _entry(tool_batch_read, "files", False, "Read 1–20 workspace text files in one bounded result; credential values are redacted.", {"paths": ["README.md", "package.json"]}, {"paths": {"type": "array", "items": _S, "minItems": 1, "maxItems": 20}}, ["paths"]),
    "read_json": _entry(tool_read_json, "files", False, "Parse JSON and optionally select an RFC 6901 pointer such as /scripts/test.", {"path": "package.json", "pointer": "/scripts"}, {"path": _S, "pointer": _S}, ["path"]),
    "write_file": _entry(tool_write_file, "files", True, "Create a UTF-8 file; overwrite requires overwrite=true. Optional expected_sha256 prevents stale writes.", {"path": "note.txt", "content": "Hello\n"}, {"path": _S, "content": _S, "overwrite": _B, "expected_sha256": _S}, ["path", "content"]),
    "write_json": _entry(tool_write_json, "files", True, "Create/replace formatted JSON using data; existing files require overwrite=true.", {"path": "settings.json", "data": {"enabled": True}}, {"path": _S, "data": {}, "overwrite": _B, "expected_sha256": _S}, ["path", "data"]),
    "append_file": _entry(tool_append_file, "files", True, "Append UTF-8 text to an existing file after approval.", {"path": "note.txt", "content": "Another line\n"}, {"path": _S, "content": _S}, ["path", "content"]),
    "replace_all": _entry(tool_replace_all, "files", True, "Replace exact text occurrences only when expected_count matches, preventing unintended broad edits.", {"path": "note.txt", "search": "old", "replace": "new", "expected_count": 2}, {"path": _S, "search": _S, "replace": _S, "expected_count": _I}, ["path", "search", "replace", "expected_count"]),
    "mkdir": _entry(tool_mkdir, "files", True, "Create a directory and missing parents within the workpath.", {"path": "src/new"}, {"path": _S}, ["path"]),
    "copy": _entry(tool_copy, "files", True, "Copy a regular file to a new path; never overwrite an existing destination.", {"source": "note.txt", "destination": "note-copy.txt"}, {"source": _S, "destination": _S}, ["source", "destination"]),
    "move": _entry(tool_move, "files", True, "Rename/move a regular file within the workpath to a new destination.", {"source": "old.txt", "destination": "new.txt"}, {"source": _S, "destination": _S}, ["source", "destination"]),
    "remove": _entry(tool_remove, "files", True, "Remove one file or an empty directory after approval; recursive removal is unsupported.", {"path": "unused.txt"}, {"path": _S}, ["path"]),
    "hash_file": _entry(tool_hash_file, "files", False, "Calculate a file's SHA-256, useful for verification and conditional writes.", {"path": "note.txt"}, {"path": _S}, ["path"]),
    "compare_files": _entry(tool_compare_files, "files", False, "Compare two workspace files; return bounded unified text diff or binary equality.", {"left": "old.txt", "right": "new.txt"}, {"left": _S, "right": _S, "binary": _B}, ["left", "right"]),
    "git_status": _entry(tool_git_status, "git", False, "Inspect branch and changed/untracked files without changing the index.", {}, {"path": _S}, []),
    "git_diff": _entry(tool_git_diff, "git", False, "Inspect unstaged/staged changes or a revision comparison; optional workspace path scope.", {"staged": False}, {"path": _S, "staged": _B, "revision": _S}, []),
    "git_log": _entry(tool_git_log, "git", False, "Inspect up to 50 recent commits, optionally for a path/revision.", {"count": 10}, {"path": _S, "count": _I, "revision": _S}, []),
    "git_show": _entry(tool_git_show, "git", False, "Read a commit patch or the contents of a workspace-relative file at a revision.", {"revision": "HEAD", "path": "README.md"}, {"revision": _S, "path": _S}, []),
    "git_branches": _entry(tool_git_branches, "git", False, "List local and remote-tracking branches without fetching or checking out.", {}, {}, []),
    "git_blame": _entry(tool_git_blame, "git", False, "Inspect commit ownership for a bounded range of lines in a tracked file.", {"path": "src/main.py", "start_line": 1, "end_line": 20}, {"path": _S, "revision": _S, "start_line": _I, "end_line": _I}, ["path"]),
    "run_command": _entry(tool_run_command, "execution", True, "Run a structured argv command for tests/builds without shell interpolation; bounded timeout, output and owned-tree cancellation.", {"argv": ["python", "-m", "unittest"], "timeout": 60}, {"argv": _ARGV, "cwd": _S, "timeout": {"type": "number", "exclusiveMinimum": 0, "maximum": 180}}, ["argv"]),
    "process_start": _entry(tool_process_start, "processes", True, "Start an approved background command with an owned handle, bounded output and disabled stdin (maximum eight running).", {"argv": ["python", "-m", "http.server", "8000"]}, {"argv": _ARGV, "cwd": _S}, ["argv"]),
    "process_list": _entry(tool_process_list, "processes", False, "List only processes started by this CLI session in this workpath; never enumerate unrelated OS processes.", {}, {}, []),
    "process_poll": _entry(tool_process_poll, "processes", False, "Read an owned process exit/running status; optionally wait at most two seconds.", {"handle": "proc-..."}, {"handle": _S, "wait_seconds": {"type": "number", "minimum": 0, "maximum": 2}}, ["handle"]),
    "process_output": _entry(tool_process_output, "processes", False, "Read bounded retained stdout/stderr of one owned process, with terminal controls and common credentials redacted.", {"handle": "proc-..."}, {"handle": _S}, ["handle"]),
    "process_stop": _entry(tool_process_stop, "processes", True, "Stop an approved process tree started by this session using its handle; arbitrary PIDs are not accepted.", {"handle": "proc-..."}, {"handle": _S}, ["handle"]),
}
