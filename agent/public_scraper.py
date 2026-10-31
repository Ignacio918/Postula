"""Small, public-source job crawler for Postula's local desktop agent.

Uses public RSS feeds and follows a limited number of listing pages to read
JobPosting JSON-LD. No login, CAPTCHA, or access control is bypassed.
"""
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

UA = "PostulaJobDiscovery/1.0 (+public job feed reader)"
REMOTE = re.compile(r"worldwide|anywhere|global|latin america|latam|americas|south america|argentina|remote", re.I)
RESTRICTED = re.compile(r"(?:only|based in|must be (?:located|based)|residents? of|eligible to work in)\s+(?:the\s+)?(?:united states|u\.s\.?|usa|canada|united kingdom|uk|europe|eu|germany|france|spain|netherlands|ireland|australia)", re.I)


def fetch(url, accept, timeout=12):
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            return ""
        return response.read(2_000_000).decode("utf-8", "replace")


class JsonLdScripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.parts = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type", "").lower() == "application/ld+json":
            self.active = True
            self.parts = []

    def handle_data(self, data):
        if self.active:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.active:
            self.scripts.append("".join(self.parts))
            self.active = False


def find_postings(value):
    if isinstance(value, list):
        for item in value:
            yield from find_postings(item)
    elif isinstance(value, dict):
        types = value.get("@type", [])
        if isinstance(types, str):
            types = [types]
        if "JobPosting" in types:
            yield value
        graph = value.get("@graph")
        if graph:
            yield from find_postings(graph)


def posting_from_page(url):
    try:
        parser = JsonLdScripts()
        parser.feed(fetch(url, "text/html"))
        for raw in parser.scripts:
            try:
                data = json.loads(raw.strip())
            except (json.JSONDecodeError, ValueError):
                continue
            for job in find_postings(data):
                title = job.get("title")
                target = job.get("url") or url
                location = "Remote" if job.get("jobLocationType") == "TELECOMMUTE" else ""
                description = html.unescape(re.sub(r"<[^>]+>", " ", job.get("description", "")))
                if title and REMOTE.search(location + " " + description) and not RESTRICTED.search(location + " " + description):
                    org = job.get("hiringOrganization") or {}
                    return {"id": "py-jsonld-" + urllib.parse.quote(target, safe=""), "company": org.get("name") or urllib.parse.urlparse(target).hostname, "role": title, "url": target, "location": location or "Remote · revisar alcance", "description": re.sub(r"\s+", " ", description)[:12000], "source": "Web · JobPosting público", "remote": True}
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None
    return None


def main():
    try:
        profile = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except json.JSONDecodeError:
        profile = {}
    terms = [x.strip() for x in re.split(r"[,;\n]+", profile.get("roles", "")) if x.strip()][:4]
    feeds = ["https://weworkremotely.com/remote-jobs.rss"]
    for term in terms:
        if re.search(r"design|ux|product", term, re.I):
            feeds.append("https://weworkremotely.com/categories/remote-design-jobs.rss")
        if re.search(r"product|project|manager", term, re.I):
            feeds.append("https://weworkremotely.com/categories/remote-management-and-finance-jobs.rss")
    seen, candidates = set(), []
    for feed in dict.fromkeys(feeds):
        try:
            root = ET.fromstring(fetch(feed, "application/rss+xml, application/xml, text/xml"))
            for item in root.findall(".//item"):
                title = html.unescape(item.findtext("title", ""))
                link = item.findtext("link", "")
                desc = html.unescape(re.sub(r"<[^>]+>", " ", item.findtext("description", "")))
                if not link or link in seen or (terms and not any(t.lower() in (title + " " + desc).lower() for t in terms)):
                    continue
                seen.add(link)
                candidates.append((title, link, desc))
        except (urllib.error.URLError, ET.ParseError, TimeoutError, ValueError):
            continue
    results = []
    for title, link, desc in candidates[:12]:
        posting = posting_from_page(link)
        if posting:
            results.append(posting)
        elif REMOTE.search(desc) and not RESTRICTED.search(desc):
            company, role = (title.split(":", 1) + [""])[:2] if ":" in title else ("", title)
            results.append({"id": "py-wwr-" + urllib.parse.quote(link, safe=""), "company": company or "Empresa", "role": role.strip(), "url": link, "location": "Remote", "description": re.sub(r"\s+", " ", desc)[:8000], "source": "We Work Remotely", "remote": True})
        time.sleep(0.15)
    print(json.dumps(results, ensure_ascii=True))


if __name__ == "__main__":
    main()
