# 在 Laika 笔记本里整段粘贴到一个单元格运行（依赖内核已注入 laika_http_get、已装 beautifulsoup4）。
# 从起始 URL 同域名 BFS 爬链接，每页只抓一次，收集 { 规范化 URL -> title }。

from __future__ import annotations

from collections import deque
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup


def _normalize_url(url: str) -> str:
    """去掉 fragment；路径统一（避免 /a 与 /a/ 重复排队）。"""
    p = urlparse(url.strip())
    if p.scheme not in ("http", "https") or not p.netloc:
        return url.strip()
    path = (p.path or "/").rstrip("/") or "/"
    q = ("?" + p.query) if p.query else ""
    return f"{p.scheme}://{p.netloc}{path}{q}"


async def _fetch_title_and_links(page_url: str, base_netloc: str) -> tuple[str, set[str]]:
    r = await laika_http_get(page_url)
    if r["status"] != 200:
        return "", set()

    soup = BeautifulSoup(r["body"], "html.parser")
    t = soup.find("title")
    title = t.get_text(strip=True) if t else ""

    out: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = (a.get("href") or "").strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        abs_u = urljoin(page_url, href)
        q = urlparse(abs_u)
        if q.scheme not in ("http", "https") or q.netloc != base_netloc:
            continue
        out.add(_normalize_url(abs_u))

    return title, out


async def crawl_domain_titles(start_url: str, max_pages: int = 80) -> dict[str, str]:
    """
    从 start_url 开始，在同 netloc 内沿 <a href> BFS；已访问过的 URL 不再请求。
    返回 dict[url, title]（仅对实际发出 GET 的 URL 记录 title，失败或非 200 时 title 可能为空字符串）。
    """
    start = _normalize_url(start_url)
    p0 = urlparse(start)
    if p0.scheme not in ("http", "https") or not p0.netloc:
        raise ValueError("start_url 必须是带域名的 http(s) 绝对地址")

    base_netloc = p0.netloc
    seen: set[str] = set()
    q: deque[str] = deque()
    q.append(start)
    seen.add(start)

    titles: dict[str, str] = {}
    fetched = 0

    while q and fetched < max_pages:
        url = q.popleft()
        title, links = await _fetch_title_and_links(url, base_netloc)
        fetched += 1
        titles[url] = title
        # 边爬边打（每页一次 await 后会回到事件循环，stdout 才能及时送到 UI）
        print(title or "(no title)", "|", url, flush=True)

        for u in links:
            if u not in seen:
                seen.add(u)
                q.append(u)

    return titles


# ---- 用法（笔记本里）：----
#
# START = "https://example.com"
# result = await crawl_domain_titles(START, max_pages=50)
# （上面函数体内已随爬随打印；若要静默爬取再在末尾统一打印，需自己改函数或另写包装）
