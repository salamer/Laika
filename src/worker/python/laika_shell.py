"""Shell execution in Pyodide: bashlex AST + Python builtins (Laika).

Expects globals: laika_read_file, laika_write_file, laika_mkdir, laika_list_files,
laika_http_request, laika_delete_file,
laika_browser_get_html, laika_browser_get_markdown, laika_browser_evaluate, laika_browser_open_login (async).

bashlex: https://github.com/idank/bashlex

Major enhancements:
- complete if/else/elif, for, while
- test / [ ] builtin
- enhanced awk (BEGIN/END, pattern-action), sed (addresses, d, s with backrefs), grep (-v, -r, -c, -l)
- arithmetic expansion $(( ... ))
- here-document support
- subshell isolation for command substitution and pipelines

Security (Pyodide / no real POSIX shell): interpreted here; FS and network only via injected
async laika_* bridge. Curl/browser still delegate to host—tighten at IPC if you need URL isolation.
"""

from __future__ import annotations

import asyncio
import json
import math
import operator
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Dict, List, Optional, Protocol, Tuple, Union

import bashlex

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
MAX_CAT_BYTES = 8 * 1024 * 1024
MAX_GREP_LINES = 50_000
MAX_SLEEP_SECONDS = 10.0
MAX_WHILE_ITERATIONS = 100_000
EXIT_RESOURCE_CAP = 124
MAX_SHELL_SOURCE_CHARS = 2 * 1024 * 1024
_BROWSER_WAIT = frozenset({"load", "domcontentloaded", "networkidle"})

# -----------------------------------------------------------------------------
# bashlex AST helpers
# -----------------------------------------------------------------------------

class _AstNode(Protocol):
    kind: str
    pos: tuple[int, int]
    parts: List[Any]

def node_kind(node: Any) -> str:
    k = getattr(node, "kind", None)
    if k is not None and str(k):
        return str(k)
    nm = type(node).__name__
    if nm.endswith("Node"):
        return nm[:-4].lower()
    return nm.lower()

# -----------------------------------------------------------------------------
# IO & Session
# -----------------------------------------------------------------------------

@dataclass
class IO:
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

    def copy(self) -> Session:
        return Session(cwd=self.cwd, env=dict(self.env), last_exit_code=self.last_exit_code)

_session: Optional[Session] = None

def get_session() -> Session:
    global _session
    if _session is None:
        _session = Session()
    return _session

async def laika_reset_shell_session() -> None:
    global _session
    _session = Session()

# -----------------------------------------------------------------------------
# Path helpers
# -----------------------------------------------------------------------------

def vrel(path: str) -> str:
    if path in ("/", ".", ""):
        return "."
    return path.strip("/")

def join_path(cwd: str, segment: str) -> str:
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
    if path.startswith("/"):
        return join_path("/", path)
    return join_path(st.cwd, path)

# -----------------------------------------------------------------------------
# Word expansion: $VAR, ${VAR}, $(cmd), $?, $((...))
# -----------------------------------------------------------------------------

@dataclass
class PlainWord:
    word: str
    parts: List[Any] = field(default_factory=list)
    pos: tuple[int, int] = field(default_factory=lambda: (0, 0))

    def __post_init__(self) -> None:
        if self.pos == (0, 0):
            self.pos = (0, len(self.word))

# Safe arithmetic evaluator (only integer operations)
def _safe_arith(expr: str, st: Session) -> int:
    # Replace variables with their values (must be integers)
    replaced = re.sub(r'\$\{?(\w+)\}?', lambda m: st.env.get(m.group(1), '0'), expr)
    # Check only allowed chars
    if not re.match(r'^[0-9+\-*/%() ]+$', replaced):
        raise ValueError(f"unsafe arithmetic: {replaced}")
    return int(eval(replaced, {"__builtins__": {}}, {}))

async def _expand_part(part: Any, st: Session) -> str:
    kind = node_kind(part)
    if kind == "parameter":
        value = str(getattr(part, "value", ""))
        if value == "?":
            return str(st.last_exit_code)
        # Simple default expansion: ${VAR:-default}
        m = re.match(r'^(\w+):-(.+)$', value)
        if m:
            var = m.group(1)
            default = m.group(2)
            return st.env.get(var, default)
        return st.env.get(value.strip("{}"), "")
    if kind == "commandsubstitution":
        sub_st = st.copy()
        sub_io = IO("", capture_stdout=True)
        await run_ast(part.command, sub_st, sub_io)
        return sub_io.stdout_text().rstrip("\n")
    if kind == "arithmetic":
        # bashlex may parse $((...)) as arithmetic node
        try:
            return str(_safe_arith(part.word, st))
        except Exception:
            return "0"
    return ""

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

async def eval_assignments(nodes: List[Any], st: Session) -> Dict[str, str]:
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
# AST execution
# -----------------------------------------------------------------------------

async def run_ast(node: Any, st: Session, io: IO, local_env: Optional[Dict[str, str]] = None) -> int:
    kind = node_kind(node)
    if kind == "command":
        return await _run_command(node, st, io, local_env)
    if kind == "list":
        return await _run_list(node.parts, st, io)
    if kind == "pipeline":
        return await _run_pipeline(node, st, io)
    if kind == "compound":
        if node.list:
            first = node.list[0]
            first_kind = node_kind(first)
            if first_kind == "if":
                return await _run_if(first, st, io)
            if first_kind == "for":
                return await _run_for(first, st, io)
            if first_kind == "while":
                return await _run_while(first, st, io)
        io.write_err(f"unsupported compound")
        return 2
    if kind == "comment":
        return 0
    if kind == "subshell":
        sub_st = st.copy()
        sub_io = IO(io.stdin_text, io.capture_stdout)
        exit_code = await run_ast(node.command, sub_st, sub_io)
        if io.capture_stdout:
            io.write(sub_io.stdout_text())
        return exit_code
    if kind == "arithmetic":
        try:
            val = _safe_arith(getattr(node, "word", "0"), st)
            io.write(str(val), newline=True)
            return 0
        except Exception:
            return 1
    io.write_err(f"unsupported: {kind}")
    st.last_exit_code = 2
    return 2

