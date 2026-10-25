"""毎日の自動学習。GitHub Actions から 1 日 1 回呼ばれる (.github/workflows/daily.yml)。

1. feeds.txt に書いた RSS / Atom から新しい記事 (見出しと要約) を集める
2. きのうまでのちいさなGPTを、集めた文章で続きから学習させる
3. 工房・チャット・学習結果をまとめて、公開するサイトのフォルダ (_site) を作る

きのうまでの記事とモデルは、公開中のサイト (--site) から読み戻すので、リポジトリには何も書き込まない。

    python auto/daily.py --site https://あなたの名前.github.io/webweb/ --out _site
    python auto/daily.py --state 前回の_site --out _site --minutes 2   # 手元で試す
"""

import argparse
import datetime as dt
import email.utils
import html
import json
import pathlib
import re
import shutil
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "colab"))

UA = "webweb-tiny-gpt/1.0 (+https://github.com/Wasabi-wa619/webweb)"
MAX_ARTICLES = 5000      # 残しておく記事の数 (古いものから捨てる)
MAX_TRAIN_CHARS = 1_500_000
SUMMARY_CHARS = 400


# ---------- 記事を集める ----------
class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, d):
        self.parts.append(d)


def plain(s):
    """HTML のタグを外して、空白をまとめる。"""
    if not s:
        return ""
    p = _Text()
    p.feed(html.unescape(s) if "&lt;" in s else s)
    return re.sub(r"\s+", " ", html.unescape("".join(p.parts))).strip()


def _local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def _date(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = email.utils.parsedate_to_datetime(s)  # RSS 2.0 (RFC 822)
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))  # Atom・RSS 1.0 (ISO 8601)
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def parse_feed(raw):
    """RSS 2.0・RSS 1.0 (RDF)・Atom を読んで、(フィード名, 記事のリスト) を返す。"""
    m = re.match(rb'^\s*<\?xml[^>]*encoding=["\']([\w.-]+)["\']', raw)
    text = raw.decode(m.group(1).decode() if m else "utf-8", errors="replace")
    text = re.sub(r"^\s*<\?xml[^>]*\?>", "", text)  # 文字コードの宣言は ElementTree が嫌うので外す
    root = ET.fromstring(text)
    title = ""
    for el in root.iter():
        if _local(el.tag) in ("channel", "feed"):
            for c in el:
                if _local(c.tag) == "title":
                    title = plain(c.text)
                    break
            break
    items = []
    for el in root.iter():
        if _local(el.tag) not in ("item", "entry"):
            continue
        f = {}
        for c in el:
            name = _local(c.tag)
            if name == "link":
                href = c.get("href")
                if href and c.get("rel", "alternate") == "alternate":
                    f.setdefault("link", href)
                elif c.text and c.text.strip():
                    f.setdefault("link", c.text.strip())
            elif name in ("title", "description", "summary", "encoded", "content"):
                f.setdefault(name, "".join(c.itertext()))
            elif name in ("pubdate", "date", "published", "updated", "issued"):
                f.setdefault("date", c.text)
        link = f.get("link") or el.get("{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about")
        t = plain(f.get("title"))
        if not link or not t:
            continue
        summary = plain(f.get("description") or f.get("summary") or f.get("encoded") or f.get("content"))
        items.append({"t": t, "s": summary[:SUMMARY_CHARS], "u": link, "d": _date(f.get("date"))})
    return title, items


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def read_feeds(path):
    urls = []
    for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            urls.append(line)
    return urls


def collect(urls, old, now, log=print, fetcher=fetch):
    """新しい記事だけを足す。同じ URL の記事は足さない。"""
    seen = {a["u"] for a in old}
    new, report = [], []
    for url in urls:
        try:
            title, items = parse_feed(fetcher(url))
            fresh = [dict(a, src=title or url, got=now) for a in items if a["u"] not in seen]
            for a in fresh:
                seen.add(a["u"])
            new += fresh
            report.append({"url": url, "title": title, "ok": True, "items": len(items), "new": len(fresh)})
            log(f"  {title or url}: {len(items)} 件 (新しい記事 {len(fresh)})")
        except Exception as e:  # 1 つのフィードが落ちていても、ほかは続ける
            report.append({"url": url, "ok": False, "error": f"{type(e).__name__}: {e}"[:200]})
            log(f"  {url}: 読めませんでした ({type(e).__name__}: {e})")
        time.sleep(1)  # 相手のサーバーに負担をかけない
    articles = old + new
    articles.sort(key=lambda a: a.get("d") or a.get("got") or "", reverse=True)
    return articles[:MAX_ARTICLES], new, report


def corpus(articles):
    """学習用の文章。古い順に「見出し」「要約」を空行で区切って並べる。"""
    parts, total = [], 0
    for a in articles:  # 新しい順に、上限まで
        block = a["t"] + "\n" + a["s"] + "\n\n" if a["s"] else a["t"] + "\n\n"
        if total + len(block) > MAX_TRAIN_CHARS:
            break
        parts.append(block)
        total += len(block)
    return "".join(reversed(parts))


