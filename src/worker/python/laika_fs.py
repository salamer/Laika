"""工作区异步文件原语，贴近 ``os`` 常用语义（路径均相对工作区根；``getcwd()=='.'``）。

二进制由宿主经 Base64 传输，在此处为 ``bytes``；PDF/docx/xlsx 等请 ``import io`` 后自用预装库处理。
"""
from __future__ import annotations

import posixpath
import stat as stat_mod
import sys
import types
from types import SimpleNamespace

_laika_mod = types.ModuleType("laika_fs")


def getcwd() -> str:
    """工作区虚拟当前目录（不等同宿主 ``os.getcwd``）。"""
    return "."


def abspath(rel: str) -> str:
    """虚路径规范化（相对于工作区根 ``'.'``）。"""
    return posixpath.normpath(posixpath.join(getcwd(), rel))


def joinpath(*parts: str) -> str:
    """等价 ``os.path.join`` + ``normpath``（POSIX 语义）。"""
    return posixpath.normpath(posixpath.join(*parts))


async def laika_stat_fs(path: str) -> SimpleNamespace:
    d = await laika_stat_dict(path)
    mode = (
        stat_mod.S_IFDIR | 0o755 if d["is_directory"] else stat_mod.S_IFREG | 0o644
    )
    mt = float(d["modified_ms"]) / 1000.0
    return SimpleNamespace(
        st_mode=mode,
        st_size=int(d["size"]),
        st_mtime=mt,
        st_atime=mt,
        st_ctime=mt,
        st_ino=0,
        st_dev=0,
        st_nlink=1,
        st_uid=0,
        st_gid=0,
    )


async def exists(path: str) -> bool:
    try:
        await laika_stat_dict(path)
        return True
    except BaseException:
        return False


async def listdir(path: str = ".") -> list[str]:
    rows = await laika_list_files(path)
    return sorted(r["name"] for r in rows)


async def read_bytes(rel: str) -> bytes:
    return await laika_read_file_bytes(rel)


async def write_bytes(rel: str, data: bytes) -> None:
    await laika_write_file_bytes(rel, data)


async def read_text(rel: str, encoding: str = "utf-8") -> str:
    if encoding.casefold() != "utf-8".casefold():
        raise ValueError("read_text: 宿主 IPC 当前仅 UTF-8 文本")
    return await laika_read_file(rel)


async def write_text(rel: str, text: str, encoding: str = "utf-8") -> None:
    if encoding.casefold() != "utf-8".casefold():
        raise ValueError("write_text: 宿主 IPC 当前仅 UTF-8 文本")
    await laika_write_file(rel, text)


async def mkdir(rel: str, mode: int = 0o777, *, exist_ok: bool = False) -> None:
    del mode  # 宿主权限由系统决定；预留参数对齐 os.mkdir 签名。
    if await exists(rel):
        st = await laika_stat_fs(rel)
        if not stat_mod.S_ISDIR(st.st_mode):
            raise FileExistsError(rel)
        if not exist_ok:
            raise FileExistsError(rel)
        return
    await laika_mkdir(rel)


async def unlink(rel: str) -> None:
    st = await laika_stat_fs(rel)
    if stat_mod.S_ISDIR(st.st_mode):
        raise IsADirectoryError(rel)
    await laika_delete_file(rel, False)


async def rmdir(rel: str) -> None:
    st = await laika_stat_fs(rel)
    if not stat_mod.S_ISDIR(st.st_mode):
        raise NotADirectoryError(rel)
    await laika_delete_file(rel, False)


async def remove(rel: str) -> None:
    await unlink(rel)


async def rmtree(rel: str) -> None:
    await laika_delete_file(rel, True)


_laika_mod.getcwd = getcwd
_laika_mod.abspath = abspath
_laika_mod.joinpath = joinpath
_laika_mod.stat = laika_stat_fs
_laika_mod.exists = exists
_laika_mod.listdir = listdir
_laika_mod.read_bytes = read_bytes
_laika_mod.write_bytes = write_bytes
_laika_mod.read_text = read_text
_laika_mod.write_text = write_text
_laika_mod.mkdir = mkdir
_laika_mod.unlink = unlink
_laika_mod.rmdir = rmdir
_laika_mod.remove = remove
_laika_mod.rmtree = rmtree

sys.modules["laika_fs"] = _laika_mod