async def _run_command(node: Any, st: Session, io: IO, local_env: Optional[Dict[str, str]] = None) -> int:
    words: List[Any] = []
    redirects: List[Any] = []
    assignments: List[Any] = []

    for part in node.parts:
        pt = node_kind(part)
        if pt == "redirect":
            redirects.append(part)
        elif pt == "word":
            words.append(part)
        elif pt == "assignment":
            assignments.append(part)
        elif pt == "heredoc":
            # treat heredoc like a redirect with stdin
            redirects.append(part)
        elif pt == "compound":
            raise ValueError("nested compound unsupported")
        else:
            raise ValueError(f"unknown part type: {pt}")

    # Apply assignments then local_env (temp env like from env cmd)
    if assignments:
        st.env = await eval_assignments(assignments, st)
    if local_env:
        st.env = {**st.env, **local_env}

    stdin_text = io.stdin_text or ""
    out_path: Optional[str] = None
    out_append = False

    for rd in redirects:
        rd_type = getattr(rd, "type", None)
        if rd_type == "heredoc":
            # bashlex heredoc node: word (delimiter) and content
            heredoc_content = getattr(rd, "output", None)
            if heredoc_content:
                stdin_text = heredoc_content
            continue
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
    cmds = [x for x in node.parts if node_kind(x) == "command"]
    if not cmds:
        st.last_exit_code = 2
        return 2
    pipe_data = ""
    for idx, cmd in enumerate(cmds):
        is_last = idx == len(cmds) - 1
        capture = not is_last or io.capture_stdout
        stdin_in = io.stdin_text if idx == 0 else pipe_data
        # Use a copy of session for pipeline commands to avoid environment leaks
        sub_st = st.copy() if not is_last else st
        sub_io = IO(stdin_in, capture)
        exit_code = await run_ast(cmd, sub_st, sub_io)
        if is_last:
            if io.capture_stdout:
                io.write(sub_io.stdout_text())
            st.last_exit_code = exit_code
            return exit_code
        pipe_data = sub_io.stdout_text()
    st.last_exit_code = 2
    return 2

# --- if / for / while -----------------------------------------------

async def _run_if(node: Any, st: Session, io: IO) -> int:
    parts = node.parts
    # Find all "if", "then", "elif", "else", "fi" tokens
    idx = 0
    while idx < len(parts):
        tok = str(getattr(parts[idx], "word", ""))
        if tok == "if":
            idx += 1
            # condition list
            cond_end = None
            for j in range(idx, len(parts)):
                if str(getattr(parts[j], "word", "")) == "then":
                    cond_end = j
                    break
            if cond_end is None:
                break
            cond_list = parts[idx:cond_end]
            idx = cond_end + 1
            # body list until elif/else/fi
            body_end = None
            for j in range(idx, len(parts)):
                w = str(getattr(parts[j], "word", ""))
                if w in ("elif", "else", "fi"):
                    body_end = j
                    break
            if body_end is None:
                break
            body_list = parts[idx:body_end]
            # Execute condition
            cond_st = st.copy()
            cond_io = IO(io.stdin_text, io.capture_stdout)
            cond_exit = await _run_list(cond_list, cond_st, cond_io)
            if not io.capture_stdout:
                io.write(cond_io.stdout_text())
            if cond_exit == 0:
                # Execute then body
                body_st = st.copy()
                body_io = IO(io.stdin_text, io.capture_stdout)
                body_exit = await _run_list(body_list, body_st, body_io)
                if io.capture_stdout:
                    io.write(body_io.stdout_text())
                st.last_exit_code = body_exit
                return body_exit
            # skip to next elif/else/fi
            idx = body_end
            next_word = str(getattr(parts[idx], "word", ""))
            if next_word == "elif":
                # continue loop for next condition
                continue
            elif next_word == "else":
                idx += 1
                else_end = None
                for j in range(idx, len(parts)):
                    if str(getattr(parts[j], "word", "")) == "fi":
                        else_end = j
                        break
                if else_end is not None:
                    else_list = parts[idx:else_end]
                    else_st = st.copy()
                    else_io = IO(io.stdin_text, io.capture_stdout)
                    else_exit = await _run_list(else_list, else_st, else_io)
                    if io.capture_stdout:
                        io.write(else_io.stdout_text())
                    st.last_exit_code = else_exit
                    return else_exit
            else:
                # fi
                break
        else:
            idx += 1
    st.last_exit_code = 0
    return 0

