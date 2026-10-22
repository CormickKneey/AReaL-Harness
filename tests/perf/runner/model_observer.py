"""Transparent local HTTP observer; never records prompts, outputs or credentials."""

from __future__ import annotations

import hashlib
import http.client
import json
import queue
import re
import threading
import time
import uuid
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
}
MAX_BODY = 32 * 1024 * 1024


def union_ms(intervals):
    end, total = None, 0.0
    for start, stop in sorted(intervals):
        if stop < start:
            continue
        total += max(0.0, stop - max(start, end if end is not None else start))
        end = max(stop, end if end is not None else stop)
    return total


class UsageReader:
    def __init__(self, sse):
        self.sse = sse
        self.buffer = b""
        self.usage = {}
        self.anthropic_input_usage = {}
        self.terminal = False
        self.failed = False
        self.overflow = False
        self.parse_errors = 0
        self.response_id = None
        self.response_id_conflict = False
        self.receipt_complete = False
        self.receipt_usage = {}
        self.finished = False
        self.data_lines = []
        self.data_bytes = 0
        self.eof_receipt_recovered = False
        self.finalized = False

    def event(self, value):
        if not isinstance(value, dict):
            return
        kind = value.get("type")
        source = value.get("response") or value.get("message") or value
        response_id = source.get("id") if isinstance(source, dict) else None
        if isinstance(response_id, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,256}", response_id):
            if self.response_id and self.response_id != response_id:
                self.response_id_conflict = True
            else:
                self.response_id = response_id
        if kind in {"response.failed", "response.incomplete", "error"}:
            self.failed = True
        if any(
            choice.get("finish_reason") in {"stop", "tool_calls"}
            for choice in value.get("choices", [])
            if isinstance(choice, dict)
        ):
            self.terminal = True
        if any(
            choice.get("finish_reason") in {"length", "content_filter"}
            for choice in value.get("choices", [])
            if isinstance(choice, dict)
        ):
            self.failed = True
            self.finished = True
        if kind in {"response.completed", "message_stop"}:
            self.terminal = True
        response_end = kind in {"response.completed", "response.failed", "response.incomplete"}
        self.finished |= response_end or kind == "message_stop"
        usage = source.get("usage") if isinstance(source, dict) else None
        if not isinstance(usage, dict):
            if kind == "message_stop":
                self._receipt()
            return
        if "prompt_tokens" in usage:
            usage = {
                "input_tokens": usage["prompt_tokens"],
                "output_tokens": usage.get("completion_tokens"),
                "cached_input_tokens": usage.get("prompt_tokens_details", {}).get("cached_tokens"),
            }
        else:
            usage = dict(usage)
            if (
                kind in {"message_start", "message_delta"}
                or "cache_read_input_tokens" in usage
                or "cache_creation_input_tokens" in usage
            ):
                # Anthropic deltas may omit or null an unchanged counter. Keep
                # each component before calculating the total input usage.
                for key in (
                    "input_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                ):
                    number = usage.get(key)
                    if number is None:
                        continue
                    if not isinstance(number, int) or isinstance(number, bool) or number < 0:
                        raise ValueError("invalid Anthropic usage counter")
                    self.anthropic_input_usage[key] = number
                if "input_tokens" in self.anthropic_input_usage:
                    usage["input_tokens"] = sum(self.anthropic_input_usage.values())
                else:
                    usage.pop("input_tokens", None)
                usage["cached_input_tokens"] = self.anthropic_input_usage.get(
                    "cache_read_input_tokens"
                )
            elif isinstance(usage.get("input_tokens_details"), dict):
                usage["cached_input_tokens"] = usage["input_tokens_details"].get("cached_tokens")
        for key in ("input_tokens", "output_tokens", "cached_input_tokens"):
            number = usage.get(key)
            if isinstance(number, int) and not isinstance(number, bool) and number >= 0:
                self.usage[key] = number
        # 计量回执与任务成败独立；失败终态也可能报告完整消费。
        if (
            response_end
            or not self.sse
            or ("choices" in value and (self.terminal or self.finished))
        ):
            if all(
                type(usage.get(key)) is int and usage[key] >= 0
                for key in ("input_tokens", "output_tokens")
            ):
                self._receipt()

    def _receipt(self):
        if all(type(self.usage.get(key)) is int for key in ("input_tokens", "output_tokens")):
            if self.usage.get("cached_input_tokens", 0) > self.usage["input_tokens"]:
                self.response_id_conflict = True
                self.receipt_complete = False
                raise ValueError("cached input exceeds total input")
            if self.receipt_complete and self.receipt_usage != self.usage:
                self.response_id_conflict = True
            self.receipt_usage = dict(self.usage)
            self.receipt_complete = True

    def _data(self, eof=False):
        if not self.data_lines:
            return
        payload = b"\n".join(self.data_lines)
        if payload.strip() == b"[DONE]":
            self.data_lines, self.data_bytes = [], 0
            return
        try:
            value = json.loads(payload)
        except (ValueError, UnicodeError, RecursionError):
            self.parse_errors += 1
            self.data_lines, self.data_bytes = [], 0
            return
        self.data_lines, self.data_bytes = [], 0
        previous_terminal = self.terminal
        previous_receipt = self.receipt_complete
        try:
            self.event(value)
        except (ValueError, TypeError, AttributeError, RecursionError):
            self.parse_errors += 1
        finally:
            if eof:
                # EOF只允许恢复完整JSON中的计量，不冒充已分帧送达的SSE终态。
                self.terminal = previous_terminal
                self.eof_receipt_recovered |= self.receipt_complete and not previous_receipt

    def _line(self, line):
        if not line:
            self._data()
        elif line.startswith(b"data:"):
            payload = line[5:]
            if payload.startswith(b" "):
                payload = payload[1:]
            self.data_bytes += len(payload)
            if self.data_bytes > MAX_BODY:
                self.overflow = True
                self.data_lines.clear()
                return
            self.data_lines.append(payload)

    def feed(self, chunk, final=False):
        if self.overflow or self.finalized:
            return
        self.finalized = final
        if self.sse:
            data, start = self.buffer + chunk, 0
            for separator in re.finditer(rb"\r\n|\r|\n", data):
                if separator.group() == b"\r" and separator.end() == len(data) and not final:
                    break
                line = data[start : separator.start()]
                if len(line) > MAX_BODY:
                    self.overflow = True
                    break
                self._line(line)
                start = separator.end()
                if self.overflow:
                    break
            self.buffer = data[start:]
            if len(self.buffer) > MAX_BODY:
                self.overflow = True
            if self.overflow:
                self.buffer = b""
                return
            if final:
                if self.buffer:
                    self._line(self.buffer)
                    self.buffer = b""
                self._data(eof=True)
        else:
            self.buffer += chunk
            if len(self.buffer) > MAX_BODY:
                self.buffer = b""
                self.overflow = True
                return
        if not self.sse and final:
            try:
                self.event(json.loads(self.buffer))
            except (ValueError, UnicodeError, TypeError, AttributeError, RecursionError):
                self.parse_errors += 1
            self.buffer = b""


class MetadataWriter:
    """磁盘故障和慢写只能降低观测完整性，不能阻塞模型转发。"""

    def __init__(self, capacity=256):
        self.queue = queue.Queue(maxsize=capacity)
        self.stopping = threading.Event()
        self.state_lock = threading.Lock()
        self.errors = 0
        self.dropped = 0
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def submit(self, path, value):
        with self.state_lock:
            try:
                if self.stopping.is_set():
                    raise queue.Full
                self.queue.put_nowait((path, value))
            except queue.Full:
                self.dropped += 1

    def _run(self):
        while not self.stopping.is_set() or not self.queue.empty():
            try:
                path, value = self.queue.get(timeout=0.05)
            except queue.Empty:
                continue
            try:
                with path.open("a") as handle:
                    handle.write(json.dumps(value, sort_keys=True) + "\n")
            except (OSError, ValueError, TypeError):
                with self.state_lock:
                    self.errors += 1
            finally:
                self.queue.task_done()

    def close(self):
        with self.state_lock:
            self.stopping.set()
        self.thread.join(timeout=0.25)
        with self.state_lock:
            return {
                "errors": self.errors,
                "dropped_records": self.dropped,
                "pending_records": self.queue.unfinished_tasks,
            }


def usage_known(item):
    if "usage_receipt_complete" in item:
        return (
            item["usage_receipt_complete"] is True
            and not item.get("response_id_conflict")
            and all(
                type(item.get("usage", {}).get(key)) is int and item["usage"][key] >= 0
                for key in ("input_tokens", "output_tokens")
            )
        )
    # 旧证据没有回执来源标记，仍采用原来的保守覆盖口径。
    return (
        all(key in item["usage"] for key in ("input_tokens", "output_tokens"))
        and (item["completed_transport"] or item.get("terminal_delivered_ms") is not None)
        and item["status"] is not None
        and item["status"] < 400
        and not item.get("semantic_failure_seen")
        and not item.get("usage_parser_overflow")
        and not item.get("usage_parse_errors")
        and (not item.get("streaming") or item.get("semantic_terminal_seen"))
    )


def unknown_reason(item):
    if usage_known(item):
        return None
    if item.get("usage_parser_overflow"):
        return "parser_overflow"
    if item.get("response_id_conflict"):
        return "conflicting_receipts"
    if item.get("status") is not None and item["status"] >= 400:
        return "http_error_without_usage"
    if item.get("error_stage") == "downstream_write":
        return "downstream_disconnect"
    if item.get("error_kind"):
        return "transport_error"
    if item.get("usage_parse_errors"):
        return "parser_error"
    if item.get("snapshot_inflight"):
        return "inflight_at_close"
    if item.get("semantic_terminal_seen"):
        return "terminal_without_usage"
    return "missing_terminal_receipt"


class ModelObserver:
    def __init__(self, upstream: str, output: Path, origin: float):
        parsed = urlsplit(upstream)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.username
            or parsed.password
            or parsed.query
        ):
            raise ValueError("observer requires a credential-free HTTP gateway URL")
        self.upstream, self.output, self.origin = parsed, output, origin
        self.lock = threading.Lock()
        self.records = []
        self.active = 0
        self.active_records = {}
        self.sequence = 0
        self.capture_id = uuid.uuid4().hex
        self.writer = MetadataWriter()
        self.lifecycle_output = output.with_name(output.stem + ".lifecycle.jsonl")
        self.drained = threading.Event()
        self.drained.set()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                start = time.monotonic()
                with owner.lock:
                    owner.active += 1
                    owner.sequence += 1
                    sequence = owner.sequence
                    owner.drained.clear()
                record = {
                    "request_number": sequence,
                    "observation_id": f"{owner.capture_id}:{sequence}",
                    "start_ms": (start - owner.origin) * 1000,
                    "path": urlsplit(self.path).path,
                    "status": None,
                    "first_byte_ms": None,
                    "completed_transport": False,
                    "usage": {},
                }
                connection = None
                response = None
                response_started = False
                reader = None
                error_stage = "request_read"
                checkpointed_receipt = False
                checkpointed_identity = False
                checkpointed_conflict = False

                def checkpoint(kind):
                    snapshot = dict(record)
                    with owner.lock:
                        owner.active_records[sequence] = snapshot
                    owner.writer.submit(owner.lifecycle_output, {"event": kind, **snapshot})

                def observe_reader():
                    nonlocal checkpointed_receipt, checkpointed_identity, checkpointed_conflict
                    if reader is None:
                        return
                    record.update(
                        streaming=reader.sse,
                        semantic_failure_seen=reader.failed,
                        semantic_terminal_seen=reader.terminal,
                        provider_response_finished=reader.finished,
                        response_id=reader.response_id,
                        response_id_conflict=reader.response_id_conflict,
                        usage=dict(
                            {}
                            if reader.response_id_conflict
                            else reader.receipt_usage
                            if reader.receipt_complete
                            else reader.usage
                        ),
                        usage_receipt_complete=(
                            reader.receipt_complete and not reader.response_id_conflict
                        ),
                        usage_parser_overflow=reader.overflow,
                        usage_parse_errors=reader.parse_errors,
                        eof_receipt_recovered=reader.eof_receipt_recovered,
                    )
                    if reader.terminal and "terminal_observed_ms" not in record:
                        record["terminal_observed_ms"] = (time.monotonic() - owner.origin) * 1000
                    if reader.response_id_conflict and not checkpointed_conflict:
                        checkpointed_conflict = True
                        checkpoint("conflicting_receipts")
                    elif record["usage_receipt_complete"] and not checkpointed_receipt:
                        checkpointed_receipt = True
                        checkpoint("usage_receipt")
                    elif reader.response_id and not checkpointed_identity:
                        checkpointed_identity = True
                        checkpoint("response_identity")

                checkpoint("request_started")
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
                        self.send_error(413)
                        return
                    body = self.rfile.read(length)
                    record["request_sha256"] = hashlib.sha256(body).hexdigest()
                    try:
                        request = json.loads(body)
                        record["model"] = request.get("model")
                        record["parameters"] = {
                            key: request[key]
                            for key in (
                                "reasoning",
                                "reasoning_effort",
                                "thinking",
                                "output_config",
                                "max_tokens",
                                "max_output_tokens",
                                "temperature",
                                "stream",
                            )
                            if key in request
                        }
                    except (ValueError, AttributeError):
                        pass
                    kind = (
                        http.client.HTTPSConnection
                        if parsed.scheme == "https"
                        else http.client.HTTPConnection
                    )
                    connection = kind(parsed.hostname, parsed.port, timeout=240)
                    headers = {
                        key: value
                        for key, value in self.headers.items()
                        if key.lower() not in HOP_HEADERS
                    }
                    error_stage = "upstream_request"
                    connection.request("POST", parsed.path.rstrip("/") + self.path, body, headers)
                    response = connection.getresponse()
                    record["status"] = response.status
                    request_id = response.getheader("x-request-id")
                    if request_id and re.fullmatch(r"[A-Za-z0-9_.:-]{1,256}", request_id):
                        record["provider_request_id"] = request_id
                    record["headers_ms"] = (time.monotonic() - start) * 1000
                    checkpoint("response_headers")
                    reader = UsageReader(
                        "text/event-stream" in response.getheader("Content-Type", "")
                    )
                    error_stage = "downstream_write"
                    self.send_response(response.status)
                    for key, value in response.getheaders():
                        if key.lower() not in HOP_HEADERS:
                            self.send_header(key, value)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    response_started = True
                    error_stage = "upstream_read"
                    while chunk := response.read1(16384):
                        if record["first_byte_ms"] is None:
                            record["first_byte_ms"] = (time.monotonic() - start) * 1000
                        reader.feed(chunk)
                        observe_reader()
                        error_stage = "downstream_write"
                        self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                        self.wfile.flush()
                        if reader.terminal and "terminal_delivered_ms" not in record:
                            record["terminal_delivered_ms"] = (
                                time.monotonic() - owner.origin
                            ) * 1000
                        error_stage = "upstream_read"
                    reader.feed(b"", final=True)
                    observe_reader()
                    error_stage = "downstream_write"
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                    record["completed_transport"] = True
                except Exception as error:
                    record["error_kind"] = type(error).__name__
                    record["error_stage"] = error_stage
                    if isinstance(error, http.client.IncompleteRead) and error.partial and reader:
                        reader.feed(error.partial)
                    self.close_connection = True
                    if not response_started:
                        try:
                            self.send_error(502, "model observer upstream connection failed")
                        except OSError:
                            pass
                finally:
                    if response:
                        response.close()
                    if connection:
                        connection.close()
                    if reader:
                        # 只解析已经接收的尾字节；取消后不再读取或延长上游生成。
                        reader.feed(b"", final=True)
                        observe_reader()
                    record["end_ms"] = (time.monotonic() - owner.origin) * 1000
                    record["duration_ms"] = record["end_ms"] - record["start_ms"]
                    record["usage_unknown_reason"] = unknown_reason(record)
                    # 非阻塞入队先于drained回执，避免关闭线程抢先停止写入器。
                    owner.writer.submit(owner.output, dict(record))
                    owner.writer.submit(
                        owner.lifecycle_output, {"event": "request_finished", **record}
                    )
                    with owner.lock:
                        owner.active -= 1
                        if owner.active == 0:
                            owner.drained.set()
                        owner.records.append(record)
                        owner.active_records.pop(sequence, None)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)
        self.drained.wait(timeout=2)
        with self.lock:
            records = list(self.records)
            active = self.active
            now = (time.monotonic() - self.origin) * 1000 if hasattr(self, "origin") else 0
            inflight = [
                {**item, "end_ms": now, "snapshot_inflight": True}
                for item in getattr(self, "active_records", {}).values()
            ]
        observations = records + inflight
        durations = [
            [
                item["start_ms"],
                item.get("terminal_delivered_ms", item.get("terminal_observed_ms", item["end_ms"])),
            ]
            for item in observations
        ]
        complete_usage = [item for item in observations if usage_known(item)]
        reasons = Counter(unknown_reason(item) for item in observations if not usage_known(item))
        reasons["inflight_without_checkpoint"] += max(0, active - len(inflight))
        hashes = [item.get("request_sha256") for item in records if item.get("request_sha256")]
        writer = getattr(self, "writer", None)
        persistence = (
            writer.close() if writer else {"errors": 0, "dropped_records": 0, "pending_records": 0}
        )
        return {
            "request_count": len(records) + active,
            "completed_observations": len(records),
            "inflight_at_agent_exit": active,
            "observed_request_union_ms": union_ms(durations),
            "http_errors": sum(item["status"] is None or item["status"] >= 400 for item in records),
            "incomplete_transports": sum(not item["completed_transport"] for item in records),
            "client_disconnects_after_terminal": sum(
                not item["completed_transport"] and item.get("terminal_delivered_ms") is not None
                for item in records
            ),
            "identical_request_repeats": len(hashes) - len(set(hashes)),
            "usage_requests": len(complete_usage),
            "usage_receipt_version": 2,
            "usage_unknown_by_reason": {key: value for key, value in reasons.items() if value},
            "inflight_with_usage_receipt": sum(usage_known(item) for item in inflight),
            "metadata_persistence": persistence,
            "usage_field_coverage": {
                key: sum(key in item["usage"] for item in observations)
                for key in ("input_tokens", "output_tokens", "cached_input_tokens")
            },
            "usage_coverage": len(complete_usage) / (len(records) + active)
            if records or active
            else None,
            "observed_usage": {
                key: sum(item["usage"][key] for item in observations if key in item["usage"])
                if any(key in item["usage"] for item in observations)
                else None
                for key in ("input_tokens", "output_tokens", "cached_input_tokens")
            },
            "timing_scope": "agent-container loopback observer to gateway; includes conversion, network and upstream latency",
            "retry_semantics": "identical request repeats are observed duplicates, not confirmed automatic retries",
        }
