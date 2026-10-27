"""迁移兼容桥：固定路由、固定 Rust 命令；不实现候选业务或数据库写入。"""
import json
import os
import selectors
import signal
import subprocess
import time

ACTIONS = frozenset(("status", "preview", "adopt", "receipt", "list", "batch"))
MAX_BODY = 950_000
MAX_OUTPUT = 2 * 1024 * 1024
TIMEOUT = 10
BODY_TIMEOUT = 3


def _read_body(body, connection, size):
    previous_timeout = connection.gettimeout()
    deadline = time.monotonic() + BODY_TIMEOUT
    output = bytearray()
    try:
        while len(output) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("候选区请求体读取超时")
            connection.settimeout(remaining)
            # read1 至多做一次底层读取，每个片段都重新计算总预算，拒绝慢速滴流。
            try:
                chunk = body.read1(min(65536, size - len(output)))
            except OSError:
                # BufferedReader 在超时后也可能报通用 OSError，而非 socket.timeout。
                if time.monotonic() >= deadline - 0.1:
                    raise TimeoutError("候选区请求体读取超时") from None
                raise
            if not chunk:
                raise ValueError("候选区请求体不完整")
            output.extend(chunk)
        return output
    finally:
        connection.settimeout(previous_timeout)


def _run(executable, db_path, request):
    encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
    if len(encoded) > 1024 * 1024:
        raise ValueError("候选区请求超过执行上限")
    environment = os.environ.copy()
    # 只能使用现有 Store 的数据库，忽略继承的数据库环境覆盖。
    environment["GAPAW_WORKBENCH_DB"] = os.path.abspath(db_path)
    process = subprocess.Popen(
        [executable, "workbench-provider"], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment,
        start_new_session=True,
    )
    poll = selectors.DefaultSelector()
    output = bytearray()
    offset = 0
    deadline = time.monotonic() + TIMEOUT
    try:
        for stream, mode in ((process.stdin, selectors.EVENT_WRITE), (process.stdout, selectors.EVENT_READ)):
            os.set_blocking(stream.fileno(), False)
            poll.register(stream, mode)
        while poll.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("候选区执行超时；请沿用原编号核对回执")
            for key, _ in poll.select(min(remaining, 0.1)):
                if key.fileobj is process.stdin:
                    try:
                        count = os.write(process.stdin.fileno(), encoded[offset:offset + 65536])
                    except BlockingIOError:
                        continue
                    offset += count
                    if offset == len(encoded):
                        poll.unregister(process.stdin)
                        process.stdin.close()
                else:
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        poll.unregister(process.stdout)
                        process.stdout.close()
                    else:
                        if len(output) + len(chunk) > MAX_OUTPUT:
                            raise ValueError("候选区执行响应超过上限")
                        output.extend(chunk)
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
        value = json.loads(output)
        if not isinstance(value, dict) or not isinstance(value.get("ok"), bool):
            raise ValueError("候选区执行响应格式无效")
        return value
    finally:
        poll.close()
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=2)
        for stream in (process.stdin, process.stdout):
            if not stream.closed:
                stream.close()


def provider_request(db_path, headers, body, connection):
    """返回 (JSON, HTTP状态)。错误不会包含凭证、子进程输出或本机路径。"""
    try:
        size = int(headers.get("Content-Length", "0"))
        if size <= 0 or size > MAX_BODY:
            return {"ok": False, "error": "候选区请求长度不正确"}, 400
        request = json.loads(_read_body(body, connection, size))
        if not isinstance(request, dict) or set(request) != {"action", "payload"}:
            return {"ok": False, "error": "候选区请求字段无效"}, 400
        if request["action"] not in ACTIONS or not isinstance(request["payload"], dict):
            return {"ok": False, "error": "此候选区操作不允许通过 HTTP 执行"}, 400
        authorization = headers.get("Authorization", "")
        if not authorization.startswith("Bearer ") or len(authorization) > 4103:
            return {"ok": False, "error": "候选区授权失败"}, 401
        executable = os.environ.get("GAPAW_WORKBENCH_EXECUTABLE", "")
        if not os.path.isabs(executable) or not os.path.isfile(executable) or not os.access(executable, os.X_OK):
            return {"ok": False, "error": "候选区执行器尚未配置"}, 503
        result = _run(executable, db_path, {**request, "authorization": authorization})
        return result, 200 if result["ok"] else (401 if result.get("error") == "候选区授权失败" else 400)
    except (ValueError, TypeError, KeyError, UnicodeError):
        return {"ok": False, "error": "候选区请求或执行响应无效"}, 400
    except (TimeoutError, subprocess.TimeoutExpired):
        return {"ok": False, "error": "候选区读取或执行超时；请沿用原编号核对回执"}, 504
    except (OSError, subprocess.SubprocessError):
        return {"ok": False, "error": "候选区执行失败；请沿用原编号核对回执"}, 503