async def _run_for(node: Any, st: Session, io: IO) -> int:
    parts = node.parts
    var = str(getattr(parts[1], "word", "")) if len(parts) > 1 else "it"
    # find "in" and "do"
    in_idx = None
    do_idx = None
    for i, p in enumerate(parts):
        w = str(getattr(p, "word", ""))
        if w == "in":
            in_idx = i
        elif w == "do":
            do_idx = i
            break
    if do_idx is None:
        return 2
    # words before "do" and after "in" are the list items
    word_parts = []
    if in_idx is not None:
        word_parts = parts[in_idx+1:do_idx]
    # Expand words
    items = []
    for wp in word_parts:
        if node_kind(wp) == "word":
            items.append(await expand_word(wp, st))
    # If no items, fallback to "$@" but we skip
    body_parts = parts[do_idx+1:]
    # find "done"
    done_idx = None
    for i, p in enumerate(body_parts):
        if str(getattr(p, "word", "")) == "done":
            done_idx = i
            break
    if done_idx is None:
        return 2
    body_list = body_parts[:done_idx]

    for_st = st.copy()
    exit_code = 0
    for item in items:
        for_st.env[var] = item
        exit_code = await _run_list(body_list, for_st, io)
        # break/continue not implemented
    st.last_exit_code = exit_code
    return exit_code

async def _run_while(node: Any, st: Session, io: IO) -> int:
    parts = node.parts
    # skip "while"
    # find "do"
    do_idx = None
    for i, p in enumerate(parts):
        if str(getattr(p, "word", "")) == "do":
            do_idx = i
            break
    if do_idx is None:
        return 2
    cond_parts = parts[1:do_idx]
    body_parts = parts[do_idx+1:]
    done_idx = None
    for i, p in enumerate(body_parts):
        if str(getattr(p, "word", "")) == "done":
            done_idx = i
            break
    if done_idx is None:
        return 2
    body_list = body_parts[:done_idx]

    while_st = st.copy()
    last_body_exit = 0
    entered = False
    iterations = 0
    while True:
        if iterations >= MAX_WHILE_ITERATIONS:
            io.write_err(f"while: exceeded maximum iterations ({MAX_WHILE_ITERATIONS})")
            st.last_exit_code = EXIT_RESOURCE_CAP
            return EXIT_RESOURCE_CAP
        iterations += 1
        cond_st = while_st.copy()
        cond_io = IO(io.stdin_text, capture_stdout=True)
        cond_exit = await _run_list(cond_parts, cond_st, cond_io)
        if cond_exit != 0:
            break
        entered = True
        body_io = IO(io.stdin_text, io.capture_stdout)
        last_body_exit = await _run_list(body_list, while_st, body_io)
        if io.capture_stdout:
            io.write(body_io.stdout_text())
    if not entered:
        st.last_exit_code = 0
        return 0
    st.last_exit_code = last_body_exit
    return last_body_exit

# -----------------------------------------------------------------------------
# Command registry
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
# File utilities
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
    try:
        await _list_files(vrel(await resolve_path(st, path)))
        return True
    except Exception:
        return False

async def _path_is_regular_file(st: Session, path: str) -> bool:
    """True if workspace path resolves to a readable regular file (not a directory)."""
    rp = await resolve_path(st, path)
    if await _is_directory(st, rp):
        return False
    try:
        await laika_read_file(vrel(rp))
        return True
    except Exception:
        return False