# ---------- 前回の状態 ----------
def load_previous(site=None, state=None, log=print):
    """前回公開した記事・モデル・記録を読み戻す。最初の回や読めないときは空から始める。"""
    def get(name):
        try:
            if state:
                return (pathlib.Path(state) / "auto" / name).read_bytes()
            if site:
                return fetch(site.rstrip("/") + "/auto/" + name, timeout=60)
        except Exception as e:
            log(f"  前回の {name} は読めませんでした ({type(e).__name__})。新しく始めます")
        return None

    raw = {n: get(n) for n in ("articles.json", "tiny_gpt.json", "status.json")}
    articles = json.loads(raw["articles.json"]) if raw["articles.json"] else []
    status = json.loads(raw["status.json"]) if raw["status.json"] else {}
    return articles, raw["tiny_gpt.json"], status


# ---------- サイトを組み立てる ----------
def build_site(out):
    out = pathlib.Path(out)
    if out.exists():
        shutil.rmtree(out)
    (out / "auto").mkdir(parents=True)
    for f in ("gpt.js", "sample.txt", "sample_qa.txt"):
        shutil.copy(ROOT / f, out / f)
    # index.html は claude.ai の Artifact にもそのまま載せられるよう、doctype を書いていない。
    # GitHub Pages では標準モードで表示されるよう、ここで付ける
    page = (ROOT / "index.html").read_text(encoding="utf-8")
    (out / "index.html").write_text('<!doctype html>\n<html lang="ja">\n' + page + "\n</html>\n", encoding="utf-8")
    shutil.copytree(ROOT / "chat", out / "chat")
    (out / ".nojekyll").write_text("")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", help="公開中のサイトの URL (前回の結果を読み戻す)")
    ap.add_argument("--state", help="前回の _site フォルダ (手元で試すとき)")
    ap.add_argument("--feeds", default=str(ROOT / "feeds.txt"))
    ap.add_argument("--out", default="_site")
    ap.add_argument("--minutes", type=float, default=25, help="学習に使う時間の上限")
    ap.add_argument("--steps", type=int, default=3000, help="学習のステップ数の上限")
    a = ap.parse_args()

    import torch
    import tiny_gpt as tg

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    print("前回の結果を読み戻しています…")
    old, model_raw, status = load_previous(a.site, a.state)
    print(f"  これまでの記事 {len(old)} 件 / 前回のモデル {'あり' if model_raw else 'なし'}")

    print("フィードから記事を集めています…")
    articles, new, report = collect(read_feeds(a.feeds), old, now)
    print(f"  新しい記事 {len(new)} 件 / 合計 {len(articles)} 件")

    out = build_site(a.out)
    (out / "auto" / "articles.json").write_text(json.dumps(articles, ensure_ascii=False), encoding="utf-8")

    text = corpus(articles)
    run = {"date": now, "articles": len(articles), "newArticles": len(new), "chars": len(text), "feeds": report}
    model = tok = None
    if model_raw:
        tmp = out / "auto" / "_prev.json"
        tmp.write_bytes(model_raw)
        try:
            model, tok = tg.load_json(tmp)
        except Exception as e:
            print(f"  前回のモデルを開けませんでした ({e})。新しく作ります")
        tmp.unlink()

    if len(text) < 2000:
        print("学習に使える文章がまだ少ないので、今回は学習しません (2000 字以上たまったら始めます)")
        run["train"] = None
        if model_raw:
            (out / "auto" / "tiny_gpt.json").write_bytes(model_raw)
    else:
        print("ちいさなGPTを学習させています…")
        torch.manual_seed(int(time.time()))
        model, tok = tg.train(text, n_layer=4, n_head=4, n_embd=128, block_size=128, batch_size=32,
                              steps=a.steps, lr=1e-3 if model is None else 5e-4, eval_every=250,
                              device="cpu", out=str(out / "auto" / "tiny_gpt.json"),
                              model=model, tok=tok, max_seconds=a.minutes * 60)
        start = tok.encode("\n") or [0]
        sample = tok.decode(model.generate(start, 200, temperature=0.8, top_k=20)).strip()
        run["train"] = dict(model.stats, params=sum(p.numel() for p in model.parameters()),
                            vocab=len(tok.chars), sample=sample, totalSteps=status.get("totalSteps", 0) + model.stats["steps"])
        status["totalSteps"] = run["train"]["totalSteps"]
        print(f"  損失 {model.stats['lossBefore']} → {model.stats['loss']} (検証 {model.stats['val']})")
        print("  試し書き:", sample[:100])

    history = (status.get("history") or [])[-89:]
    history.append({k: v for k, v in run.items() if k != "feeds"} | {"train": run["train"] and {
        k: run["train"][k] for k in ("steps", "loss", "val", "newChars", "vocab")}})
    status.update(updated=now, last=run, history=history)
    (out / "auto" / "status.json").write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{out} にサイトを書き出しました")


if __name__ == "__main__":
    main()
