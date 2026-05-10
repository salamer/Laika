#!/usr/bin/env python3
"""
Laika Shell 回归测试 — 覆盖类似大模型输出的 Bash 片段。
依赖: pip install bashlex

运行（仓库根目录）:
  python3 src/worker/python/shell_llm_fixture_tests.py
"""

from __future__ import annotations

import importlib.util
import posixpath
import re
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest.mock import patch


def _load_laika_shell():
    root = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location("laika_shell", root / "laika_shell.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    # 须先注册到 sys.modules，否则 @dataclass 在部分 Python 版本下解析注解会失败
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_LS = _load_laika_shell()


class MemFS:
    """工作区：相对路径（如 docs/a.txt），根为 ."""

    def __init__(self) -> None:
        self.dirs: set[str] = {"."}
        self.files: Dict[str, str] = {}

    def _pn(self, p: str) -> str:
        p = (p or ".").strip()
        if p in (".", ""):
            return "."
        return posixpath.normpath(p)

    def _ensure_parent_dirs(self, path: str) -> None:
        if path in (".", ""):
            return
        par = posixpath.dirname(path)
        if par not in ("", "."):
            self.dirs.add(par)
            self._ensure_parent_dirs(par)
        self.dirs.add(".")

    def seed(self, layout: Dict[str, str]) -> None:
        for k, v in layout.items():
            key = self._pn(k.rstrip("/"))
            if k.endswith("/") or v == "<<DIR>>":
                self.dirs.add(key)
                self._ensure_parent_dirs(key)
            else:
                self._ensure_parent_dirs(key)
                self.files[key] = v

    async def read_file(self, path: str) -> str:
        key = self._pn(path)
        if key in self.dirs and key not in self.files:
            raise IsADirectoryError(key)
        if key not in self.files:
            raise FileNotFoundError(key)
        return self.files[key]

    async def write_file(self, path: str, content: str) -> None:
        key = self._pn(path)
        self._ensure_parent_dirs(key)
        self.dirs.discard(key)
        self.files[key] = content

    async def mkdir(self, path: str) -> None:
        key = self._pn(path)
        self._ensure_parent_dirs(key)
        self.dirs.add(key)

    async def list_files(self, path: str = ".") -> List[Dict[str, Any]]:
        base = self._pn(path)
        if base not in self.dirs:
            raise FileNotFoundError(base)
        prefix = "" if base == "." else base + "/"
        rows: Dict[str, Dict[str, Any]] = {}

        for d in self.dirs:
            if d in (".", base):
                continue
            par = posixpath.dirname(d)
            par = "." if par == "" else par
            if par != base:
                continue
            nm = posixpath.basename(d)
            rp = nm if base == "." else prefix + nm
            rows[nm] = {"name": nm, "path": rp, "isDirectory": True, "size": 0, "modified": 0}

        for fk, body in self.files.items():
            par = posixpath.dirname(fk)
            par = "." if par == "" else par
            if par != base:
                continue
            nm = posixpath.basename(fk)
            rp = fk if fk == nm or fk.startswith(prefix) else (prefix + nm)
            prev = rows.get(nm)
            if prev:
                prev["isDirectory"] = False
                prev["size"] = len(body)
            else:
                rows[nm] = {"name": nm, "path": rp, "isDirectory": False, "size": len(body), "modified": 0}

        return sorted(rows.values(), key=lambda r: str(r["name"]))

    async def delete_file(self, path: str, recursive: bool = False) -> None:
        key = self._pn(path)
        if recursive:
            for fk in list(self.files.keys()):
                if fk == key or fk.startswith(key + "/"):
                    del self.files[fk]
            for dk in list(self.dirs):
                if dk == key or dk.startswith(key + "/"):
                    if dk != ".":
                        self.dirs.discard(dk)
            return
        if key in self.files:
            del self.files[key]
            return
        if key in self.dirs:
            kids = await self.list_files(key)
            if kids:
                raise OSError("directory not empty")
            self.dirs.discard(key)
            return
        raise FileNotFoundError(key)


def attach_mocks(fs: MemFS, http_fn: Optional[Callable] = None) -> None:
    async def laika_read_file(p: str) -> str:
        return await fs.read_file(p)

    async def laika_write_file(p: str, c: str) -> None:
        await fs.write_file(p, c)

    async def laika_mkdir(p: str) -> None:
        await fs.mkdir(p)

    async def laika_list_files(p: str = ".") -> List[Dict[str, Any]]:
        return await fs.list_files(p or ".")

    async def laika_delete_file(p: str, recursive: bool = False) -> None:
        await fs.delete_file(p, recursive)

    async def laika_http_request(url, method="GET", headers=None, body=None):
        if http_fn:
            return await http_fn(url, method, headers, body)
        return {"status": 200, "statusText": "OK", "headers": {}, "body": '{"ok":true}', "requestId": "t"}

    async def laika_browser_get_html(url: str, wait_until: str = "load", timeout_ms: int = 60000) -> str:
        return f"<html><body data-u=\"{url}\"></body></html>"

    async def laika_browser_get_markdown(
        url: str, wait_until: str = "load", timeout_ms: int = 60000, mode: str = "readability"
    ) -> str:
        return f"# page\n\n- {mode}: {url}\n"

    async def laika_browser_evaluate(url: str, script: str, wait_until: str = "load", timeout_ms: int = 60000):
        return {"url": url, "scriptLen": len(script)}

    async def laika_browser_open_login(url: str) -> None:
        pass

    _LS.laika_read_file = laika_read_file  # type: ignore[attr-defined]
    _LS.laika_write_file = laika_write_file  # type: ignore[attr-defined]
    _LS.laika_mkdir = laika_mkdir  # type: ignore[attr-defined]
    _LS.laika_list_files = laika_list_files  # type: ignore[attr-defined]
    _LS.laika_delete_file = laika_delete_file  # type: ignore[attr-defined]
    _LS.laika_http_request = laika_http_request  # type: ignore[attr-defined]
    _LS.laika_browser_get_html = laika_browser_get_html  # type: ignore[attr-defined]
    _LS.laika_browser_get_markdown = laika_browser_get_markdown  # type: ignore[attr-defined]
    _LS.laika_browser_evaluate = laika_browser_evaluate  # type: ignore[attr-defined]
    _LS.laika_browser_open_login = laika_browser_open_login  # type: ignore[attr-defined]


async def run_case(
    script: str,
    fs: MemFS,
) -> Tuple[int, str, str]:
    out: List[str] = []
    err: List[str] = []

    def fake_print(*a: Any, **kw: Any) -> None:
        end = kw.get("end", "\n")
        sep = kw.get("sep", " ")
        s = sep.join(str(x) for x in a) + end
        if kw.get("file") is sys.stderr:
            err.append(s)
        else:
            out.append(s)

    attach_mocks(fs)
    await _LS.laika_reset_shell_session()
    with patch("builtins.print", side_effect=fake_print):
        code = await _LS.laika_run_shell(script)
    return int(code), "".join(out), "".join(err)


DEFAULT_SEED: Dict[str, str] = {
    "README.md": "# project\n",
    "docs/page.md": "## body\n",
    "data/log.txt": "go\nstay\ngo\ndo not go\n",
    "src/main.py": "print('x')\n",
}


def build_cases() -> List[Dict[str, Any]]:
    """多行 / 链式 / 重定向 — 风格接近常见「模型生成」的 Bash 片段。"""
    return [
        # 基础与链
        {"name": "echo_and_ls", "script": 'echo "hello world" && ls', "exit": 0, "out_rx": r"hello world"},
        {"name": "echo_quiet_newline", "script": "echo -n test && echo done", "exit": 0, "out_rx": r"testdone"},
        # 不带引号的 $…，避免 bashlex 的双引号词位置与 `.word` 去引号后切片错位。
        {"name": "semicolon_exports", "script": "export Foo=alpha; export Bar=beta; echo $Foo:$Bar", "exit": 0, "out_rx": r"alpha:beta"},
        {"name": "triple_semicolon", "script": "pwd; echo mid; ls", "exit": 0, "out_rx": r"mid"},
        {"name": "logical_and_short", "script": "true && echo ok", "exit": 0, "out_rx": r"\bok\b"},
        {"name": "logical_or_recover", "script": "false || echo recovered", "exit": 0, "out_rx": r"recovered"},
        {"name": "logical_and_fail", "script": "false && echo never", "exit": 1, "out_rx": None},
        {"name": "mixed_and_or", "script": "false || true && echo stepped", "exit": 0, "out_rx": r"stepped"},
        {"name": "chain_long", "script": "echo a && echo b || echo c && echo d", "exit": 0, "out_rx": r"a\W+b\W+d"},
        # 环境变量
        {"name": "env_and_printenv", "script": "export PLAN=weekly; printenv PLAN", "exit": 0, "out_rx": r"weekly"},
        {"name": "export_prefix_cmd", "script": 'export NAME=laika; export; printenv NAME', "exit": 0, "out_rx": r"NAME=laika"},
        {"name": "unset_missing_printenv", "script": "unset NOTSET_X; printenv NOTSET_X", "exit": 1, "err_needle": "not set"},
        {"name": "slash_after_var", "script": "export K=path; echo $K/to/file", "exit": 0, "out_rx": r"path/to/file"},
        # 管道与重定向
        {"name": "pipe_head", "script": "cat data/log.txt | head -n 2", "exit": 0, "out_rx": r"go\nstay"},
        {"name": "pipe_grep", "script": "grep stay data/log.txt | head -n 1", "exit": 0, "out_rx": r"stay"},
        {"name": "pipe_wc", "script": "cat data/log.txt | wc -l", "exit": 0, "out_rx": r"\b4\b"},
        {"name": "redirect_out_cat", "script": "echo sandbox > notes.txt && cat notes.txt", "exit": 0, "out_rx": r"sandbox"},
        {"name": "redirect_append", "script": 'echo one > t.log; echo two >> t.log; wc -l t.log', "exit": 0, "out_rx": r"\b2\b"},
        {"name": "stdin_redirect", "script": "grep stay < data/log.txt", "exit": 0, "out_rx": r"stay"},
        # 命令替换 / 条件
        {"name": "cmd_subst_echo", "script": 'echo "$(echo nested)"', "exit": 0, "out_rx": r"nested"},
        {"name": "if_then_fi", "script": "if true; then echo OK; fi", "exit": 0, "out_rx": r"OK"},
        {"name": "if_false_skip", "script": "if false; then echo BAD; fi", "exit": 0, "out_rx": None},
        {"name": "if_two_echoes_one_line", "script": "if true; then echo line1; echo line2; fi", "exit": 0, "out_rx": r"line1\W+line2"},
        # 文件工具
        {"name": "grep_anchored", "script": 'grep "^go$" data/log.txt', "exit": 0, "out_rx": r"go"},
        {"name": "wc_lines_file", "script": "wc -l data/log.txt", "exit": 0, "out_rx": r"^4\t"},
        {"name": "tail_file", "script": "tail -n 2 data/log.txt", "exit": 0, "out_rx": r"go\ndo not go"},
        {"name": "mkdir_touch_ls", "script": "mkdir build && touch build/out.txt && ls build", "exit": 0, "out_rx": r"out.txt"},
        {"name": "cd_ls", "script": "cd docs && ls", "exit": 0, "out_rx": r"page.md"},
        {"name": "cp_file", "script": "cp README.md README_copy.md && wc -l README_copy.md", "exit": 0, "out_rx": r"\b1\b"},
        {"name": "mv_file", "script": 'echo moved > old.txt && mv old.txt new.txt && cat new.txt', "exit": 0, "out_rx": r"moved"},
        {"name": "mv_rename_roundtrip", "script": 'echo x > _a && mv _a _b && cat _b', "exit": 0, "out_rx": r"x"},
        {"name": "rm_file", "script": "touch kill.me && rm kill.me && ls", "exit": 0, "out_rx": r"README"},
        {"name": "rmdir_empty", "script": "mkdir empty_dir && rmdir empty_dir && echo gone", "exit": 0, "out_rx": r"gone"},
        {"name": "sed_pipe", "script": "echo HELLO | sed 's/HELLO/hi/'", "exit": 0, "out_rx": r"hi"},
        {"name": "awk_fields", "script": "awk '{print $1}' data/log.txt | head -n 1", "exit": 0, "out_rx": r"go"},
        {"name": "curl_silent", "script": "curl -s https://example.com/api", "exit": 0, "out_rx": None},
        {"name": "exit_status_subst", "script": 'false || true; echo "code=$?"', "exit": 0, "out_rx": r"code=0"},
        {"name": "grep_ignore_case", "script": "grep -i STAY data/log.txt", "exit": 0, "out_rx": r"stay"},
        {
            "name": "sed_line_number",
            "script": "sed 2 lines.txt",
            "exit": 0,
            "out_rx": r"^b$",
            "seed": {"lines.txt": "a\nb\nc\n"},
        },
        {"name": "sleep_zero", "script": "sleep 0", "exit": 0, "out_rx": None},
        {"name": "help", "script": "help", "exit": 0, "out_rx": r"bashlex"},
        {"name": "assignment_then_echo", "script": " export ZZ=99 ; echo $ZZ ", "exit": 0, "out_rx": r"\b99\b"},
    ]


async def seed_and_run(case: Dict[str, Any]) -> Tuple[int, str, str]:
    fs = MemFS()
    seed = dict(DEFAULT_SEED)
    seed.update(case.get("seed") or {})
    fs.seed(seed)
    script = case["script"]
    return await run_case(script.strip(), fs)


async def main() -> int:
    failed = 0
    cases = build_cases()
    for c in cases:
        name = c["name"]
        exp = int(c["exit"])
        rx_out = c.get("out_rx")
        needle_err = c.get("err_needle")
        code, sout, serr = await seed_and_run(c)
        ok = code == exp
        if rx_out:
            ok = ok and bool(re.search(rx_out, sout, re.DOTALL))
        if needle_err:
            ok = ok and needle_err in serr
        if not ok:
            failed += 1
            sys.stderr.write(
                f"[FAIL] {name}\n  exit expected {exp} got {code}\n"
                f"  stdout:{sout[:800]!r}\n"
                f"  stderr:{serr[:800]!r}\n"
            )
            if rx_out:
                sys.stderr.write(f"  expected stdout ~ /{rx_out}/\n")
    if failed == 0:
        print(f"shell_llm_fixture_tests: OK ({len(cases)} cases)")
    else:
        print(f"shell_llm_fixture_tests: {failed} failed", file=sys.stderr)
    return failed


if __name__ == "__main__":
    import asyncio

    sys.exit(asyncio.run(main()))