def sh_quote(value: str) -> str:
    if re.match(r"^[\w@%+=:,./-]+$", value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"

# -----------------------------------------------------------------------------
# Builtin commands
# -----------------------------------------------------------------------------

@register_command("help")
async def cmd_help(argv: List[str], st: Session, io: IO) -> int:
    io.write("Laika bash extended: cd pwd ls mkdir touch mv cp rm cat head tail wc grep awk sed curl echo export env printenv sleep;", newline=True)
    io.write("test / [ ] exit source . for while if-elif-else $(( )) ; && || | < > >> << ; browser-html/-md/-login", newline=True)
    return 0

@register_command("true")
async def cmd_true(argv, st, io): return 0
@register_command("clear")
async def cmd_clear(argv, st, io): return 0
@register_command("false")
async def cmd_false(argv, st, io): return 1

@register_command("sleep")
async def cmd_sleep(argv, st, io):
    try:
        sec = float(argv[1]) if len(argv) > 1 else 0.0
    except ValueError:
        io.write_err("sleep: invalid time interval")
        return 1
    await asyncio.sleep(min(MAX_SLEEP_SECONDS, max(sec, 0.0)))
    return 0 if sec >= 0 else 1

@register_command("export")
async def cmd_export(argv, st, io):
    if len(argv) == 1:
        for key in sorted(st.env.keys()):
            io.write(f"export {key}={sh_quote(st.env[key])}", newline=True)
        return 0
    for token in argv[1:]:
        if "=" not in token:
            st.env.setdefault(token, "")
        else:
            idx = token.index("=")
            st.env[token[:idx]] = token[idx+1:]
    return 0

@register_command("unset")
async def cmd_unset(argv, st, io):
    for key in argv[1:]:
        st.env.pop(key, None)
    return 0

@register_command("printenv")
async def cmd_printenv(argv: List[str], st: Session, io: IO) -> int:
    if len(argv) == 1:
        for key in sorted(st.env.keys()):
            io.write(f"{key}={st.env[key]}", newline=True)
        return 0
    err = False
    for name in argv[1:]:
        if name not in st.env:
            io.write_err(f"printenv: {name}: environment variable not set")
            err = True
            continue
        io.write(st.env[name], newline=True)
    return 1 if err else 0

@register_command("exit")
async def cmd_exit(argv, st, io):
    code = 0
    if len(argv) > 1:
        try:
            code = int(argv[1])
        except:
            code = 0
    st.last_exit_code = code
    # In a real shell, exit would stop execution. We'll raise a special exception.
    raise SystemExit(code)

@register_command("source")
async def cmd_source(argv, st, io):
    if len(argv) < 2:
        return 1
    path = argv[1]
    rel = vrel(await resolve_path(st, path))
    try:
        content = await laika_read_file(rel)
    except Exception:
        io.write_err(f"source: {path}: file not found")
        return 1
    # Execute in current session
    await laika_run_shell(content)
    return st.last_exit_code

@register_command(".")
async def cmd_dot(argv, st, io):
    return await cmd_source(argv, st, io)

# ---- test / [ -------------------------------------------------------
# -r/-w: Laika approximates as "path exists" (no separate mode bits in VFS).
# -x: true for directories (searchable); regular files are treated as non-executable.
async def _test_eval_async(argv: List[str], st: Session) -> int:
    args = list(argv)
    if args and args[0] == "test":
        args = args[1:]
    if args and args[0] == "[":
        args = args[1:]
    if args and args[-1] == "]":
        args = args[:-1]
    if not args:
        return 1
    if len(args) == 1:
        return 0 if args[0] else 1
    if args[0] in ("-z", "-n"):
        if len(args) < 2:
            return 1
        s = args[1]
        if args[0] == "-z":
            return 0 if not s else 1
        return 0 if s else 1
    if args[0] in ("-f", "-d", "-e", "-x", "-r", "-w"):
        if len(args) < 2:
            return 1
        path_arg = args[1]
        rp = await resolve_path(st, path_arg)
        is_dir = await _is_directory(st, rp)
        is_reg = await _path_is_regular_file(st, path_arg)
        exists = is_dir or is_reg
        op = args[0]
        if op == "-d":
            return 0 if is_dir else 1
        if op == "-f":
            return 0 if is_reg else 1
        if op == "-e":
            return 0 if exists else 1
        if op in ("-r", "-w"):
            return 0 if exists else 1
        if op == "-x":
            if is_dir:
                return 0
            return 1
    if len(args) == 3:
        op = args[1]
        lhs, rhs = args[0], args[2]
        if op == "=":
            return 0 if lhs == rhs else 1
        if op == "!=":
            return 1 if lhs == rhs else 0
        if op in ("-eq", "-ne", "-lt", "-le", "-gt", "-ge"):
            try:
                lv = int(lhs); rv = int(rhs)
            except Exception:
                return 1
            if op == "-eq": return 0 if lv == rv else 1
            if op == "-ne": return 0 if lv != rv else 1
            if op == "-lt": return 0 if lv < rv else 1
            if op == "-le": return 0 if lv <= rv else 1
            if op == "-gt": return 0 if lv > rv else 1
            if op == "-ge": return 0 if lv >= rv else 1
    return 1

@register_command("test")
async def cmd_test(argv, st, io):
    return await _test_eval_async(argv, st)

@register_command("[")
async def cmd_bracket(argv, st, io):
    return await _test_eval_async(argv, st)

# ---- pwd/cd/env/echo/ls --------------------------------------------
@register_command("pwd")
async def cmd_pwd(argv, st, io):
    io.write(st.cwd if st.cwd != "/" else "/", newline=True)
    return 0

@register_command("cd")
async def cmd_cd(argv, st, io):
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
async def cmd_env(argv, st, io):
    for key in sorted(st.env.keys()):
        io.write(f"{key}={st.env[key]}", newline=True)
    return 0

@register_command("echo")
async def cmd_echo(argv, st, io):
    idx = 1
    newline = True
    if len(argv) > idx and argv[idx] == "-n":
        idx += 1
        newline = False
    io.write(" ".join(argv[idx:]), newline=newline)
    return 0

@register_command("ls")
async def cmd_ls(argv, st, io):
    show_all = long_format = False
    paths: List[str] = []
    for arg in argv[1:]:
        if arg.startswith("-") and len(arg)>1:
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

# ---- file commands (cat, head, tail, mkdir, touch, mv, cp, rm, rmdir, wc) ----
@register_command("cat")
async def cmd_cat(argv, st, io):
    if len(argv) == 1:
        io.write(io.stdin_text)
        return 0
    async def read_one(path: str):
        try:
            rel = vrel(await resolve_path(st, path))
            return (path, (await laika_read_file(rel))[:MAX_CAT_BYTES])
        except Exception as e:
            return (path, f"__ERROR__:{e}")
    results = await asyncio.gather(*(read_one(f) for f in argv[1:]))
    exit_code = 0
    for path, content in results:
        if isinstance(content, str) and content.startswith("__ERROR__:"):
            exit_code = 1
            io.write_err(f"cat: {path}")
        else:
            io.write(content)
    return exit_code

@register_command("head")
async def cmd_head(argv, st, io):
    n, idx = 10, 1
    if len(argv)>idx and argv[idx]=="-n" and len(argv)>idx+1:
        try: n = int(argv[idx+1])
        except: io.write_err("head: invalid line count"); return 1
        idx += 2
    filename = argv[idx] if len(argv)>idx else None
    data = io.stdin_text if filename is None else await _read_file_or_empty(vrel(await resolve_path(st, filename)))
    lines = data.split("\n")
    io.write("\n".join(lines[:n]) + ("\n" if lines else ""))
    return 0

@register_command("tail")
async def cmd_tail(argv, st, io):
    n, idx = 10, 1
    if len(argv)>idx and argv[idx]=="-n" and len(argv)>idx+1:
        try: n = int(argv[idx+1])
        except: io.write_err("tail: invalid line count"); return 1
        idx += 2
    filename = argv[idx] if len(argv)>idx else None
    data = io.stdin_text if filename is None else await _read_file_or_empty(vrel(await resolve_path(st, filename)))
    lines = data.split("\n")
    body = lines[:-1] if lines and lines[-1]=="" else lines
    io.write("\n".join(body[-n:]) + ("\n" if body else ""))
    return 0

@register_command("mkdir")
async def cmd_mkdir(argv, st, io):
    exit_code=0
    for path in argv[1:]:
        if path == "-p": continue
        try: await laika_mkdir(vrel(await resolve_path(st, path)))
        except Exception as e: io.write_err(f"mkdir: {path}: {e}"); exit_code=1
    return exit_code

@register_command("touch")
async def cmd_touch(argv, st, io):
    exit_code=0
    for path in argv[1:]:
        rel = vrel(await resolve_path(st, path))
        try: await laika_read_file(rel)
        except:
            try: await laika_write_file(rel, "")
            except Exception as e: io.write_err(f"touch: {path}: {e}"); exit_code=1
    return exit_code

@register_command("mv")
async def cmd_mv(argv, st, io):
    if len(argv)<3: io.write_err("mv: missing operand"); return 1
    src_rel = vrel(await resolve_path(st, argv[1]))
    dst_rel = vrel(await resolve_path(st, argv[2]))
    try: body = await laika_read_file(src_rel)
    except: io.write_err(f"mv: cannot stat '{argv[1]}'"); return 1
    dest = dst_rel
    try:
        await _list_files(dst_rel)
        base = argv[1].rstrip("/").split("/")[-1]
        dest = vrel(await resolve_path(st, argv[2].rstrip("/")+"/"+base))
    except: pass
    try:
        await laika_write_file(dest, body)
        await laika_delete_file(src_rel, False)
    except Exception as e: io.write_err(f"mv: {e}"); return 1
    return 0

@register_command("cp")
async def cmd_cp(argv, st, io):
    if len(argv)<3: io.write_err("cp: missing operand"); return 1
    recursive = "-r" in argv or "-R" in argv
    args = [a for a in argv[1:] if a not in ("-r","-R")]
    dst = vrel(await resolve_path(st, args[-1]))
    dst_is_dir = False
    try: await _list_files(dst); dst_is_dir = True
    except: pass
    if len(args)>2 and not dst_is_dir: io.write_err("cp: target is not a directory"); return 1
    exit_code = 0
    async def _copy_rec(src, dst):
        try:
            body = await laika_read_file(src)
            await laika_write_file(dst, body)
            return True
        except: pass
        try: entries = await _list_files(src)
        except: return False
        await laika_mkdir(dst)
        for e in entries:
            name = e.get("name","")
            if name in (".",".."): continue
            if not await _copy_rec(src+"/"+name, dst+"/"+name): return False
        return True
    for src in args[:-1]:
        src_rel = vrel(await resolve_path(st, src))
        target = dst if not dst_is_dir and len(args)==2 else (dst+"/"+src.split("/")[-1]).strip("/")
        try:
            body = await laika_read_file(src_rel)
            await laika_write_file(target, body)
        except:
            if recursive:
                if not await _copy_rec(src_rel, target):
                    exit_code=1; io.write_err(f"cp: cannot copy {src}")
            else:
                exit_code=1; io.write_err(f"cp: dir needs -r: {src}")
    return exit_code

@register_command("rm")
async def cmd_rm(argv, st, io):
    recursive = any(x in argv for x in ("-r","-R","-rf","-fr"))
    skip = {"-r","-R","-f","-rf","-fr"}
    paths = [a for a in argv[1:] if a not in skip and not a.startswith("-")]
    exit_code=0
    for path in paths:
        rel = vrel(await resolve_path(st, path))
        try: await laika_delete_file(rel, recursive)
        except Exception as e: exit_code=1; io.write_err(f"rm: {path}: {e}")
    return exit_code

@register_command("rmdir")
async def cmd_rmdir(argv, st, io):
    exit_code=0
    for path in argv[1:]:
        rel = vrel(await resolve_path(st, path))
        try:
            entries = await _list_files(rel)
            if entries: io.write_err(f"rmdir: not empty {path}"); exit_code=1; continue
            await laika_delete_file(rel)
        except Exception as e: io.write_err(f"rmdir: {path}: {e}"); exit_code=1
    return exit_code

def _count_lines(data): return data.count("\n") + (0 if data.endswith("\n") else 1) if data else 0

@register_command("wc")
async def cmd_wc(argv, st, io):
    lines_only = "-l" in argv
    files = [a for a in argv[1:] if not a.startswith("-")]
    if not files:
        io.write(str(_count_lines(io.stdin_text)), newline=True)
        return 0
    total=0; exit_code=0
    for path in files:
        try:
            data = await _read_file_or_empty(vrel(await resolve_path(st, path)))
            n = _count_lines(data)
            total+=n
            io.write(f"{n}\t{path}", newline=True)
        except Exception as e: exit_code=1; io.write_err(f"wc: {path}: {e}")
    if lines_only and len(files)>1: io.write(f"{total}\ttotal", newline=True)
    return exit_code

# ---- grep: enhanced ------------------------------------------------
@register_command("grep")
async def cmd_grep(argv, st, io):
    flags = 0
    invert = False
    count_only = False
    files_with_matches = False
    recursive = False
    pattern = None
    paths = []
    i=1
    while i < len(argv):
        a = argv[i]
        if a.startswith("-"):
            if "i" in a: flags |= re.I
            if "v" in a: invert = True
            if "c" in a: count_only = True
            if "l" in a: files_with_matches = True
            if "r" in a or "R" in a: recursive = True
            i += 1
            continue
        if pattern is None:
            pattern = a
            i += 1
            continue
        paths.append(a)
        i += 1
    if pattern is None:
        io.write_err("grep: missing pattern"); return 2
    try:
        cre = re.compile(pattern, flags)
    except re.error as e:
        io.write_err(str(e)); return 2

    if not paths:
        data = io.stdin_text or ""
        lines = data.split("\n")[:MAX_GREP_LINES]
        matched = 0
        for line in lines:
            if bool(cre.search(line)) != invert:
                if files_with_matches:
                    io.write("(standard input)", newline=True); matched=1; break
                if count_only:
                    matched += 1
                else:
                    io.write(line, newline=True)
                    matched = 1
        if count_only: io.write(str(matched), newline=True)
        return 0 if matched else 1

    # Process files
    async def process_file(rel, display_name):
        try:
            data = await _read_file_or_empty(rel)
        except Exception:
            return False
        lines = data.split("\n")[:MAX_GREP_LINES]
        matched = 0
        for line in lines:
            if bool(cre.search(line)) != invert:
                if files_with_matches:
                    io.write(display_name, newline=True); return True
                if count_only:
                    matched += 1
                else:
                    prefix = f"{display_name}:" if len(paths)>1 or recursive else ""
                    io.write(prefix + line, newline=True)
                    matched = 1
        if count_only and matched:
            io.write(f"{display_name}:{matched}", newline=True)
        return matched > 0

    exit_code = 1
    # collect files, possibly recursively
    async def collect_files(base_rel, base_name):
        files = []
        try:
            entries = await _list_files(base_rel)
            for e in entries:
                name = e.get("name","")
                if name in (".",".."): continue
                child_rel = (base_rel + "/" + name).strip("/")
                if e.get("isDirectory", False):
                    if recursive:
                        files.extend(await collect_files(child_rel, f"{base_name}/{name}"))
                else:
                    files.append((child_rel, f"{base_name}/{name}" if base_name else name))
        except:
            pass
        return files

    all_files = []
    if recursive:
        for p in paths:
            rel = vrel(await resolve_path(st, p))
            try:
                is_dir = await _is_directory(st, p)
            except: is_dir = False
            if is_dir:
                all_files.extend(await collect_files(rel, ""))
            else:
                all_files.append((rel, p))
    else:
        for p in paths:
            rel = vrel(await resolve_path(st, p))
            all_files.append((rel, p))

    for rel, dname in all_files:
        if await process_file(rel, dname):
            exit_code = 0
    return exit_code

# ---- awk: enhanced with BEGIN/END, multiple pattern-action ---------
def _parse_awk_program(prog: str):
    """Returns (begin_actions, rules, end_actions) where each rule is (pattern, action)."""
    begin = []
    end = []
    rules = []
    # Split by ';' but respect braces
    # Simple state machine
    parts = []
    brace_depth = 0
    current = ""
    for ch in prog:
        if ch == '{': brace_depth+=1
        elif ch == '}': brace_depth-=1
        if ch == ';' and brace_depth==0:
            parts.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip(): parts.append(current.strip())

    for part in parts:
        part = part.strip()
        if part.startswith("BEGIN{"):
            body = part[6:].rstrip("}")
            begin.append(body)
        elif part.startswith("END{"):
            body = part[4:].rstrip("}")
            end.append(body)
        else:
            # pattern { action } or only { action }
            m = re.match(r'^(.*?)(\{.*\})$', part)
            if m:
                pat = m.group(1).strip()
                act = m.group(2).strip()[1:-1]  # remove {}
                rules.append((pat, act))
            else:
                # no action, default print
                rules.append((part, ""))
    return begin, rules, end

def _awk_print(act: str, fields: List[str], nr: int, line: str) -> Optional[str]:
    """Evaluate a simple print action, return string to output or None."""
    if not act:
        return line  # default print
    # remove outer print
    act = re.sub(r'^\s*print\s*', '', act).strip()
    if act == "0" or act == "$0":
        return line
    toks = re.split(r'\s*,\s*', act)
    out_parts = []
    for tok in toks:
        tok = tok.strip()
        if tok.startswith("$"):
            idx = tok[1:]
            if idx.isdigit():
                i = int(idx)
                out_parts.append(fields[i-1] if 0<i<=len(fields) else "")
            elif idx == "NF":
                out_parts.append(str(len(fields)))
            elif idx == "NR":
                out_parts.append(str(nr))
            else:
                out_parts.append("")
        else:
            out_parts.append(tok.strip("'\""))
    return " ".join(out_parts)

@register_command("awk")
async def cmd_awk(argv, st, io):
    idx = 1
    field_sep: Optional[str] = None
    # Parse -F
    if len(argv)>idx and argv[idx]=="-F":
        if len(argv)<=idx+1: io.write_err("awk: missing separator"); return 2
        field_sep = argv[idx+1]
        idx += 2
    if len(argv)<=idx: return 2
    prog = argv[idx]; idx+=1
    filename = argv[idx] if len(argv)>idx else None

    data = io.stdin_text if filename is None else await _read_file_or_empty(vrel(await resolve_path(st, filename)))
    lines = data.split("\n")
    begin_actions, rules, end_actions = _parse_awk_program(prog)

    # Execute BEGIN
    for ba in begin_actions:
        # very simplified: we only support print in BEGIN
        out = _awk_print(ba, [], 0, "")
        if out is not None:
            io.write(out, newline=True)

    split_fn = (lambda ln: re.split(field_sep, ln)) if field_sep else (lambda ln: ln.split())

    # Process lines
    for nr, line in enumerate(lines, 1):
        if not line and nr == len(lines): break
        fields = split_fn(line) if line else []
        for pat, act in rules:
            # Evaluate pattern
            if pat:
                if pat.startswith("/") and pat.endswith("/"):
                    if not re.search(pat[1:-1], line): continue
                elif pat.startswith("NR"):
                    m = re.match(r'NR\s*(<=|>=|<|>|==)\s*(\d+)', pat.replace(" ",""))
                    if m:
                        op, val = m.group(1), int(m.group(2))
                        cond = {"<=": nr<=val, ">=": nr>=val, "<": nr<val, ">": nr>val, "==": nr==val}.get(op, False)
                        if not cond: continue
                else:
                    # skip complex patterns
                    pass
            out = _awk_print(act, fields, nr, line)
            if out is not None:
                io.write(out, newline=True)
    # Execute END
    for ea in end_actions:
        out = _awk_print(ea, [], 0, "")
        if out is not None:
            io.write(out, newline=True)
    return 0

# ---- sed: enhanced with addresses, d, s (backrefs), p, -n ----------
def _sed_substitute(line, pat, repl, flags):
    r"""Perform s/pattern/replacement/flags on line, supporting & and \1..\9."""
    def _repl(m):
        text = repl
        text = text.replace("&", m.group(0))
        for i in range(1, 10):
            text = text.replace(f"\\{i}", m.group(i) if i <= len(m.groups()) else "")
        return text
    gflag = "g" in flags
    count = 0 if gflag else 1
    try:
        compiled = re.compile(pat)
        return compiled.sub(_repl, line, count=count)
    except:
        return line

@register_command("sed")
async def cmd_sed(argv, st, io):
    if len(argv) < 2: return 2
    silent = False
    scripts = []
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "-n":
            silent = True
            i += 1
            continue
        if a == "-e":
            if i+1 < len(argv):
                scripts.append(argv[i+1])
                i += 2
            else:
                io.write_err("sed: -e requires argument"); return 2
            continue
        # assume it's a script or filename
        scripts.append(a)
        i += 1
        break
    # rest are filenames
    filenames = argv[i:] if i < len(argv) else []
    # If no explicit script, the first non-option becomes script
    if not scripts:
        scripts = [argv[1]]
        filenames = argv[2:]
    # Combine scripts separated by ';'
    all_commands = []
    for s in scripts:
        # Split by ';' respecting braces (simplified)
        parts = s.split(";")
        all_commands.extend([p.strip() for p in parts if p.strip()])

    data = ""
    if filenames:
        for fn in filenames:
            data += await _read_file_or_empty(vrel(await resolve_path(st, fn)))
    else:
        data = io.stdin_text or ""
    lines = data.split("\n")
    # Process line by line, maintain hold space etc. (simplified)
    out_lines = []
    # For now we support only s/// and d, with optional address prefix
    for line in lines:
        # Apply commands sequentially? Real sed applies all commands to the line.
        # We'll apply first matching command and break?
        # Simplified: each command is either a substitution or delete with address.
        skip_output = False
        for cmd in all_commands:
            addr = ""
            rest_cmd = cmd
            # Extract address pattern (e.g., 1,3 s/... or /re/ d)
            m = re.match(r'^(/(?:[^/\\]|\\.)*/|\d+)\s*(.*)', cmd)
            if m:
                addr = m.group(1)
                rest_cmd = m.group(2)
            # Evaluate address
            if addr:
                # Line number
                if addr.isdigit():
                    if lines.index(line)+1 != int(addr): continue
                else:
                    # regex address
                    if not re.search(addr[1:-1], line): continue
            # Now rest_cmd is command
            if rest_cmd.startswith("s"):
                # s/pat/repl/flags
                parts = rest_cmd[1:].split(rest_cmd[1], 3)
                if len(parts) >= 3:
                    pat, repl, flags = parts[0], parts[1], parts[2] if len(parts)>2 else ""
                    line = _sed_substitute(line, pat, repl, flags)
            elif rest_cmd == "d":
                skip_output = True
                break
            elif rest_cmd == "p":
                if silent:
                    io.write(line, newline=True)
            # other commands ignored
        if not skip_output:
            out_lines.append(line)
    if not silent:
        io.write("\n".join(out_lines) + ("\n" if out_lines else ""))
    return 0

# ---- sort, tr, basename, dirname, xargs (minimal) ------------------
@register_command("sort")
async def cmd_sort(argv, st, io):
    data = io.stdin_text
    if len(argv) > 1:
        filename = argv[1]
        data = await _read_file_or_empty(vrel(await resolve_path(st, filename)))
    lines = data.split("\n")
    sorted_lines = sorted(lines)
    io.write("\n".join(sorted_lines) + ("\n" if sorted_lines else ""))
    return 0

@register_command("tr")
async def cmd_tr(argv, st, io):
    if len(argv) < 3: return 2
    set1, set2 = argv[1], argv[2]
    data = io.stdin_text
    trans = str.maketrans(set1, set2)
    io.write(data.translate(trans))
    return 0

@register_command("basename")
async def cmd_basename(argv, st, io):
    if len(argv) < 2: return 1
    path = argv[1]
    suffix = argv[2] if len(argv) > 2 else ""
    name = path.strip("/").split("/")[-1]
    if suffix and name.endswith(suffix):
        name = name[:-len(suffix)]
    io.write(name, newline=True)
    return 0

@register_command("dirname")
async def cmd_dirname(argv, st, io):
    if len(argv) < 2: return 1
    path = argv[1].rstrip("/")
    if "/" not in path:
        io.write(".")
    else:
        io.write(path.rsplit("/",1)[0] or "/")
    io.write(newline=True)
    return 0

@register_command("xargs")
async def cmd_xargs(argv, st, io):
    # minimal: xargs command [args...] reads stdin and appends arguments
    if len(argv) < 2: return 2
    command = argv[1]
    extra_args = argv[2:]
    data = io.stdin_text.strip()
    if not data: return 0
    # split by whitespace
    args = data.split()
    if not args: return 0
    # Run command for each argument (simplified)
    for arg in args:
        new_argv = [command] + extra_args + [arg]
        sub_io = IO("", io.capture_stdout)
        exit_code = await dispatch(command, new_argv, st, sub_io)
        if io.capture_stdout:
            io.write(sub_io.stdout_text())
        if exit_code != 0:
            return exit_code
    return 0

# ---- curl ----------------------------------------------------------
def _parse_curl_args(args: List[str], stdin_text: str):
    silent = False
    method = "GET"
    body: Optional[str] = None
    headers: Dict[str,str] = {}
    out_path: Optional[str] = None
    urls = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "-s": silent=True; i+=1; continue
        if a == "-o" and i+1<len(args): out_path=args[i+1]; i+=2; continue
        if a == "-X" and i+1<len(args): method=args[i+1].upper(); i+=2; continue
        if a == "-d" and i+1<len(args):
            body=args[i+1]
            if body=="@-": body=stdin_text
            i+=2; continue
        if a == "-H" and i+1<len(args):
            h=args[i+1]
            if ":" in h:
                k,v = h.split(":",1)
                k=k.strip(); v=v.strip()
                if k in headers: headers[k]+=", "+v
                else: headers[k]=v
            i+=2; continue
        if a.startswith(("http://","https://")): urls.append(a); i+=1; continue
        i+=1
    return silent, method, body, headers, out_path, urls

@register_command("curl")
async def cmd_curl(argv, st, io):
    silent, method, body, headers, out_path, urls = _parse_curl_args(argv[1:], io.stdin_text)
    if not urls: io.write_err("curl: missing URL"); return 2
    url = urls[0]
    try:
        r = await laika_http_request(url, method=method, headers=headers if headers else None, body=body)
        blob = r.get("body") if isinstance(r.get("body"),str) else json.dumps(r, ensure_ascii=False)
        if out_path:
            await laika_write_file(vrel(await resolve_path(st, out_path)), blob)
            if not silent: io.write(f"saved {out_path}", newline=True)
        else:
            if not silent: io.write(blob, newline=isinstance(blob,str) and blob.endswith("\n"))
    except Exception as e: io.write_err(str(e)); return 1
    return 0

# ---- browser commands (unchanged) -----------------------------------
@register_command("browser-login")
async def cmd_browser_login(argv, st, io):
    urls = [a for a in argv[1:] if a.startswith(("http://","https://"))]
    if len(urls)!=1: io.write_err("browser-login: one URL required"); return 2
    try:
        await laika_browser_open_login(urls[0])
        io.write("login window opened", newline=True)
    except Exception as e: io.write_err(str(e)); return 1
    return 0

@register_command("browser-html")
async def cmd_browser_html(argv, st, io):
    args = argv[1:]; wait="load"; urls=[]
    i=0
    while i<len(args):
        a=args[i]
        if a=="--wait" and i+1<len(args):
            wait=args[i+1]
            if wait not in _BROWSER_WAIT: io.write_err("browser-html: invalid wait"); return 2
            i+=2; continue
        if a.startswith(("http://","https://")): urls.append(a)
        i+=1
    if len(urls)!=1: io.write_err("browser-html: one URL required"); return 2
    try:
        html = await laika_browser_get_html(urls[0], wait_until=wait)
        io.write(html)
    except Exception as e: io.write_err(str(e)); return 1
    return 0

@register_command("browser-md")
async def cmd_browser_md(argv, st, io):
    args = argv[1:]; wait="load"; mode="readability"
    if "--full" in args: mode="full"; args = [a for a in args if a!="--full"]
    urls=[]
    i=0
    while i<len(args):
        a=args[i]
        if a=="--wait" and i+1<len(args):
            wait=args[i+1]
            if wait not in _BROWSER_WAIT: io.write_err("browser-md: invalid wait"); return 2
            i+=2; continue
        if a.startswith(("http://","https://")): urls.append(a)
        i+=1
    if len(urls)!=1: io.write_err("browser-md: one URL required"); return 2
    try:
        md = await laika_browser_get_markdown(urls[0], wait_until=wait, mode=mode)
        io.write(md, newline=md.endswith("\n"))
    except Exception as e: io.write_err(str(e)); return 1
    return 0

# -----------------------------------------------------------------------------
# Entry point
# -----------------------------------------------------------------------------
async def laika_run_shell(src: str) -> int:
    if not src or not src.strip():
        return 0
    st = get_session()
    if len(src) > MAX_SHELL_SOURCE_CHARS:
        print(
            f"laika_shell: script exceeds maximum length ({len(src)} > {MAX_SHELL_SOURCE_CHARS})",
            file=sys.stderr,
            flush=True,
        )
        st.last_exit_code = 2
        return 2
    try:
        trees = bashlex.parse(src)
    except Exception as e:
        print(f"bashlex: {e}", file=sys.stderr, flush=True)
        st.last_exit_code = 2
        return 2
    exit_code = 0
    io = IO()
    for tree in trees:
        try:
            exit_code = await run_ast(tree, st, io)
        except SystemExit as e:
            c = e.code
            exit_code = 0 if c is None else (c if isinstance(c, int) else 1)
            break
        except Exception as e:
            print(f"laika_shell: {e}", file=sys.stderr, flush=True)
            exit_code = 2
            st.last_exit_code = 2
            break
    return exit_code