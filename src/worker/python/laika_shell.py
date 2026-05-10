"""Shell execution in Pyodide: bashlex AST + Python builtins (Laika).

Expects globals: laika_read_file, laika_write_file, laika_mkdir, laika_list_files,
laika_http_request, laika_delete_file,
laika_browser_get_html, laika_browser_get_markdown, laika_browser_evaluate, laika_browser_open_login (async).

bashlex: https://github.com/idank/bashlex
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Dict, List, Optional, Protocol

import bashlex


# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------

MAX_CAT_BYTES = 8 * 1024 * 1024
MAX_GREP_LINES = 50_000
MAX_SLEEP_SECONDS = 10.0
_BROWSER_WAIT = frozenset({"load", "domcontentloaded", "networkidle"})


# -----------------------------------------------------------------------------
# bashlex AST helpers
# -----------------------------------------------------------------------------


class _AstNode(Protocol):
    """bashlex nodes：属性随 kind 变化，仅占位便于类型排查。"""

    kind: str
    pos: tuple[int, int]
    parts: List[Any]


def node_kind(node: Any) -> str:
    """提取节点的语义类型名（兼容 class `node` 与旧 Node 后缀）。"""
    k = getattr(node, "kind", None)
    if k is not None and str(k):
        return str(k)
    nm = type(node).__name__
    if nm.endswith("Node"):
        return nm[:-4].lower()
    return nm.lower()


# -----------------------------------------------------------------------------
# IO & session（单例：Pyodide 内核单线程）
# -----------------------------------------------------------------------------


@dataclass
class IO:
    """单条命令的 stdin / stdout 语义。"""

    stdin_text: str = ""
    capture_stdout: bool = False
    _chunks: List[str] = field(default_factory=list, repr=False)

    def write(self, s: str = "", newline: bool = False) -> None:
        chunk = s + ("\n" if newline else "")
        if self.capture_stdout:
            self._chunks.append(chunk)
        else:
            print(chunk, end="", flush=True)

    def write_err(self, msg: str) -> None:
        print(msg, file=sys.stderr, flush=True)

    def stdout_text(self) -> str:
        return "".join(self._chunks)


@dataclass
class Session:
    cwd: str = "/"
    env: Dict[str, str] = field(
        default_factory=lambda: {
            "PWD": "/",
            "OLDPWD": "/",
            "HOME": "/",
            "USER": "laika",
            "PATH": "/bin:/usr/bin",
            "LANG": "C.UTF-8",
        }
    )
    last_exit_code: int = 0


_session: Optional[Session] = None


def get_session() -> Session:
    global _session
    if _session is None:
        _session = Session()
    return _session


async def laika_reset_shell_session() -> None:
    """由 Worker 在「重置 shell 会话」时调用；清空 cwd/env/上一退出码。"""
    global _session
    _session = Session()


# -----------------------------------------------------------------------------
# 路径：虚拟绝对路径（以 / 表示）↔ 工作区相对路径（根目录为 `.`）
# -----------------------------------------------------------------------------


def vrel(path: str) -> str:
    """将 resolve 后的虚路径转为 `laika_*` API 使用的相对路径（工作区根为 `.`）。"""
    if path in ("/", ".", ""):
        return "."
    return path.strip("/")


def join_path(cwd: str, segment: str) -> str:
    """POSIX join + 规范化 `.` / `..`；cwd 为虚路径。"""
    base: List[str] = [] if cwd in ("/", ".") else [x for x in cwd.strip("/").split("/") if x]
    for part in segment.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if base:
                base.pop()
        else:
            base.append(part)
    return "/" if not base else "/" + "/".join(base)


async def resolve_path(st: Session, path: str) -> str:
    """解析为虚绝对路径（保留前导 `/`）。"""
    if path.startswith("/"):
        return join_path("/", path)
    return join_path(st.cwd, path)


# -----------------------------------------------------------------------------
# 词法展开：$VAR、$(cmd)、$?
# -----------------------------------------------------------------------------


@dataclass
class PlainWord:
    """人造 Word 节点，用于赋值 RHS 等的展开。"""

    word: str
    parts: List[Any] = field(default_factory=list)
    pos: tuple[int, int] = field(default_factory=lambda: (0, 0))

    def __post_init__(self) -> None:
        if self.pos == (0, 0):
            self.pos = (0, len(self.word))


async def expand_word(word_node: Any, st: Session) -> str:
    parts = getattr(word_node, "parts", None)
    if not parts:
        return str(getattr(word_node, "word", ""))

    base_offset = int(word_node.pos[0])
    raw: str = str(word_node.word)
    last = 0
    chunks: List[str] = []

    for part in sorted(parts, key=lambda x: int(x.pos[0])):
        start, end = part.pos
        i0, i1 = start - base_offset, end - base_offset

        if i0 > last:
            adj = i0
            if (
                node_kind(part) == "parameter"
                and str(getattr(part, "value", "")) == "?"
                and adj > last
                and raw[adj - 1] == "$"
            ):
                adj -= 1
            chunks.append(raw[last:adj])

        chunks.append(await _expand_part(part, st))
        last = i1

    if last < len(raw):
        chunks.append(raw[last:])

    return "".join(chunks)


async def _expand_part(part: Any, st: Session) -> str:
    kind = node_kind(part)
    if kind == "parameter":
        value = getattr(part, "value", None)
        if str(value) == "?":
            return str(st.last_exit_code)
        return str(st.env.get(str(value), ""))
    if kind == "commandsubstitution":
        sub_io = IO("", capture_stdout=True)
        await run_ast(part.command, st, sub_io)
        return sub_io.stdout_text().rstrip("\n")
    return ""


async def eval_assignments(nodes: List[Any], st: Session) -> Dict[str, str]:
    """赋值节点 → 新环境副本（外层负责在 finally 恢复原 env）。"""
    new_env = dict(st.env)
    for node in nodes:
        text = str(getattr(node, "word", ""))
        if "=" not in text:
            continue
        key, rhs = text.split("=", 1)
        tmp = Session(cwd=st.cwd, env=new_env, last_exit_code=st.last_exit_code)
        new_env[key] = await expand_word(PlainWord(rhs), tmp)
    return new_env


async def expand_words(nodes: List[Any], st: Session) -> List[str]:
    return [await expand_word(n, st) for n in nodes]


# -----------------------------------------------------------------------------
# AST 执行
# -----------------------------------------------------------------------------


async def run_ast(
    node: Any,
    st: Session,
    io: IO,
    local_env: Optional[Dict[str, str]] = None,
) -> int:
    kind = node_kind(node)

    if kind == "command":
        return await _run_command(node, st, io, local_env)
    if kind == "list":
        return await _run_list(node.parts, st, io)
    if kind == "pipeline":
        return await _run_pipeline(node, st, io)
    if kind == "compound" and node.list and node_kind(node.list[0]) == "if":
        return await _run_if(node.list[0], st, io)

    io.write_err(f"unsupported: {kind}")
    st.last_exit_code = 2
    return 2


async def _run_command(
    node: Any,
    st: Session,
    io: IO,
    local_env: Optional[Dict[str, str]] = None,
) -> int:
    words: List[Any] = []
    redirects: List[Any] = []
    assignments: List[Any] = []

    try:
        for part in node.parts:
            pt = node_kind(part)
            if pt == "redirect":
                redirects.append(part)
            elif pt == "word":
                words.append(part)
            elif pt == "assignment":
                assignments.append(part)
            elif pt == "compound":
                raise ValueError("nested compound unsupported")
            else:
                raise ValueError(f"unknown part type: {pt}")
    except ValueError as exc:
        io.write_err(f"parse: {exc}")
        st.last_exit_code = 2
        return 2

    original_env = st.env
    try:
        if assignments:
            st.env = await eval_assignments(assignments, st)
        if local_env:
            st.env.update(local_env)

        stdin_text = io.stdin_text or ""
        out_path: Optional[str] = None
        out_append = False

        for rd in redirects:
            rd_type = rd.type
            target_node = getattr(rd, "output", None)
            target_path = await expand_word(target_node, st) if target_node else ""

            if rd_type == "<":
                stdin_text = await _read_file_or_empty(vrel(await resolve_path(st, target_path)))
            elif rd_type == ">":
                out_path, out_append = target_path, False
            elif rd_type == ">>":
                out_path, out_append = target_path, True

        sub_io = IO(stdin_text, io.capture_stdout or (out_path is not None))
        argv = await expand_words(words, st)

        if not argv:
            st.last_exit_code = 0
            if out_path:
                await _write_file(st, "", out_path, out_append)
            return 0

        exit_code = await dispatch(argv[0], argv, st, sub_io)
        output_text = sub_io.stdout_text()

        if out_path:
            await _write_file(st, output_text, out_path, out_append)
        elif io.capture_stdout:
            io.write(output_text)

        st.last_exit_code = exit_code
        return exit_code

    finally:
        if assignments:
            st.env = original_env


async def _run_list(parts: List[Any], st: Session, io: IO) -> int:
    acc = 0
    skip = False

    i = 0
    while i < len(parts):
        element = parts[i]
        i += 1

        if node_kind(element) == "operator":
            op = element.op
            if op == ";":
                skip = False
            elif op == "&&":
                skip = acc != 0
            elif op == "||":
                skip = acc == 0
            else:
                io.write_err(f"operator {op} unsupported")
                acc = st.last_exit_code = 2
            continue

        if not skip:
            acc = await run_ast(element, st, io)

    st.last_exit_code = acc
    return acc


async def _run_pipeline(node: Any, st: Session, io: IO) -> int:
    """管道：首段读 `io.stdin_text`，后续段读上一段 stdout。"""
    cmds = [x for x in node.parts if node_kind(x) == "command"]
    if not cmds:
        st.last_exit_code = 2
        return 2

    pipe_data = ""

    for idx, cmd in enumerate(cmds):
        is_last = idx == len(cmds) - 1
        capture = not is_last or io.capture_stdout
        stdin_in = io.stdin_text if idx == 0 else pipe_data
        sub_io = IO(stdin_in, capture)
        exit_code = await run_ast(cmd, st, sub_io)

        if is_last:
            if io.capture_stdout:
                io.write(sub_io.stdout_text())
            st.last_exit_code = exit_code
            return exit_code

        pipe_data = sub_io.stdout_text()

    st.last_exit_code = 2
    return 2


async def _run_if(node: Any, st: Session, io: IO) -> int:
    """if-then；无 else/elif。条件命令的退出码决定是否执行 then 分支。"""
    parts = node.parts

    if_idx = next((i for i, p in enumerate(parts) if getattr(p, "word", "") == "if"), -1)
    then_idx = next((i for i, p in enumerate(parts) if getattr(p, "word", "") == "then"), -1)

    if if_idx < 0 or then_idx < 0 or then_idx <= if_idx + 1:
        io.write_err("if: malformed")
        st.last_exit_code = 2
        return 2

    cond_node = parts[if_idx + 1]
    body_node = parts[then_idx + 1]

    # 与 bash 一致：条件命令的 stdout 应可见，除非整条被包在命令替换里（由 io.capture_stdout 表达）
    cond_io = IO(io.stdin_text, io.capture_stdout)
    cond_exit = await _run_list(cond_node.parts, st, cond_io)

    if cond_exit != 0:
        st.last_exit_code = 0
        return 0

    body_exit = await _run_list(body_node.parts, st, io)
    st.last_exit_code = body_exit
    return body_exit


# -----------------------------------------------------------------------------
# 命令注册表
# -----------------------------------------------------------------------------

CommandHandler = Callable[[List[str], Session, IO], Coroutine[Any, Any, int]]
_COMMAND_REGISTRY: Dict[str, CommandHandler] = {}


def register_command(name: str) -> Callable[[CommandHandler], CommandHandler]:
    def decorator(fn: CommandHandler) -> CommandHandler:
        _COMMAND_REGISTRY[name] = fn
        return fn

    return decorator


async def dispatch(cmd: str, argv: List[str], st: Session, io: IO) -> int:
    handler = _COMMAND_REGISTRY.get(cmd)
    if handler:
        return await handler(argv, st, io)
    return 127


# -----------------------------------------------------------------------------
# 文件与列表辅助
# -----------------------------------------------------------------------------


async def _read_file_or_empty(rel: str) -> str:
    try:
        content = await laika_read_file(rel)
        return content[:MAX_CAT_BYTES]
    except Exception:
        return ""


async def _write_file(st: Session, text: str, path: str, append: bool) -> None:
    rel = vrel(await resolve_path(st, path))
    old = ""
    if append:
        try:
            old = await laika_read_file(rel)
        except Exception:
            pass
    await laika_write_file(rel, old + text if append else text)


async def _list_files(rel: str) -> List[Dict[str, Any]]:
    xs = await laika_list_files(rel)
    return xs.to_py() if hasattr(xs, "to_py") else list(xs)


async def _is_directory(st: Session, path: str) -> bool:
    """能列出子项则视为目录（与旧实现及 MemFS 行为一致）。"""
    try:
        await _list_files(vrel(await resolve_path(st, path)))
        return True
    except Exception:
        return False


def sh_quote(value: str) -> str:
    if re.match(r"^[\w@%+=:,./-]+$", value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


# -----------------------------------------------------------------------------
# 内建命令
# -----------------------------------------------------------------------------


@register_command("help")
async def cmd_help(argv: List[str], st: Session, io: IO) -> int:
    io.write(
        "Laika bash (bashlex): cd pwd ls mkdir touch mv cp rm cat head tail wc grep awk sed curl echo export env sleep;",
        newline=True,
    )
    io.write(
        "Chromium fetch: browser-html URL [--wait load|domcontentloaded|networkidle];",
        newline=True,
    )
    io.write(
        "  browser-md URL [--full] [--wait …] (Markdown via markdownify); browser-login URL;",
        newline=True,
    )
    io.write("; && || | < > >> $(…) assignments.", newline=True)
    return 0


@register_command("true")
async def cmd_true(argv: List[str], st: Session, io: IO) -> int:
    return 0


@register_command("clear")
async def cmd_clear(argv: List[str], st: Session, io: IO) -> int:
    return 0


@register_command("false")
async def cmd_false(argv: List[str], st: Session, io: IO) -> int:
    return 1


@register_command("sleep")
async def cmd_sleep(argv: List[str], st: Session, io: IO) -> int:
    try:
        sec = float(argv[1]) if len(argv) > 1 else 0.0
    except ValueError:
        io.write_err("sleep: invalid time interval")
        return 1
    await asyncio.sleep(min(MAX_SLEEP_SECONDS, max(sec, 0.0)))
    return 0 if sec >= 0 else 1


@register_command("export")
async def cmd_export(argv: List[str], st: Session, io: IO) -> int:
    if len(argv) == 1:
        for key in sorted(st.env.keys()):
            io.write(f"export {key}={sh_quote(st.env[key])}", newline=True)
        return 0

    for token in argv[1:]:
        if "=" not in token:
            st.env.setdefault(token, "")
        else:
            idx = token.index("=")
            st.env[token[:idx]] = token[idx + 1 :]
    return 0


@register_command("unset")
async def cmd_unset(argv: List[str], st: Session, io: IO) -> int:
    for key in argv[1:]:
        st.env.pop(key, None)
    return 0


@register_command("pwd")
async def cmd_pwd(argv: List[str], st: Session, io: IO) -> int:
    io.write(st.cwd if st.cwd != "/" else "/", newline=True)
    return 0


@register_command("cd")
async def cmd_cd(argv: List[str], st: Session, io: IO) -> int:
    target = argv[1] if len(argv) > 1 else st.env.get("HOME", "/")
    if target == "-":
        target = st.env.get("OLDPWD", "/")

    new_path = await resolve_path(st, target)
    if not await _is_directory(st, new_path):
        io.write_err(f"cd: {target}: no such dir")
        return 1

    st.env["OLDPWD"] = st.cwd
    st.cwd = new_path
    st.env["PWD"] = st.cwd
    return 0


@register_command("env")
async def cmd_env(argv: List[str], st: Session, io: IO) -> int:
    for key in sorted(st.env.keys()):
        io.write(f"{key}={st.env[key]}", newline=True)
    return 0


@register_command("printenv")
async def cmd_printenv(argv: List[str], st: Session, io: IO) -> int:
    if len(argv) > 1:
        value = st.env.get(argv[1])
        if value is None:
            io.write_err("not set")
            return 1
        io.write(value, newline=True)
        return 0
    return await cmd_env(argv, st, io)


@register_command("echo")
async def cmd_echo(argv: List[str], st: Session, io: IO) -> int:
    idx = 1
    newline = True
    if len(argv) > idx and argv[idx] == "-n":
        idx += 1
        newline = False
    io.write(" ".join(argv[idx:]), newline=newline)
    return 0


@register_command("ls")
async def cmd_ls(argv: List[str], st: Session, io: IO) -> int:
    show_all = long_format = False
    paths: List[str] = []

    for arg in argv[1:]:
        if arg.startswith("-") and len(arg) > 1:
            show_all = show_all or ("a" in arg[1:])
            long_format = long_format or ("l" in arg[1:])
        else:
            paths.append(arg)

    if not paths:
        paths = ["."]

    exit_code = 0
    for path in paths:
        rel = vrel(await resolve_path(st, path))
        try:
            rows = await _list_files(rel)
        except Exception as exc:
            exit_code = 1
            io.write_err(f"ls: {path}: {exc}")
            continue

        rows = sorted(rows, key=lambda r: str(r.get("name", "")))
        if not show_all:
            rows = [r for r in rows if not str(r.get("name", "")).startswith(".")]

        if len(paths) > 1:
            io.write(f"{path}:", newline=True)

        for row in rows:
            name = str(row.get("name", ""))
            is_dir = row.get("isDirectory", False)
            suffix = "/" if is_dir else ""
            if long_format:
                size = row.get("size", 0)
                mtime = row.get("modified", 0)
                io.write(f"{size}\t{mtime}\t{name}{suffix}", newline=True)
            else:
                io.write(f"{name}{suffix}", newline=True)

    return exit_code


@register_command("cat")
async def cmd_cat(argv: List[str], st: Session, io: IO) -> int:
    if len(argv) == 1:
        io.write(io.stdin_text)
        return 0

    async def read_one(path: str) -> tuple[str, str]:
        try:
            rel = vrel(await resolve_path(st, path))
            content = await laika_read_file(rel)
            return (path, content[:MAX_CAT_BYTES])
        except Exception as exc:
            return (path, f"__ERROR__:{exc}")

    results = await asyncio.gather(*(read_one(f) for f in argv[1:]))
    exit_code = 0
    for path, content in results:
        if content.startswith("__ERROR__:"):
            exit_code = 1
            io.write_err(f"cat: {path}")
        else:
            io.write(content)
    return exit_code


@register_command("head")
async def cmd_head(argv: List[str], st: Session, io: IO) -> int:
    n, idx = 10, 1
    if len(argv) > idx and argv[idx] == "-n" and len(argv) > idx + 1:
        try:
            n = int(argv[idx + 1])
        except ValueError:
            io.write_err("head: invalid line count")
            return 1
        idx += 2

    filename = argv[idx] if len(argv) > idx else None
    data = io.stdin_text if filename is None else await _read_file_or_empty(
        vrel(await resolve_path(st, filename))
    )
    lines = data.split("\n")
    out = "\n".join(lines[:n]) + ("\n" if lines else "")
    io.write(out)
    return 0


@register_command("tail")
async def cmd_tail(argv: List[str], st: Session, io: IO) -> int:
    n, idx = 10, 1
    if len(argv) > idx and argv[idx] == "-n" and len(argv) > idx + 1:
        try:
            n = int(argv[idx + 1])
        except ValueError:
            io.write_err("tail: invalid line count")
            return 1
        idx += 2

    filename = argv[idx] if len(argv) > idx else None
    data = io.stdin_text if filename is None else await _read_file_or_empty(
        vrel(await resolve_path(st, filename))
    )
    lines = data.split("\n")
    body = lines[:-1] if lines and lines[-1] == "" else lines
    out = "\n".join(body[-n:]) + ("\n" if body else "")
    io.write(out)
    return 0


@register_command("mkdir")
async def cmd_mkdir(argv: List[str], st: Session, io: IO) -> int:
    exit_code = 0
    for path in argv[1:]:
        if path == "-p":
            continue
        try:
            await laika_mkdir(vrel(await resolve_path(st, path)))
        except Exception as exc:
            io.write_err(f"mkdir: {path}: {exc}")
            exit_code = 1
    return exit_code


@register_command("touch")
async def cmd_touch(argv: List[str], st: Session, io: IO) -> int:
    exit_code = 0
    for path in argv[1:]:
        rel = vrel(await resolve_path(st, path))
        try:
            await laika_read_file(rel)
        except Exception:
            try:
                await laika_write_file(rel, "")
            except Exception as exc:
                io.write_err(f"touch: {path}: {exc}")
                exit_code = 1
    return exit_code


@register_command("mv")
async def cmd_mv(argv: List[str], st: Session, io: IO) -> int:
    if len(argv) < 3:
        io.write_err("mv: missing operand")
        return 1

    src_rel = vrel(await resolve_path(st, argv[1]))
    dst_rel = vrel(await resolve_path(st, argv[2]))

    try:
        body = await laika_read_file(src_rel)
    except Exception:
        io.write_err(f"mv: cannot stat '{argv[1]}'")
        return 1

    dest = dst_rel
    try:
        await _list_files(dst_rel)
        base = argv[1].rstrip("/").split("/")[-1]
        dest = vrel(await resolve_path(st, argv[2].rstrip("/") + "/" + base))
    except Exception:
        pass

    try:
        await laika_write_file(dest, body)
        await laika_delete_file(src_rel, False)
    except Exception as exc:
        io.write_err(f"mv: {exc}")
        return 1
    return 0


@register_command("cp")
async def cmd_cp(argv: List[str], st: Session, io: IO) -> int:
    if len(argv) < 3:
        io.write_err("cp: missing operand")
        return 1

    recursive = "-r" in argv or "-R" in argv
    args = [a for a in argv[1:] if a not in ("-r", "-R")]
    dst = vrel(await resolve_path(st, args[-1]))

    dst_is_dir = False
    try:
        await _list_files(dst)
        dst_is_dir = True
    except Exception:
        pass

    if len(args) > 2 and not dst_is_dir:
        io.write_err("cp: target is not a directory")
        return 1

    exit_code = 0

    async def _copy_recursive(src_path: str, dst_path: str) -> bool:
        try:
            body = await laika_read_file(src_path)
            await laika_write_file(dst_path, body)
            return True
        except Exception:
            pass

        try:
            entries = await _list_files(src_path)
        except Exception:
            return False

        await laika_mkdir(dst_path)
        for entry in entries:
            name = str(entry.get("name", ""))
            if name in (".", ".."):
                continue
            child_src = (src_path + "/" + name).strip("/")
            child_dst = (dst_path + "/" + name).strip("/")
            if not await _copy_recursive(child_src, child_dst):
                return False
        return True

    for src in args[:-1]:
        src_rel = vrel(await resolve_path(st, src))
        target = dst
        if dst_is_dir or len(args) > 2:
            target = (dst + "/" + src.split("/")[-1]).strip("/")

        try:
            body = await laika_read_file(src_rel)
            await laika_write_file(target, body)
        except Exception:
            if recursive:
                if not await _copy_recursive(src_rel, target):
                    exit_code = 1
                    io.write_err(f"cp: cannot copy {src}")
            else:
                exit_code = 1
                io.write_err(f"cp: dir needs -r: {src}")

    return exit_code


@register_command("rm")
async def cmd_rm(argv: List[str], st: Session, io: IO) -> int:
    recursive = any(x in argv for x in ("-r", "-R", "-rf", "-fr"))
    skip = {"-r", "-R", "-f", "-rf", "-fr"}
    paths = [a for a in argv[1:] if a not in skip and not a.startswith("-")]

    exit_code = 0
    for path in paths:
        rel = vrel(await resolve_path(st, path))
        try:
            await laika_delete_file(rel, recursive)
        except Exception as exc:
            exit_code = 1
            io.write_err(f"rm: {path}: {exc}")
    return exit_code


@register_command("rmdir")
async def cmd_rmdir(argv: List[str], st: Session, io: IO) -> int:
    exit_code = 0
    for path in argv[1:]:
        rel = vrel(await resolve_path(st, path))
        try:
            entries = await _list_files(rel)
            if entries:
                io.write_err(f"rmdir: not empty {path}")
                exit_code = 1
                continue
            await laika_delete_file(rel)
        except Exception as exc:
            io.write_err(f"rmdir: {path}: {exc}")
            exit_code = 1
    return exit_code


def _count_lines(data: str) -> int:
    if not data:
        return 0
    return data.count("\n") if data.endswith("\n") else data.count("\n") + 1


@register_command("wc")
async def cmd_wc(argv: List[str], st: Session, io: IO) -> int:
    lines_only = "-l" in argv
    files = [a for a in argv[1:] if not a.startswith("-")]
    total = 0

    if not files:
        data = io.stdin_text
        n = _count_lines(data)
        io.write(str(n), newline=True)
        return 0

    exit_code = 0
    for path in files:
        try:
            data = await _read_file_or_empty(vrel(await resolve_path(st, path)))
            n = _count_lines(data)
            total += n
            io.write(f"{n}\t{path}", newline=True)
        except Exception as exc:
            exit_code = 1
            io.write_err(f"wc: {path}: {exc}")

    if lines_only and len(files) > 1:
        io.write(f"{total}\ttotal", newline=True)

    return exit_code


@register_command("grep")
async def cmd_grep(argv: List[str], st: Session, io: IO) -> int:
    ignore_case = "-i" in argv
    rest = [a for a in argv[1:] if a != "-i"]

    if not rest:
        io.write_err("grep: missing pattern")
        return 2

    pattern = rest[0]
    filename = rest[1] if len(rest) > 1 else None

    flags = re.I if ignore_case else 0
    try:
        cre = re.compile(pattern, flags)
    except re.error as exc:
        io.write_err(str(exc))
        return 2

    if filename is None:
        data = io.stdin_text or ""
    else:
        try:
            data = await _read_file_or_empty(vrel(await resolve_path(st, filename)))
        except Exception as exc:
            io.write_err(f"grep: {filename}: {exc}")
            return 2

    hits = 0
    for line in data.split("\n")[:MAX_GREP_LINES]:
        if cre.search(line):
            io.write(line, newline=True)
            hits += 1

    return 0 if hits else 1


@register_command("awk")
async def cmd_awk(argv: List[str], st: Session, io: IO) -> int:
    idx = 1
    sep: Optional[str] = None
    if len(argv) > idx and argv[idx] == "-F":
        if len(argv) <= idx + 1:
            io.write_err("awk: missing separator")
            return 2
        sep = argv[idx + 1]
        idx += 2

    if len(argv) <= idx:
        return 2

    prog = argv[idx]
    idx += 1
    filename = argv[idx] if len(argv) > idx else None

    data = io.stdin_text if filename is None else await _read_file_or_empty(
        vrel(await resolve_path(st, filename))
    )
    lines = data.split("\n")

    split_fn = (lambda ln: ln.split(sep)) if sep else (lambda ln: ln.split())

    if "print" not in prog:
        return 0

    m = re.match(r"^\{([^}]*)\}\s*$", prog.strip())
    if not m:
        io.write_err("awk: only {print …} subset supported")
        return 2

    inner = m.group(1).strip()

    condition: Optional[str] = None
    if "{" in prog:
        pre = prog.split("{", 1)[0].strip()
        if pre and not pre.startswith("BEGIN"):
            condition = pre

    for nr, line in enumerate(lines, 1):
        if not line and nr == len(lines):
            break

        if condition:
            if condition.startswith("/") and condition.endswith("/"):
                if not re.search(condition[1:-1], line):
                    continue
            elif condition.startswith("NR"):
                if not _eval_nr_condition(condition, nr):
                    continue

        fields = split_fn(line) if line else []
        if inner == "" or inner == "0":
            io.write(line, newline=True)
            continue

        toks = re.split(r"\s*,\s*", inner.replace("print", "").strip())
        out_parts: List[str] = []
        for tok in toks:
            tok = tok.strip()
            if tok.startswith("$"):
                idx_str = tok[1:]
                if idx_str.isdigit():
                    j = int(idx_str)
                    out_parts.append(fields[j - 1] if 0 < j <= len(fields) else "")
                elif idx_str == "NF":
                    out_parts.append(str(len(fields)))
                elif idx_str == "NR":
                    out_parts.append(str(nr))
                else:
                    out_parts.append("")
            else:
                out_parts.append(tok.strip("'\""))
        io.write(" ".join(out_parts), newline=True)

    return 0


def _eval_nr_condition(cond: str, nr: int) -> bool:
    m = re.match(r"NR\s*(<=|>=|<|>|==)\s*(\d+)", cond.replace(" ", ""))
    if not m:
        return True
    op, kk = m.group(1), int(m.group(2))
    return {
        "<=": lambda x, y: x <= y,
        ">=": lambda x, y: x >= y,
        "<": lambda x, y: x < y,
        ">": lambda x, y: x > y,
        "==": lambda x, y: x == y,
    }[op](nr, kk)


@register_command("sed")
async def cmd_sed(argv: List[str], st: Session, io: IO) -> int:
    if len(argv) < 2:
        return 2

    prog = argv[1]
    filename = argv[2] if len(argv) > 2 else None
    data = io.stdin_text if filename is None else await _read_file_or_empty(
        vrel(await resolve_path(st, filename))
    )
    lines = data.split("\n")
    out_lines: List[str] = []

    ms = re.match(r"s/([^/]*)/([^/]*)/(g)?", prog)
    if ms:
        old, new, gg = ms.group(1), ms.group(2), ms.group(3)
        count = 0 if gg else 1
        try:
            pat = re.compile(re.escape(old))
        except re.error as exc:
            io.write_err(str(exc))
            return 2
        for line in lines:
            out_lines.append(pat.sub(new, line, count=count))
    elif prog.isdigit():
        n_ln = int(prog)
        body = lines[:-1] if lines and lines[-1] == "" else lines
        for j, line in enumerate(body, 1):
            if j == n_ln:
                out_lines.append(line)
    else:
        io.write_err("sed: unsupported script")
        return 2

    io.write("\n".join(out_lines) + ("\n" if out_lines else ""))
    return 0


@register_command("browser-login")
async def cmd_browser_login(argv: List[str], st: Session, io: IO) -> int:
    """打开可见 Chromium（与会话 Cookie 共享 / 可先登录再爬）。"""
    urls = [a for a in argv[1:] if a.startswith(("http://", "https://"))]
    if len(urls) != 1:
        io.write_err("browser-login: exactly one https URL required")
        return 2
    try:
        await laika_browser_open_login(urls[0])
        io.write("login window opened (session shared with browser-html / browser-md)", newline=True)
    except Exception as exc:
        io.write_err(str(exc))
        return 1
    return 0


@register_command("browser-html")
async def cmd_browser_html(argv: List[str], st: Session, io: IO) -> int:
    """隐藏 Chromium 导航后抓取渲染完的 HTML。"""
    args = argv[1:]
    wait = "load"
    urls: List[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--wait" and i + 1 < len(args):
            wait = args[i + 1]
            if wait not in _BROWSER_WAIT:
                io.write_err("browser-html: --wait must be load|domcontentloaded|networkidle")
                return 2
            i += 2
            continue
        if a.startswith(("http://", "https://")):
            urls.append(a)
        i += 1
    if len(urls) != 1:
        io.write_err("browser-html: one http(s) URL required")
        return 2
    try:
        html = await laika_browser_get_html(urls[0], wait_until=wait)
        io.write(html)
    except Exception as exc:
        io.write_err(str(exc))
        return 1
    return 0


@register_command("browser-md")
async def cmd_browser_md(argv: List[str], st: Session, io: IO) -> int:
    """同上，Python markdownify 转 Markdown；--full 整页 body（SPA 更全、更噪）。"""
    args = argv[1:]
    wait = "load"
    mode = "readability"
    if "--full" in args:
        mode = "full"
        args = [a for a in args if a != "--full"]
    urls: List[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--wait" and i + 1 < len(args):
            wait = args[i + 1]
            if wait not in _BROWSER_WAIT:
                io.write_err("browser-md: --wait must be load|domcontentloaded|networkidle")
                return 2
            i += 2
            continue
        if a.startswith(("http://", "https://")):
            urls.append(a)
        i += 1
    if len(urls) != 1:
        io.write_err("browser-md: one http(s) URL required")
        return 2
    try:
        md = await laika_browser_get_markdown(urls[0], wait_until=wait, mode=mode)
        io.write(md, newline=md.endswith("\n"))
    except Exception as exc:
        io.write_err(str(exc))
        return 1
    return 0


@register_command("curl")
async def cmd_curl(argv: List[str], st: Session, io: IO) -> int:
    args = argv[1:]
    silent = "-s" in args
    method, body, headers, out_path = "GET", None, {}, None
    urls: List[str] = []

    i = 0
    while i < len(args):
        a = args[i]
        if a == "-s":
            i += 1
            continue
        if a == "-o" and i + 1 < len(args):
            out_path, i = args[i + 1], i + 2
            continue
        if a == "-X" and i + 1 < len(args):
            method, i = args[i + 1].upper(), i + 2
            continue
        if a == "-d" and i + 1 < len(args):
            body, i = args[i + 1], i + 2
            continue
        if a == "-H" and i + 1 < len(args):
            hh = args[i + 1]
            if ":" in hh:
                k, v = hh.split(":", 1)
                headers[k.strip()] = v.strip()
            i += 2
            continue
        if a.startswith(("http://", "https://")):
            urls.append(a)
            i += 1
            continue
        i += 1

    if not urls:
        io.write_err("curl: missing URL")
        return 2

    url = urls[0]
    try:
        r = await laika_http_request(
            url, method=method, headers=headers if headers else None, body=body
        )
        blob = r.get("body") if isinstance(r.get("body"), str) else json.dumps(r, ensure_ascii=False)

        if out_path:
            await laika_write_file(vrel(await resolve_path(st, out_path)), blob)
            if not silent:
                io.write(f"saved {out_path}", newline=True)
        else:
            if not silent:
                io.write(blob, newline=isinstance(blob, str) and blob.endswith("\n"))
    except Exception as exc:
        io.write_err(str(exc))
        return 1
    return 0


# -----------------------------------------------------------------------------
# Entry
# -----------------------------------------------------------------------------


async def laika_run_shell(src: str) -> int:
    if not src or not src.strip():
        return 0

    st = get_session()
    try:
        trees = bashlex.parse(src)
    except Exception as exc:
        print(f"bashlex: {exc}", file=sys.stderr, flush=True)
        st.last_exit_code = 2
        return 2

    exit_code = 0
    io = IO()
    for tree in trees:
        exit_code = await run_ast(tree, st, io)

    return exit_code
