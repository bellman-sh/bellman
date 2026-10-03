# Comparison Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six comparison pages and an index at `bellman.sh/compare/*`, generated from one config, so Bellman has a written answer to "why not just use subagents?" that cannot go stale silently.

**Architecture:** A JSON config holds every page's content; an importable Python module holds the validation and rendering; a thin CLI script writes seven HTML files. This mirrors `tools/build-pricing.py` + `tools/pricing.config.json`, the site's existing precedent for repeated pages. The validators are the point: a page with no "what it is better at" section fails the build.

**Tech Stack:** Python 3 standard library only (`json`, `html`, `pathlib`, `datetime`, `re`, `unittest`). No new dependencies. Hand-written HTML and CSS. Cloudflare static assets via `wrangler`.

**Spec:** `docs/superpowers/specs/2026-10-02-comparison-pages-design.md` in `bellman-sh/bellman`. Read it before Task 1 — the facts tables in it are the only sanctioned source for claims about other products.

**Repository:** every command in this plan runs in **`bellman-sh/bellman.sh`**, checked out at `~/src/github.com/bellman-sh/site`. Nothing here is implemented in the server repo.

## Global Constraints

- **A room holds many members, not two.** Never write "the other session", "both sessions", "two sessions", or "pair" in page copy, commit messages or the PR body. Say *members*, *the room*, or *peers*; a peer is any other member. (From `bellman/CLAUDE.md`.)
- **Python 3 standard library only.** No pytest, no Jinja, no markdown renderer. `tools/build-pricing.py` sets the bar and it imports `html`, `json`, `pathlib`, `sys`.
- **Generated files carry a "GENERATED — do not edit" comment** and are committed, exactly as `public/pricing.html` is.
- **Every claim about another product must appear in the spec's facts tables.** If it does not, check it and add it to the spec, or cut the claim.
- **Two rows in the ChatGPT Space facts table are marked "unconfirmed — say nothing":** whether a non-OpenAI agent can join a Space, and per-Space member limits. Copy must not assert or deny either.
- **Never claim ChatGPT Space is single-player** or that it cannot involve other people. It can. The distinction is tenancy, not people.
- **`verified.date` is the date a human last checked that page's facts**, in `YYYY-MM-DD`. Do not copy it forward without re-checking.
- Second person, the site's existing voice. Read `public/index.html` before writing copy.

## Review Focus

Five things the spec implies, that no task's happy path exercises, most likely to bite first. Each one's test is added to the task that owns the code.

1. **A slug removed or renamed in the config leaves its old `public/compare/<slug>.html` on disk**, and Cloudflare keeps serving a page the index no longer links. Expected: the build deletes `public/compare/*.html` files no page claims, and says which. → Task 3.
2. **`answer_html` and `better_at_html` are raw HTML by design**, so a malformed fragment (an unclosed `<p>`, a stray `<`) silently breaks the page. Expected: the build rejects a fragment that does not parse and names the page and field. → Task 2.
3. **The site's voice uses em dashes and curly quotes.** Written with a platform-default encoding, those become mojibake on a machine whose locale is not UTF-8. Expected: every read and write is explicitly UTF-8. → Task 3.
4. **An `axes` row missing `them` or `us`** crashes with a bare `KeyError` instead of naming the page and the row. Expected: a `ConfigError` naming slug and row index. → Task 1.
5. **`public/compare/` does not exist in a fresh clone**, so the first build crashes on write. Expected: the build creates it. → Task 3.

---

### Task 1: Config validation

**Files:**
- Create: `tools/comparelib.py`
- Test: `tools/test_comparelib.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `ConfigError(Exception)`; `validate(cfg: dict, today: datetime.date) -> list[str]` returning warning strings and raising `ConfigError` on anything fatal; `SLUG_RE`; `STALE_DAYS = 90`.

- [ ] **Step 1: Confirm this is a plain git repo, and branch**

The server repo is colocated jj; this one must be checked before reacting to git state.

```bash
cd ~/src/github.com/bellman-sh/site
test -d .jj && echo "JJ REPO — use jj, stop and re-read the plan" || echo "plain git"
git switch -c mcfearsome/compare-pages
```

Expected: `plain git`, and a new branch.

- [ ] **Step 2: Write the failing tests**

Create `tools/test_comparelib.py`:

```python
"""Unit tests for comparelib. Run: python3 -m unittest discover -s tools -p 'test_*.py' -v"""

import datetime
import unittest

import comparelib


def page(**over):
    """A minimal valid page. Tests override one field to assert one rule."""
    p = {
        "slug": "subagents",
        "question": "Why not just use subagents?",
        "subject": "Claude subagents",
        "nav_label": "Subagents",
        "card_summary": "Workers inside one session.",
        "meta_description": "A description.",
        "answer_html": "<p>An answer.</p>",
        "decision": {"them": "one session", "us": "a member is not yours"},
        "axes": [{"axis": f"A{i}", "them": "t", "us": "u"} for i in range(5)],
        "better_at_html": "<p>Plenty.</p>",
        "verified": {
            "against": "Claude Code v2.1.248",
            "date": "2026-10-02",
            "sources": [{"label": "Subagents", "url": "https://example.com/a"}],
        },
    }
    p.update(over)
    return p


def cfg(*pages):
    return {
        "token_costs": {
            "tool_definitions": 3730,
            "create_room": 430,
            "join_room": 1300,
            "per_message": 220,
        },
        "pages": list(pages) or [page()],
    }


TODAY = datetime.date(2026, 10, 2)


class TestValidate(unittest.TestCase):
    def test_a_valid_config_passes_with_no_warnings(self):
        self.assertEqual(comparelib.validate(cfg(), TODAY), [])

    def test_missing_better_at_is_fatal_and_names_the_slug(self):
        with self.assertRaises(comparelib.ConfigError) as ctx:
            comparelib.validate(cfg(page(better_at_html="")), TODAY)
        self.assertIn("subagents", str(ctx.exception))
        self.assertIn("better_at_html", str(ctx.exception))

    def test_absent_better_at_key_is_fatal(self):
        p = page()
        del p["better_at_html"]
        with self.assertRaises(comparelib.ConfigError):
            comparelib.validate(cfg(p), TODAY)

    def test_fewer_than_five_axes_is_fatal(self):
        with self.assertRaises(comparelib.ConfigError) as ctx:
            comparelib.validate(cfg(page(axes=[{"axis": "A", "them": "t", "us": "u"}])), TODAY)
        self.assertIn("axes", str(ctx.exception))

    def test_an_axis_row_missing_us_names_the_slug_and_row(self):
        rows = [{"axis": f"A{i}", "them": "t", "us": "u"} for i in range(5)]
        del rows[2]["us"]
        with self.assertRaises(comparelib.ConfigError) as ctx:
            comparelib.validate(cfg(page(axes=rows)), TODAY)
        self.assertIn("subagents", str(ctx.exception))
        self.assertIn("2", str(ctx.exception))

    def test_missing_decision_half_is_fatal(self):
        with self.assertRaises(comparelib.ConfigError):
            comparelib.validate(cfg(page(decision={"them": "one session"})), TODAY)

    def test_a_bad_slug_is_fatal(self):
        with self.assertRaises(comparelib.ConfigError):
            comparelib.validate(cfg(page(slug="Sub Agents")), TODAY)

    def test_duplicate_slugs_are_fatal(self):
        with self.assertRaises(comparelib.ConfigError) as ctx:
            comparelib.validate(cfg(page(), page()), TODAY)
        self.assertIn("duplicate", str(ctx.exception).lower())

    def test_an_unparseable_date_is_fatal(self):
        v = dict(page()["verified"], date="last Tuesday")
        with self.assertRaises(comparelib.ConfigError):
            comparelib.validate(cfg(page(verified=v)), TODAY)

    def test_no_sources_is_fatal(self):
        v = dict(page()["verified"], sources=[])
        with self.assertRaises(comparelib.ConfigError):
            comparelib.validate(cfg(page(verified=v)), TODAY)

    def test_a_stale_date_warns_but_does_not_raise(self):
        v = dict(page()["verified"], date="2025-01-01")
        warnings = comparelib.validate(cfg(page(verified=v)), TODAY)
        self.assertEqual(len(warnings), 1)
        self.assertIn("subagents", warnings[0])

    def test_exactly_ninety_days_old_does_not_warn(self):
        v = dict(page()["verified"], date=str(TODAY - datetime.timedelta(days=90)))
        self.assertEqual(comparelib.validate(cfg(page(verified=v)), TODAY), [])

    def test_ninety_one_days_old_warns(self):
        v = dict(page()["verified"], date=str(TODAY - datetime.timedelta(days=91)))
        self.assertEqual(len(comparelib.validate(cfg(page(verified=v)), TODAY)), 1)

    def test_a_future_date_is_fatal(self):
        v = dict(page()["verified"], date="2027-01-01")
        with self.assertRaises(comparelib.ConfigError):
            comparelib.validate(cfg(page(verified=v)), TODAY)

    def test_a_missing_token_cost_is_fatal(self):
        c = cfg()
        del c["token_costs"]["join_room"]
        with self.assertRaises(comparelib.ConfigError):
            comparelib.validate(c, TODAY)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd ~/src/github.com/bellman-sh/site
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'comparelib'`.

- [ ] **Step 4: Write the implementation**

Create `tools/comparelib.py`:

```python
"""Validation and rendering for the /compare/* pages.

Imported by tools/build-compare.py and by tools/test_comparelib.py. The
generator script has a hyphen in its name and cannot be imported, so the
logic worth testing lives here instead.
"""

import datetime
import html
import re

SLUG_RE = re.compile(r"^[a-z][a-z-]*[a-z]$")
STALE_DAYS = 90
MIN_AXES = 5
TOKEN_KEYS = ("tool_definitions", "create_room", "join_room", "per_message")
REQUIRED_TEXT = (
    "slug",
    "question",
    "subject",
    "nav_label",
    "card_summary",
    "meta_description",
    "answer_html",
    "better_at_html",
)


class ConfigError(Exception):
    """The config is wrong in a way that must stop the build."""


def e(s):
    """Escape a value for HTML text and attributes."""
    return html.escape(str(s), quote=True)


def validate(cfg, today):
    """Raise ConfigError on anything fatal; return a list of warning strings.

    Fatal means the page would publish wrong or incomplete. A stale
    verified date only warns, because a stale page is still a true page
    until someone checks it.
    """
    warnings = []

    costs = cfg.get("token_costs")
    if not isinstance(costs, dict):
        raise ConfigError("token_costs is missing or not an object")
    for key in TOKEN_KEYS:
        if not isinstance(costs.get(key), int):
            raise ConfigError(f"token_costs.{key} is missing or not an integer")

    pages = cfg.get("pages")
    if not isinstance(pages, list) or not pages:
        raise ConfigError("pages is missing or empty")

    seen = set()
    for page in pages:
        slug = page.get("slug", "<no slug>")

        for key in REQUIRED_TEXT:
            value = page.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ConfigError(f"{slug}: {key} is missing or empty")

        if not SLUG_RE.match(page["slug"]):
            raise ConfigError(f"{slug}: slug must match {SLUG_RE.pattern}")
        if page["slug"] in seen:
            raise ConfigError(f"{slug}: duplicate slug")
        seen.add(page["slug"])

        decision = page.get("decision")
        if not isinstance(decision, dict):
            raise ConfigError(f"{slug}: decision is missing")
        for half in ("them", "us"):
            if not str(decision.get(half, "")).strip():
                raise ConfigError(f"{slug}: decision.{half} is missing or empty")

        axes = page.get("axes")
        if not isinstance(axes, list) or len(axes) < MIN_AXES:
            raise ConfigError(
                f"{slug}: axes needs at least {MIN_AXES} rows, found "
                f"{len(axes) if isinstance(axes, list) else 0}"
            )
        for i, row in enumerate(axes):
            for key in ("axis", "them", "us"):
                if not isinstance(row, dict) or not str(row.get(key, "")).strip():
                    raise ConfigError(f"{slug}: axes row {i} is missing {key}")

        verified = page.get("verified")
        if not isinstance(verified, dict):
            raise ConfigError(f"{slug}: verified is missing")
        if not str(verified.get("against", "")).strip():
            raise ConfigError(f"{slug}: verified.against is missing")
        try:
            checked = datetime.date.fromisoformat(str(verified.get("date")))
        except (TypeError, ValueError):
            raise ConfigError(
                f"{slug}: verified.date must be YYYY-MM-DD, found "
                f"{verified.get('date')!r}"
            )
        if checked > today:
            raise ConfigError(f"{slug}: verified.date {checked} is in the future")
        age = (today - checked).days
        if age > STALE_DAYS:
            warnings.append(
                f"{slug}: verified.date is {age} days old — re-check the facts "
                f"table in the spec and update it"
            )

        sources = verified.get("sources")
        if not isinstance(sources, list) or not sources:
            raise ConfigError(f"{slug}: verified.sources is missing or empty")
        for i, source in enumerate(sources):
            for key in ("label", "url"):
                if not isinstance(source, dict) or not str(source.get(key, "")).strip():
                    raise ConfigError(f"{slug}: verified.sources row {i} is missing {key}")
            if not str(source["url"]).startswith("https://"):
                raise ConfigError(
                    f"{slug}: verified.sources row {i} url must be https://"
                )

    return warnings
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add tools/comparelib.py tools/test_comparelib.py
git commit -m "feat: validate the compare config, fatally where it matters

A page with no 'what it is better at' section fails the build. That
section is the whole point of the comparison, and good intentions do not
survive a deadline.

A stale verified date only warns: a page nobody has re-checked is still
a true page until someone checks it."
```

---

### Task 2: Fragment checking and the rendering helpers

**Files:**
- Modify: `tools/comparelib.py`
- Modify: `tools/test_comparelib.py`

**Interfaces:**
- Consumes: `ConfigError`, `e()`, `validate()` from Task 1.
- Produces: `check_fragment(fragment: str, where: str) -> None`; `axis_table_html(page: dict) -> str`; `decision_html(page: dict) -> str`; `token_block_html(costs: dict) -> str`; `verified_html(page: dict) -> str`. `validate()` now also calls `check_fragment` on `answer_html` and `better_at_html`.

- [ ] **Step 1: Write the failing tests**

Append to `tools/test_comparelib.py`, before the `if __name__` block:

```python
class TestFragments(unittest.TestCase):
    def test_a_well_formed_fragment_passes(self):
        comparelib.check_fragment("<p>Fine, with <code>a tag</code>.</p>", "x")

    def test_several_sibling_paragraphs_pass(self):
        comparelib.check_fragment("<p>One.</p>\n<p>Two.</p>", "x")

    def test_an_unclosed_tag_is_fatal_and_names_where(self):
        with self.assertRaises(comparelib.ConfigError) as ctx:
            comparelib.check_fragment("<p>Unclosed.", "subagents.answer_html")
        self.assertIn("subagents.answer_html", str(ctx.exception))

    def test_a_stray_less_than_is_fatal(self):
        with self.assertRaises(comparelib.ConfigError):
            comparelib.check_fragment("<p>5 < 6 is true.</p>", "x")

    def test_an_escaped_less_than_passes(self):
        comparelib.check_fragment("<p>5 &lt; 6 is true.</p>", "x")

    def test_mismatched_tags_are_fatal(self):
        with self.assertRaises(comparelib.ConfigError):
            comparelib.check_fragment("<p>Wrong.</em>", "x")

    def test_validate_rejects_a_malformed_answer(self):
        with self.assertRaises(comparelib.ConfigError) as ctx:
            comparelib.validate(cfg(page(answer_html="<p>Unclosed.")), TODAY)
        self.assertIn("answer_html", str(ctx.exception))


class TestRendering(unittest.TestCase):
    def test_the_axis_table_puts_them_first(self):
        out = comparelib.axis_table_html(page())
        self.assertLess(out.index("Claude subagents"), out.index("Bellman"))

    def test_the_axis_table_escapes_cell_text(self):
        rows = [{"axis": "A", "them": 'a "b" & <c>', "us": "u"} for _ in range(5)]
        out = comparelib.axis_table_html(page(axes=rows))
        self.assertIn("&amp;", out)
        self.assertIn("&lt;c&gt;", out)
        self.assertNotIn("<c>", out)

    def test_the_decision_box_carries_both_halves(self):
        out = comparelib.decision_html(page())
        self.assertIn("one session", out)
        self.assertIn("a member is not yours", out)

    def test_the_token_block_formats_thousands(self):
        out = comparelib.token_block_html(cfg()["token_costs"])
        self.assertIn("3,730", out)
        self.assertIn("1,300", out)

    def test_the_verified_line_names_what_and_when_and_links_sources(self):
        out = comparelib.verified_html(page())
        self.assertIn("Claude Code v2.1.248", out)
        self.assertIn("2026-10-02", out)
        self.assertIn('href="https://example.com/a"', out)

    def test_the_verified_line_escapes_a_source_label(self):
        v = dict(page()["verified"], sources=[{"label": "A & B", "url": "https://e.com/x"}])
        self.assertIn("A &amp; B", comparelib.verified_html(page(verified=v)))
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

Expected: FAIL — `AttributeError: module 'comparelib' has no attribute 'check_fragment'`.

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `tools/comparelib.py`:

```python
from html.parser import HTMLParser
```

Append to `tools/comparelib.py`:

```python
VOID_TAGS = {"br", "hr", "img", "input", "meta", "link"}


class _FragmentChecker(HTMLParser):
    """Rejects a fragment that would not render as written.

    answer_html and better_at_html are raw HTML on purpose — the copy needs
    <code>, <em> and links. Raw means a typo reaches the page, so the build
    parses every fragment and refuses the ones that do not close.
    """

    def __init__(self):
        # convert_charrefs must stay off: with it on, "&lt;" and a bare "<"
        # both arrive as "<" in handle_data and cannot be told apart.
        super().__init__(convert_charrefs=False)
        self.stack = []
        self.problem = None

    def handle_starttag(self, tag, attrs):
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        if not self.stack:
            self.problem = self.problem or f"</{tag}> closes nothing"
        elif self.stack[-1] != tag:
            self.problem = self.problem or f"</{tag}> closes <{self.stack[-1]}>"
            self.stack.pop()
        else:
            self.stack.pop()

    def handle_data(self, data):
        # A "<" the parser could not read as a tag arrives here as data.
        if "<" in data:
            self.problem = self.problem or "a bare '<' must be written &lt;"

    def handle_entityref(self, name):
        pass  # &lt; and friends are correct input, not data to inspect

    def handle_charref(self, name):
        pass


def check_fragment(fragment, where):
    """Raise ConfigError if this HTML fragment is not well formed."""
    checker = _FragmentChecker()
    checker.feed(fragment)
    checker.close()
    if checker.problem:
        raise ConfigError(f"{where}: {checker.problem}")
    if checker.stack:
        raise ConfigError(f"{where}: <{checker.stack[-1]}> is never closed")


def axis_table_html(page):
    """The comparison table. Their column first — we are the challenger."""
    rows = "\n".join(
        f"      <tr><th scope=\"row\">{e(r['axis'])}</th>"
        f"<td>{e(r['them'])}</td><td>{e(r['us'])}</td></tr>"
        for r in page["axes"]
    )
    return f"""<table class="axes">
  <thead>
    <tr><td></td><th scope="col">{e(page['subject'])}</th><th scope="col">Bellman</th></tr>
  </thead>
  <tbody>
{rows}
  </tbody>
</table>"""


def decision_html(page):
    """The sentence a reader quotes to a colleague."""
    d = page["decision"]
    return f"""<aside class="decision">
  <p><strong>Use {e(page['subject'])}</strong> for {e(d['them'])}.</p>
  <p><strong>Use Bellman</strong> when {e(d['us'])}.</p>
</aside>"""


def token_block_html(costs):
    """What being connected costs. Nobody else in this space publishes one."""
    return f"""<section class="section">
  <h2>What connecting costs</h2>
  <p>
    Being connected costs about <strong>{costs['tool_definitions']:,} tokens</strong>
    of tool definitions on every request, whether or not you are in a room.
    Creating a room costs about {costs['create_room']:,}, joining one about
    {costs['join_room']:,}, and each message you receive about
    {costs['per_message']:,}.
  </p>
  <p class="fine">
    Measured against real payloads, so allow ten percent either way.
  </p>
</section>"""


def verified_html(page):
    """What this page was checked against, and when."""
    v = page["verified"]
    links = ", ".join(
        f'<a href="{e(s["url"])}">{e(s["label"])}</a>' for s in v["sources"]
    )
    return (
        f'<p class="verified">Checked against {e(v["against"])} on '
        f'<time datetime="{e(v["date"])}">{e(v["date"])}</time> — {links}.</p>'
    )
```

Then wire fragment checking into `validate()`. Inside the `for page in pages:` loop, immediately after the `REQUIRED_TEXT` loop, add:

```python
        for key in ("answer_html", "better_at_html"):
            check_fragment(page[key], f"{slug}: {key}")
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

Expected: PASS, 28 tests.

- [ ] **Step 5: Commit**

```bash
git add tools/comparelib.py tools/test_comparelib.py
git commit -m "feat: render the compare page parts, and parse every fragment

answer_html and better_at_html are raw HTML because the copy needs
<code>, <em> and links. Raw means a typo reaches the page, so the build
parses each fragment and refuses one that does not close."
```

---

### Task 3: Page rendering, the generator script, and the orphan sweep

**Files:**
- Create: `tools/build-compare.py`
- Modify: `tools/comparelib.py`
- Modify: `tools/test_comparelib.py`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: `render_page(page, cfg) -> str`; `render_index(cfg) -> str`; `write_all(cfg, out_dir) -> tuple[list[pathlib.Path], list[pathlib.Path]]` returning `(written, removed)`. `./tools/build-compare.py` as the CLI.

- [ ] **Step 1: Write the failing tests**

Append to `tools/test_comparelib.py`, before the `if __name__` block:

```python
import pathlib
import tempfile


class TestWriteAll(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = pathlib.Path(self.tmp.name) / "compare"

    def tearDown(self):
        self.tmp.cleanup()

    def test_it_creates_the_directory_and_writes_a_page_per_slug_plus_an_index(self):
        written, removed = comparelib.write_all(cfg(page(), page(slug="openrig")), self.out)
        names = sorted(p.name for p in written)
        self.assertEqual(names, ["index.html", "openrig.html", "subagents.html"])
        self.assertEqual(removed, [])
        self.assertTrue(self.out.is_dir())

    def test_it_is_idempotent(self):
        comparelib.write_all(cfg(), self.out)
        first = {p.name: p.read_bytes() for p in self.out.iterdir()}
        comparelib.write_all(cfg(), self.out)
        second = {p.name: p.read_bytes() for p in self.out.iterdir()}
        self.assertEqual(first, second)

    def test_it_removes_a_page_no_slug_claims(self):
        comparelib.write_all(cfg(), self.out)
        orphan = self.out / "renamed-away.html"
        orphan.write_text("<!doctype html>stale", encoding="utf-8")
        written, removed = comparelib.write_all(cfg(), self.out)
        self.assertEqual([p.name for p in removed], ["renamed-away.html"])
        self.assertFalse(orphan.exists())

    def test_it_leaves_non_html_files_alone(self):
        comparelib.write_all(cfg(), self.out)
        keep = self.out / "notes.txt"
        keep.write_text("mine", encoding="utf-8")
        comparelib.write_all(cfg(), self.out)
        self.assertTrue(keep.exists())

    def test_it_writes_utf8_regardless_of_platform_encoding(self):
        p = page(answer_html="<p>A room — not a pair — holds “members”.</p>")
        comparelib.write_all(cfg(p), self.out)
        raw = (self.out / "subagents.html").read_bytes()
        self.assertIn("—".encode("utf-8"), raw)
        self.assertIn("“members”".encode("utf-8"), raw)


class TestRenderPage(unittest.TestCase):
    def test_a_page_carries_every_part_of_the_contract(self):
        out = comparelib.render_page(page(), cfg())
        self.assertIn("<title>Why not just use subagents? &mdash; Bellman</title>", out)
        self.assertIn('rel="canonical" href="https://bellman.sh/compare/subagents"', out)
        self.assertIn("<h1", out)
        self.assertIn("An answer.", out)
        self.assertIn('class="decision"', out)
        self.assertIn('class="axes"', out)
        self.assertIn("What Claude subagents is better at", out)
        self.assertIn("What connecting costs", out)
        self.assertIn('class="verified"', out)
        self.assertIn("GENERATED", out)

    def test_the_nav_marks_compare_as_current(self):
        self.assertIn('href="/compare/" aria-current="page"', comparelib.render_page(page(), cfg()))

    def test_the_index_links_every_page_and_carries_the_ladder(self):
        out = comparelib.render_index(cfg(page(), page(slug="openrig", subject="OpenRig")))
        self.assertIn('href="/compare/subagents"', out)
        self.assertIn('href="/compare/openrig"', out)
        self.assertIn("How far it reaches", out)

    def test_a_question_with_an_ampersand_is_escaped_in_the_title(self):
        out = comparelib.render_page(page(question="Why not Tom & Jerry?"), cfg())
        self.assertIn("Tom &amp; Jerry", out)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

Expected: FAIL — `AttributeError: module 'comparelib' has no attribute 'write_all'`.

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `tools/comparelib.py`:

```python
import pathlib
```

Append to `tools/comparelib.py`. The `HEAD`, `BAR` and `FOOT` constants are copied from `public/index.html` so the pages match the rest of the site exactly; `reach` is an optional per-page field the index ladder uses.

```python
SITE = "https://bellman.sh"

FAVICON = (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'"
    "%3E%3Crect width='32' height='32' rx='6' fill='%2311161D'/%3E%3Cpath d='M16 7c-3.6 "
    "0-6 2.5-6 6v4.2L8 20v1.6h16V20l-2-2.8V13c0-3.5-2.4-6-6-6Zm0 18a2.4 2.4 0 0 0 "
    "2.3-1.8h-4.6A2.4 2.4 0 0 0 16 25Z' fill='%23D9A521'/%3E%3C/svg%3E"
)

BELL_SVG = (
    '<svg class="bar__bell" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 7c-3.6 '
    '0-6 2.5-6 6v4.2L8 20v1.6h16V20l-2-2.8V13c0-3.5-2.4-6-6-6Zm0 18a2.4 2.4 0 0 0 '
    '2.3-1.8h-4.6A2.4 2.4 0 0 0 16 25Z"/></svg>'
)

BAR = f"""<header class="bar">
  <a class="bar__mark" href="/">
    {BELL_SVG}
    bellman
  </a>
  <nav class="bar__nav">
    <a href="/#install">Install</a>
    <a href="/compare/" aria-current="page">Compare</a>
    <a href="/pricing">Pricing</a>
    <a href="/#status">Status</a>
    <a href="https://github.com/bellman-sh/bellman">Repo</a>
  </nav>
</header>"""

FOOT = """<footer class="foot">
  <div class="foot__row">
    <span class="foot__mark">bellman</span>
    <nav>
      <a href="/">Home</a>
      <a href="/compare/">Compare</a>
      <a href="/pricing">Pricing</a>
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="/refunds">Refunds</a>
      <a href="/contact">Contact</a>
    </nav>
  </div>
  <p class="foot__note">
    Cross-session, cross-provider agent collaboration over MCP. MIT licensed.
  </p>
</footer>"""


def _head(title, description, url):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- GENERATED by tools/build-compare.py from tools/compare.config.json.
     Do not edit this file; edit the config and regenerate. -->
<title>{title} &mdash; Bellman</title>
<meta name="description" content="{description}">
<link rel="canonical" href="{url}">
<link rel="icon" href="{FAVICON}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bellman">
<meta property="og:title" content="{title} &mdash; Bellman">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{SITE}/og.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400;12..96,75..100,600;12..96,75..100,800&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>

<a class="skip" href="#answer">Skip to the answer</a>

{BAR}

<main>"""


def render_page(page, cfg):
    """One comparison page, in the order the spec fixes."""
    url = f"{SITE}/compare/{page['slug']}"
    return f"""{_head(e(page['question']), e(page['meta_description']), url)}

<section class="hero hero--short">
  <h1 class="hero__title">{e(page['question'])}</h1>
</section>

<section class="section" id="answer">
{page['answer_html']}
</section>

<section class="section">
{decision_html(page)}
</section>

<section class="section">
  <h2>Side by side</h2>
{axis_table_html(page)}
</section>

<section class="section">
  <h2>What {e(page['subject'])} is better at</h2>
{page['better_at_html']}
</section>

{token_block_html(cfg['token_costs'])}

<section class="section">
  <div class="plan__cta">
    <a class="btn" href="/#install">Install Bellman</a>
    <a class="btn btn--quiet" href="/pricing">See the plans</a>
  </div>
{verified_html(page)}
</section>

</main>

{FOOT}
</body>
</html>
"""


def render_index(cfg):
    """The router, plus the reach ladder that is the section's argument."""
    cards = "\n".join(
        f"""      <article class="compare-card">
        <h2><a href="/compare/{e(p['slug'])}">{e(p['question'])}</a></h2>
        <p>{e(p['card_summary'])}</p>
      </article>"""
        for p in cfg["pages"]
    )
    ladder = "\n".join(
        f"      <tr><th scope=\"row\">{e(p['subject'])}</th>"
        f"<td>{e(p.get('reach', '—'))}</td><td>{e(p.get('stops_at', '—'))}</td></tr>"
        for p in cfg["pages"]
    )
    description = (
        "Why not just use subagents, Claude Code messaging, Managed Agents, "
        "OpenRig, an agent framework, or ChatGPT Space? The honest answer to "
        "each, and what every one of them is better at."
    )
    return f"""{_head("Compare", e(description), f"{SITE}/compare/")}

<section class="hero hero--short" id="answer">
  <h1 class="hero__title">Why not just<br><em>use that?</em></h1>
  <p class="hero__lede">
    Six fair questions. Each one gets a page, and each page says what the other
    thing is better at — because most of the time it is, and you should know
    before you reach for us.
  </p>
</section>

<section class="section">
  <div class="compare-cards">
{cards}
  </div>
</section>

<section class="section">
  <h2>How far it reaches</h2>
  <p>
    Every tool on this list reaches a certain distance and then stops. That is
    the one axis all six comparisons share.
  </p>
  <table class="axes">
    <thead>
      <tr><td></td><th scope="col">Reaches</th><th scope="col">Stops at</th></tr>
    </thead>
    <tbody>
{ladder}
      <tr><th scope="row">Bellman</th><td>any member with the code</td><td>nothing of yours is needed</td></tr>
    </tbody>
  </table>
</section>

{token_block_html(cfg['token_costs'])}

<section class="section">
  <div class="plan__cta">
    <a class="btn" href="/#install">Install Bellman</a>
    <a class="btn btn--quiet" href="/pricing">See the plans</a>
  </div>
</section>

</main>

{FOOT}
</body>
</html>
"""


def write_all(cfg, out_dir):
    """Write every page plus the index, and sweep pages no slug claims.

    The sweep is the point: a slug renamed in the config would otherwise
    leave its old file on disk, and Cloudflare would keep serving a page
    the index no longer links.
    """
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    wanted = {"index.html": render_index(cfg)}
    for page in cfg["pages"]:
        wanted[f"{page['slug']}.html"] = render_page(page, cfg)

    written = []
    for name, body in sorted(wanted.items()):
        path = out_dir / name
        path.write_text(body, encoding="utf-8")
        written.append(path)

    removed = []
    for path in sorted(out_dir.glob("*.html")):
        if path.name not in wanted:
            path.unlink()
            removed.append(path)

    return written, removed
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

Expected: PASS, 37 tests.

- [ ] **Step 5: Write the CLI**

Create `tools/build-compare.py`, modelled on `tools/build-pricing.py`:

```python
#!/usr/bin/env python3
"""Generate public/compare/*.html from tools/compare.config.json.

    ./tools/build-compare.py

Every claim, axis row and token count on these pages comes from the config,
so a number cannot be right on one page and stale on another, and the
facts that go out of date have one place to be corrected.

The generator refuses to write a page with no "what it is better at"
section. That section is the comparison; without it the page is an advert.
"""

import datetime
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import comparelib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG = ROOT / "tools" / "compare.config.json"
OUT = ROOT / "public" / "compare"


def main():
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))

    try:
        warnings = comparelib.validate(cfg, datetime.date.today())
    except comparelib.ConfigError as err:
        print(f"error: {err}", file=sys.stderr)
        print(f"  fix {CONFIG.relative_to(ROOT)} and run again", file=sys.stderr)
        return 1

    written, removed = comparelib.write_all(cfg, OUT)

    print(f"wrote {len(written)} files to {OUT.relative_to(ROOT)}")
    for path in written:
        print(f"  {path.relative_to(ROOT)}")
    for path in removed:
        print(f"  removed {path.relative_to(ROOT)} — no page claims that slug")
    for warning in warnings:
        print(f"  WARNING {warning}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Make it executable:

```bash
chmod +x tools/build-compare.py
```

- [ ] **Step 6: Commit**

```bash
git add tools/build-compare.py tools/comparelib.py tools/test_comparelib.py
git commit -m "feat: generate the compare pages, and sweep orphans

A slug renamed in the config would otherwise leave its old file on disk
and Cloudflare would keep serving a page the index no longer links, so
the build deletes any compare page no slug claims and says which.

Every read and write is explicitly UTF-8: the site's voice uses em
dashes and curly quotes, and a platform default would mangle them."
```

---

### Task 4: The three Anthropic comparisons

**Files:**
- Create: `tools/compare.config.json`

**Interfaces:**
- Consumes: the schema `comparelib.validate` enforces.
- Produces: a config with `token_costs` and three pages — `subagents`, `claude-agent-teams`, `managed-agents`.

Copy is drawn from the spec's facts tables. Do not add a claim that is not in them.

- [ ] **Step 1: Write the config**

Create `tools/compare.config.json`:

```json
{
  "_comment": "Single source of truth for /compare/*. Edit here, run ./tools/build-compare.py, commit the regenerated public/compare/*.html. Never edit those files by hand. Every claim about another product must appear in the facts tables of bellman/docs/superpowers/specs/2026-10-02-comparison-pages-design.md.",
  "token_costs": {
    "_source": "bellman/docs/ARCHITECTURE.md section 11",
    "tool_definitions": 3730,
    "create_room": 430,
    "join_room": 1300,
    "per_message": 220
  },
  "pages": [
    {
      "slug": "subagents",
      "question": "Why not just use subagents?",
      "subject": "Claude subagents",
      "nav_label": "Subagents",
      "card_summary": "Workers inside one session.",
      "reach": "inside one session",
      "stops_at": "the turn, and your own context",
      "meta_description": "Subagents are workers inside one session. A Bellman room holds members: whole sessions that belong to whoever started them. When to use which, and what each costs.",
      "answer_html": "<p>A subagent is a worker inside your session. It starts with its own context &mdash; its system prompt, the task you delegated, your <code>CLAUDE.md</code> &mdash; and not with your conversation history. It runs on your provider, under your account, and it ends when its task does.</p>\n<p>A Bellman room holds members, and a member is a whole session someone is working in. It keeps its own history, it belongs to whoever started it, and it is still there after any one turn ends. Those are different shapes, and they are good at different things.</p>",
      "decision": {
        "them": "anything happening inside one session",
        "us": "a member is not yours"
      },
      "axes": [
        { "axis": "Lifetime", "them": "ends when its task does", "us": "stays until the room closes" },
        { "axis": "Starting context", "them": "its own, not the parent's", "us": "its own session's, unbroken" },
        { "axis": "Who it belongs to", "them": "you", "us": "whoever started it" },
        { "axis": "Provider", "them": "the session that spawned it", "us": "any MCP client, any provider" },
        { "axis": "How you reach it", "them": "the Agent tool, inside the session", "us": "a room code" }
      ],
      "better_at_html": "<p>Nearly everything, if the work is yours and inside one session. Subagents fan out &mdash; twenty at once by default &mdash; and that is the cheapest parallelism you will find. They keep a thousand lines of test output out of your context. You can hand one a reduced tool set and a stricter permission mode and know it cannot write. You can route cheap reading to Haiku. A finished one resumes with its history intact. There is nothing to install, no network hop, and no account for anyone to create.</p>\n<p>And if the other member would also be yours, you may not need us either: Claude Code can already list and message your own sessions, including on another machine. <a href=\"/compare/claude-agent-teams\">That comparison has its own page.</a></p>",
      "verified": {
        "against": "Claude Code v2.1.248",
        "date": "2026-10-02",
        "sources": [
          { "label": "Claude Code subagents", "url": "https://code.claude.com/docs/en/sub-agents" }
        ]
      }
    },
    {
      "slug": "claude-agent-teams",
      "question": "Why not just use Claude Code's agent teams?",
      "subject": "Claude Code messaging",
      "nav_label": "Claude Code",
      "card_summary": "Messaging between your own sessions.",
      "reach": "your own sessions, anywhere",
      "stops_at": "your OS user and your sign-in",
      "meta_description": "Claude Code can list and message your own sessions, including on other machines. Bellman starts where that stops: a member outside your account, or in a client that is not Claude Code.",
      "answer_html": "<p>Claude Code can find and message your other sessions &mdash; on this machine over a local socket, in the cloud, and on your other machines through Remote Control. If every member would be yours and every one is Claude Code, that is the shorter path, it costs you no tool definitions, and it is free. Use it.</p>\n<p>It is scoped to <em>you</em> on purpose. A session's inbox is restricted to your operating-system user, so another person's sessions cannot deliver to it, and reaching past this machine needs Remote Control on your own sign-in. Bellman begins at that boundary: a room's members hold a code, and nothing of yours.</p>",
      "decision": {
        "them": "sessions that are yours, in Claude Code",
        "us": "a member is someone else's, or is not Claude Code"
      },
      "axes": [
        { "axis": "Whose sessions", "them": "yours", "us": "whoever you give the code to" },
        { "axis": "Which client", "them": "Claude Code", "us": "any MCP client" },
        { "axis": "Past this machine", "them": "Remote Control, on your sign-in", "us": "any member, nothing to connect" },
        { "axis": "On Bedrock, Google Cloud, Foundry", "them": "this machine only", "us": "unaffected" },
        { "axis": "What crosses", "them": "plain text", "us": "typed events, stamped with their sender" },
        { "axis": "What is recorded", "them": "per-session settings", "us": "audit entries, per organisation" }
      ],
      "better_at_html": "<p>It is free, and it costs you nothing in tool definitions &mdash; ours are about 3,730 tokens on every request. There is nothing to install and nobody else needs an account. Messages between sessions on one machine never leave it. You can ask a session for a single notice when it next goes idle. Arriving messages can be set to <code>accept</code>, <code>hold</code> or <code>refuse</code> per session, and <code>isolatePeerMachines</code> makes anything leaving the machine ask you first. Inside an agent team, members exchange a structured protocol we do not have.</p>\n<p>For your own fleet this is the better tool, and we are not trying to replace it.</p>",
      "verified": {
        "against": "Claude Code v2.1.248",
        "date": "2026-10-02",
        "sources": [
          { "label": "Cross-session messaging", "url": "https://code.claude.com/docs/en/cross-session-messaging" },
          { "label": "Agent teams", "url": "https://code.claude.com/docs/en/agent-teams" }
        ]
      }
    },
    {
      "slug": "managed-agents",
      "question": "Why not just use Managed Agents?",
      "subject": "Claude Managed Agents",
      "nav_label": "Managed Agents",
      "card_summary": "Anthropic runs the agent and hosts the sandbox.",
      "reach": "agents in your account",
      "stops_at": "one organisation, reached by API",
      "meta_description": "Managed Agents is somewhere to put an agent: a versioned config, a hosted sandbox, scheduled runs, graders. Bellman is somewhere agents meet, and it never runs one.",
      "answer_html": "<p>Managed Agents is Anthropic running the loop for you. You store a versioned agent configuration, start a session against it, and each session gets a container where bash, file operations and code execution happen. There are scheduled deployments, graders that iterate against a rubric you wrote, memory stores, and rosters where one agent delegates to workers.</p>\n<p>It is somewhere to <em>put</em> an agent. Bellman is somewhere agents <em>meet</em>. It starts nothing, hosts nothing, and has no opinion about what a member does &mdash; including when that member is a person's terminal rather than a process anybody provisioned.</p>",
      "decision": {
        "them": "running an agent you own",
        "us": "connecting agents nobody owns together"
      },
      "axes": [
        { "axis": "Who runs the loop", "them": "Anthropic", "us": "nobody; each member runs itself" },
        { "axis": "Where tools execute", "them": "a per-session container", "us": "wherever the member already is" },
        { "axis": "Whose account", "them": "yours, one organisation", "us": "one per member" },
        { "axis": "Scheduling", "them": "deployments, on a cron", "us": "none" },
        { "axis": "Provider", "them": "Claude", "us": "any MCP client, any provider" },
        { "axis": "An agent you did not start", "them": "out of scope", "us": "the point" }
      ],
      "better_at_html": "<p>Everything about actually running an agent. You provision no infrastructure. Configurations are stored objects with versions, so a session pins to one and you roll forward deliberately. Deployments fire on a cron without a scheduler of yours. Outcomes put a separate grader in front of the work and keep iterating until it passes. Vault credentials are substituted at egress and never enter the sandbox. A multiagent roster hands reading-heavy work to a cheaper model.</p>\n<p>None of that is on our roadmap, and none of it should be. If what you want is a reliable hosted agent, that is the product.</p>",
      "verified": {
        "against": "the Managed Agents beta",
        "date": "2026-10-02",
        "sources": [
          { "label": "Claude platform documentation", "url": "https://platform.claude.com/docs" }
        ]
      }
    }
  ]
}
```

- [ ] **Step 2: Run the generator**

```bash
./tools/build-compare.py
```

Expected: `wrote 4 files to public/compare`, no warnings, no removals.

- [ ] **Step 3: Prove the honesty check fires (positive control)**

A check nobody has watched fail is not a check.

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("tools/compare.config.json")
cfg = json.loads(p.read_text(encoding="utf-8"))
cfg["pages"][0]["better_at_html"] = ""
pathlib.Path("/tmp/broken-compare.json").write_text(json.dumps(cfg), encoding="utf-8")
PY
cp tools/compare.config.json /tmp/good-compare.json
cp /tmp/broken-compare.json tools/compare.config.json
./tools/build-compare.py; echo "exit=$?"
cp /tmp/good-compare.json tools/compare.config.json
./tools/build-compare.py >/dev/null && echo "restored"
```

Expected: `error: subagents: better_at_html is missing or empty`, then `exit=1`, then `restored`.

- [ ] **Step 4: Prove the staleness warning fires (positive control)**

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("tools/compare.config.json")
cfg = json.loads(p.read_text(encoding="utf-8"))
cfg["pages"][0]["verified"]["date"] = "2025-01-01"
p.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
./tools/build-compare.py | grep WARNING; echo "exit=$?"
cp /tmp/good-compare.json tools/compare.config.json
./tools/build-compare.py >/dev/null && echo "restored"
```

Expected: a `WARNING subagents: verified.date is ... days old` line, `exit=0` from grep, then `restored`.

- [ ] **Step 5: Commit**

```bash
git add tools/compare.config.json public/compare
git commit -m "feat: compare subagents, Claude Code messaging and Managed Agents

The three Anthropic comparisons, each saying what the Anthropic feature
is better at, because for work inside one account it usually is.

Subagents are context-isolated, not context-sharing: a subagent starts
with its own system prompt and the delegated task, and a fork is the
exception. Issue #83 had this backwards and the page does not."```

---

### Task 5: OpenRig, the frameworks, and ChatGPT Space

**Files:**
- Modify: `tools/compare.config.json`

**Interfaces:**
- Consumes: the config written in Task 4.
- Produces: the same config with six pages. `write_all` then emits seven files.

**The constraint that matters here:** the spec marks two ChatGPT Space facts
**unconfirmed — say nothing**: whether a non-OpenAI agent can join a Space, and
per-Space member limits. The copy below asserts neither, and it never says
Space is single-player. Do not "improve" it in that direction.

- [ ] **Step 1: Append the three pages**

```bash
cd ~/src/github.com/bellman-sh/site
python3 - <<'PY'
import json, pathlib

p = pathlib.Path("tools/compare.config.json")
cfg = json.loads(p.read_text(encoding="utf-8"))

cfg["pages"].append({
    "slug": "openrig",
    "question": "Why not just use OpenRig?",
    "subject": "OpenRig",
    "nav_label": "OpenRig",
    "card_summary": "Boots and supervises a team on your machine.",
    "reach": "processes on your machine",
    "stops_at": "the machine, and what it started",
    "meta_description": "OpenRig boots a team of agents on your machine and supervises them. Bellman starts nothing. They solve different halves of the problem, and they compose.",
    "answer_html": "<p>OpenRig boots your team for you. It sets up tmux pods on one machine, starts Claude Code, Codex and Pi processes, and gives you a lead agent that delegates to them, plus a TUI and real terminals to watch them in. It is a process manager for agents and it is good at that.</p>\n<p>Bellman starts nothing and supervises nothing. It holds a room and relays messages with provenance. The two solve different halves of the same problem, which is why this page is shorter than you might expect: if the agents you need are processes on your machine, OpenRig is the better tool, and a local process manager is simply not how you reach a session on someone else's.</p>",
    "decision": {
        "them": "running and supervising a team on your machine",
        "us": "reaching past that machine",
    },
    "axes": [
        {"axis": "What it manages", "them": "processes it started", "us": "nothing"},
        {"axis": "Where members run", "them": "pods on one machine", "us": "wherever they already are"},
        {"axis": "What it needs installed", "them": "Node 22 or 24, and tmux", "us": "nothing, for a remote MCP client"},
        {"axis": "Another person's agent", "them": "not addressed", "us": "a code away"},
        {"axis": "A cloud session it did not start", "them": "out of reach", "us": "an ordinary member"},
        {"axis": "Clients", "them": "Claude Code, Codex, Pi", "us": "any MCP client"},
    ],
    "better_at_html": "<p>It does the thing we have decided never to do: it owns the processes. Pods persist across a long project, the lead agent delegates without you brokering it, and you can attach a terminal to any member and watch. Codex, Pi and Claude Code sit side by side with no account of ours involved anywhere. For one person running a team on one box that is a complete answer, and we are not part of it.</p>\n<p>We think OpenRig is a complement rather than a competitor, and we would rather say so than imply a fight. <a href=\"https://github.com/bellman-sh/bellman/issues/85\">We are tracking what that could look like.</a></p>",
    "verified": {
        "against": "openrig.dev as published",
        "date": "2026-10-02",
        "sources": [{"label": "OpenRig", "url": "https://openrig.dev/"}],
    },
})

cfg["pages"].append({
    "slug": "frameworks",
    "question": "Why not just use CrewAI, LangGraph or AutoGen?",
    "subject": "Agent frameworks",
    "nav_label": "Frameworks",
    "card_summary": "Libraries you build an agent system with.",
    "reach": "agents you wrote, in your process",
    "stops_at": "code you deployed",
    "meta_description": "CrewAI, LangGraph and AutoGen are libraries you build an agent system with. Bellman does not want your process; it wants sessions that already exist to be able to talk.",
    "answer_html": "<p>CrewAI, LangGraph and AutoGen are libraries. You write the orchestration &mdash; a graph with explicit edges, a crew with roles, a group chat with a selector &mdash; and every agent in it is a call your process makes. You own the control flow, the retries and the deployment.</p>\n<p>Bellman does not want your process. Its members are sessions that already exist, that people are already working in, and it has no way to call one and no interest in having one. Nothing here competes: a crew you wrote can join a room, and a room cannot write your crew.</p>",
    "decision": {
        "them": "building an agent system",
        "us": "connecting ones you did not build",
    },
    "axes": [
        {"axis": "What you write", "them": "the orchestration", "us": "nothing"},
        {"axis": "Who owns the loop", "them": "your process", "us": "each member, itself"},
        {"axis": "What an agent is", "them": "a call your code makes", "us": "a session someone is in"},
        {"axis": "A human in the middle", "them": "whatever you build", "us": "a member, by default"},
        {"axis": "A session you did not start", "them": "no way to address it", "us": "a code away"},
    ],
    "better_at_html": "<p>Total control, and everything that follows from it. LangGraph gives you an explicit graph with checkpoints and rollback points, which is a large part of why it is the one most often in production. CrewAI gets a working crew out of about twenty lines. AutoGen's group chat with a speaker selector is a genuinely good fit for research. All three run in one process, so you can test them with no network, mock every call, and deploy them as a single artifact. None of them needs an account, a code, or a room.</p>\n<p>If you are building an agent system, build it with one of these. Reach for us when a member of it is not yours to build.</p>",
    "verified": {
        "against": "LangGraph 1.x, CrewAI and AG2 as documented",
        "date": "2026-10-02",
        "sources": [
            {"label": "LangGraph", "url": "https://github.com/langchain-ai/langgraph"},
            {"label": "CrewAI", "url": "https://github.com/crewAIInc/crewAI"},
            {"label": "AG2", "url": "https://github.com/ag2ai/ag2"},
        ],
    },
})

cfg["pages"].append({
    "slug": "chatgpt-space",
    "question": "Why not just use ChatGPT Space?",
    "subject": "ChatGPT Space",
    "nav_label": "ChatGPT Space",
    "card_summary": "A shared workspace inside ChatGPT.",
    "reach": "your organisation",
    "stops_at": "your workspace's membership and seats",
    "meta_description": "ChatGPT Space is a shared workspace where colleagues and OpenAI's agents work on Pages together. Its members are members of your ChatGPT workspace. Bellman's members hold a code and nothing of yours.",
    "answer_html": "<p>Space is the closest thing to a room anyone has shipped. You invite colleagues into a shared workspace inside ChatGPT, OpenAI's agents &mdash; ChatGPT, Codex, Dots &mdash; work alongside them, and the output lands in Pages everyone can edit at once. If your team is already one team on Business or Enterprise it is very good, and it does something no Anthropic feature on this site does: it brings other people in.</p>\n<p>The difference is the boundary. A Space's members are members of <em>your ChatGPT workspace</em> &mdash; a team join link does not put anyone in the workspace, and an outsider is onboarded into it by an owner or admin, on your seats. A Bellman room's members hold a code. They need no seat of yours, no plan, and no account in your organisation.</p>",
    "decision": {
        "them": "your colleagues and OpenAI's agents, in one document",
        "us": "a member is outside your workspace, or works somewhere other than ChatGPT",
    },
    "axes": [
        {"axis": "Who can be a member", "them": "a member of your ChatGPT workspace", "us": "anyone with the code"},
        {"axis": "What a member needs from you", "them": "a seat, and an admin to invite them", "us": "the code"},
        {"axis": "The shared thing", "them": "a Page everyone edits", "us": "an event log each member reads in its own session"},
        {"axis": "Which agents", "them": "ChatGPT, Codex, Dots", "us": "whatever each member is running"},
        {"axis": "Which client", "them": "ChatGPT, on web or desktop", "us": "any MCP client"},
        {"axis": "Where the work happens", "them": "OpenAI's workspace", "us": "wherever each member already was"},
    ],
    "better_at_html": "<p>It is a product and we are a protocol, and that gap is most of this list. Space has an interface people already know, with nothing to install. Pages and slides are edited simultaneously, with comments and export to PowerPoint or Google Slides. Meetings get summarised. It plugs into Slack and Microsoft Teams, and Dots keep working across all three. And it is built for people and agents in the same place, which is a better experience than reading relayed events in a terminal.</p>\n<p>If your collaborators are your colleagues, Space is the better choice. Ours is the narrower bet: that some of the agents you need to work with will never be in your workspace.</p>",
    "verified": {
        "against": "ChatGPT Space at launch",
        "date": "2026-10-02",
        "sources": [
            {"label": "Teams in ChatGPT", "url": "https://help.openai.com/en/articles/20001541-teams-in-chatgpt"},
        ],
    },
})

p.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"{len(cfg['pages'])} pages")
PY
```

Expected: `6 pages`.

- [ ] **Step 2: Regenerate and check the count**

```bash
./tools/build-compare.py
```

Expected: `wrote 7 files to public/compare`, no warnings, no removals.

- [ ] **Step 3: Prove the orphan sweep fires (positive control)**

```bash
cp public/compare/openrig.html public/compare/renamed-away.html
./tools/build-compare.py | grep removed
test -f public/compare/renamed-away.html && echo "STILL THERE — sweep is broken" || echo "swept"
```

Expected: a `removed public/compare/renamed-away.html — no page claims that slug` line, then `swept`.

- [ ] **Step 4: Check the copy against the constraints**

```bash
grep -rniE "the other session|both sessions|two sessions|a pair of" public/compare/ && echo "FOUND — rewrite it" || echo "members-not-two: clean"
grep -rniE "single.player|cannot invite|only you can" public/compare/chatgpt-space.html && echo "FOUND — check the facts table" || echo "space claims: clean"
```

Expected: `members-not-two: clean` and `space claims: clean`.

- [ ] **Step 5: Commit**

```bash
git add tools/compare.config.json public/compare
git commit -m "feat: compare OpenRig, the agent frameworks and ChatGPT Space

ChatGPT Space shipped on 2026-09-29, after the issue was filed, and it
is the closest thing to a room any vendor has shipped: you invite
colleagues and OpenAI's agents into one workspace. The page says so.

The distinction is tenancy, not people. A Space's members are members of
your ChatGPT workspace, on your seats; a room's members hold a code and
need no account of yours. The page does not claim Space is single-player,
because it is not, and it says nothing about whether a non-OpenAI agent
can join, because that is unconfirmed.

OpenRig is a complement and the page says that too."
```

---

### Task 6: Styles

**Files:**
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: the class names `render_page` and `render_index` emit — `.decision`, `.axes`, `.compare-cards`, `.compare-card`, `.verified`, `.fine`.
- Produces: no Python interface.

- [ ] **Step 1: Read the existing custom properties**

The rules below reference the site's own tokens through `var()` with a
fallback, so they render correctly either way. Find the real names and drop
the fallbacks where a token exists.

```bash
cd ~/src/github.com/bellman-sh/site
grep -n -- "--[a-z-]*:" public/styles.css | head -40
grep -n "^\.section\|^\.hero\|^table\|^\.btn" public/styles.css | head -20
```

- [ ] **Step 2: Append the rules**

Append to `public/styles.css`:

```css
/* ── compare ──────────────────────────────────────────────────────────── */

/* The decision line. The one sentence a reader quotes to a colleague, so it
   is the only thing on these pages with a border. */
.decision {
  border: 1px solid var(--rule, #2a333f);
  border-left: 3px solid var(--accent, #d9a521);
  border-radius: 6px;
  padding: 1rem 1.25rem;
  margin: 0;
  background: var(--raise, rgba(255, 255, 255, 0.03));
}
.decision p {
  margin: 0.35rem 0;
}

/* The axis table. Their column first: we are the challenger. */
.axes {
  width: 100%;
  border-collapse: collapse;
  margin-top: 1rem;
  font-size: 0.95rem;
}
.axes th,
.axes td {
  text-align: left;
  vertical-align: top;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--rule, #2a333f);
}
.axes thead th {
  font-weight: 600;
  white-space: nowrap;
}
.axes tbody th {
  font-weight: 500;
  color: var(--dim, #9aa7b4);
}
.axes tbody tr:last-child th,
.axes tbody tr:last-child td {
  border-bottom: 0;
}

/* Phone: the table is three columns of prose, so let it scroll inside its own
   box rather than widening the page. */
@media (max-width: 34rem) {
  .axes {
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .axes th,
  .axes td {
    padding: 0.5rem;
  }
}

/* The index cards. One per question. */
.compare-cards {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
}
.compare-card {
  border: 1px solid var(--rule, #2a333f);
  border-radius: 6px;
  padding: 1rem 1.25rem;
}
.compare-card h2 {
  font-size: 1.05rem;
  margin: 0 0 0.4rem;
  line-height: 1.3;
}
.compare-card p {
  margin: 0;
  color: var(--dim, #9aa7b4);
  font-size: 0.92rem;
}

/* What the page was checked against. Quiet, but present on every page. */
.verified,
.fine {
  color: var(--dim, #9aa7b4);
  font-size: 0.85rem;
}
.verified {
  margin-top: 1.5rem;
}
```

- [ ] **Step 3: Check it at phone width**

```bash
python3 -m http.server 4173 --directory public &
SERVER=$!
sleep 1
curl -sf http://localhost:4173/compare/ >/dev/null && echo "index 200"
curl -sf http://localhost:4173/compare/subagents.html >/dev/null && echo "page 200"
kill $SERVER
```

Expected: `index 200` and `page 200`. Then open `http://localhost:4173/compare/`
in a browser at 375px wide and confirm: no horizontal page scroll, the axis
table scrolls inside its own box, the decision box is legible, the cards stack.

- [ ] **Step 4: Commit**

```bash
git add public/styles.css
git commit -m "style: the decision box, the axis table and the compare cards

The decision line is the only thing on these pages with a border,
because it is the sentence a reader quotes to a colleague.

At phone width the axis table scrolls inside its own box: it is three
columns of prose and widening the page to fit it is worse."
```

---

### Task 7: Compare in the nav, in all three places

**Files:**
- Modify: `public/index.html`
- Modify: `tools/build-pricing.py`
- Modify: `public/pricing.html` (regenerated, not edited)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

`comparelib.BAR` and `comparelib.FOOT` already carry the link, from Task 3.
The other two page sources do not, and a link added to only one of them makes
pricing's nav silently diverge from every other page.

- [ ] **Step 1: Add it to the hand-written page**

In `public/index.html`, the header nav is around line 37 and the footer nav
around line 386. Add one line to each:

```bash
cd ~/src/github.com/bellman-sh/site
python3 - <<'PY'
import pathlib

p = pathlib.Path("public/index.html")
s = p.read_text(encoding="utf-8")

header_old = '    <a href="#install">Install</a>\n    <a href="/pricing">Pricing</a>'
header_new = '    <a href="#install">Install</a>\n    <a href="/compare/">Compare</a>\n    <a href="/pricing">Pricing</a>'
assert s.count(header_old) == 1, "header nav anchor did not match exactly once"
s = s.replace(header_old, header_new)

footer_old = '      <a href="/pricing">Pricing</a>'
footer_new = '      <a href="/compare/">Compare</a>\n      <a href="/pricing">Pricing</a>'
assert s.count(footer_old) == 1, "footer nav anchor did not match exactly once"
s = s.replace(footer_old, footer_new)

p.write_text(s, encoding="utf-8")
print("index.html: header and footer updated")
PY
```

Expected: `index.html: header and footer updated`. If an assertion fires, open
the file and place the link by hand rather than loosening the anchor.

- [ ] **Step 2: Add it to the pricing generator's skeleton**

```bash
python3 - <<'PY'
import pathlib

p = pathlib.Path("tools/build-pricing.py")
s = p.read_text(encoding="utf-8")

header_old = '    <a href="/#install">Install</a>\n    <a href="/pricing" aria-current="page">Pricing</a>'
header_new = '    <a href="/#install">Install</a>\n    <a href="/compare/">Compare</a>\n    <a href="/pricing" aria-current="page">Pricing</a>'
assert s.count(header_old) == 1, "pricing header anchor did not match exactly once"
s = s.replace(header_old, header_new)

footer_old = '      <a href="/">Home</a>\n      <a href="/pricing">Pricing</a>'
footer_new = '      <a href="/">Home</a>\n      <a href="/compare/">Compare</a>\n      <a href="/pricing">Pricing</a>'
assert s.count(footer_old) == 1, "pricing footer anchor did not match exactly once"
s = s.replace(footer_old, footer_new)

p.write_text(s, encoding="utf-8")
print("build-pricing.py: skeleton updated")
PY
```

Expected: `build-pricing.py: skeleton updated`.

- [ ] **Step 3: Regenerate pricing and confirm the diff is only the nav**

```bash
./tools/build-pricing.py
git diff --stat public/pricing.html
git diff public/pricing.html | grep '^[+-]' | grep -v '^[+-][+-]'
```

Expected: exactly two added lines, both `<a href="/compare/">Compare</a>`, and
no other change. If anything else moved, the generator and the committed file
had drifted before this task — stop and report it rather than committing a
regeneration that hides someone else's edit.

- [ ] **Step 4: Confirm every page now agrees**

```bash
for f in public/index.html public/pricing.html public/compare/index.html public/compare/subagents.html; do
  printf '%s: %s\n' "$f" "$(grep -c 'href="/compare/"' "$f")"
done
```

Expected: `2` for each of the first two (header and footer), and `2` for each
compare page as well.

- [ ] **Step 5: Commit**

```bash
git add public/index.html tools/build-pricing.py public/pricing.html
git commit -m "feat: put Compare in the nav, in all three page sources

index.html is hand-written, pricing.html comes from build-pricing.py's
skeleton, and the compare pages come from their own. A link added to one
of them makes that page's nav quietly disagree with the rest of the site,
so all three change together."
```

---

### Task 8: Document it, and run the gates

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Check every source URL actually resolves**

Six pages cite sources, and a few of those URLs were written from memory.
A comparison page citing a 404 is worse than one citing nothing.

```bash
cd ~/src/github.com/bellman-sh/site
python3 - <<'PY'
import json, pathlib, subprocess

cfg = json.loads(pathlib.Path("tools/compare.config.json").read_text(encoding="utf-8"))
bad = []
for page in cfg["pages"]:
    for source in page["verified"]["sources"]:
        url = source["url"]
        code = subprocess.run(
            ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
             "-L", "--max-time", "20", url],
            capture_output=True, text=True,
        ).stdout.strip()
        flag = "ok " if code.startswith("2") else "BAD"
        if flag == "BAD":
            bad.append((page["slug"], url, code))
        print(f"{flag} {code} {page['slug']:20} {url}")
print()
print(f"{len(bad)} bad" if bad else "all sources resolve")
PY
```

Expected: `all sources resolve`.

For any `BAD` line, find the real URL and fix it in the config, then
regenerate. A 403 from a site that blocks automated fetches (OpenAI's own
pages do) is not a dead link — open it in a browser to confirm, and leave it
if it loads there.

- [ ] **Step 2: Run every test and gate in one pass**

```bash
python3 -m unittest discover -s tools -p 'test_*.py' -q
./tools/build-compare.py
./tools/build-compare.py > /tmp/second-run.txt
git status --porcelain public/compare
```

Expected: tests pass; both builds succeed; `git status` prints **nothing** —
the second run changed no bytes, which is the idempotency gate.

- [ ] **Step 3: Serve locally and check all seven URLs**

```bash
python3 -m http.server 4173 --directory public &
SERVER=$!
sleep 1
for u in / compare/ compare/subagents.html compare/claude-agent-teams.html \
         compare/managed-agents.html compare/openrig.html \
         compare/frameworks.html compare/chatgpt-space.html pricing.html; do
  printf '%s %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:4173/$u")" "$u"
done
kill $SERVER
```

Expected: `200` on every line.

- [ ] **Step 4: Write the README section**

Append to `README.md`, after the Pricing section:

```markdown
## Compare

`public/compare/*.html` is **generated**. Do not edit those files.

```bash
$EDITOR tools/compare.config.json
./tools/build-compare.py
```

Six comparison pages and an index, one config. The token counts and the
decision lines live in one place instead of seven, and a seventh comparison
is a config entry.

Three rules the generator enforces rather than trusts:

- **A page with no `better_at_html` fails the build.** Saying what the other
  thing is better at is the comparison; a page without it is an advert. This
  is the check most worth keeping, because it is the one a deadline attacks.
- **Every prose fragment is parsed.** `answer_html` and `better_at_html` are
  raw HTML so the copy can use `<code>`, `<em>` and links, which means a typo
  would otherwise reach the page. An unclosed tag or a bare `<` is fatal.
- **A page no slug claims is deleted.** Rename a slug and the old file would
  otherwise sit in `public/` and keep being served.

A `verified.date` older than 90 days only warns. A page nobody has re-checked
is still true until someone checks it — but these facts rot faster than
anything else on the site, so the warning is loud.

### Keeping the comparisons honest

Every claim about another product must appear in the facts tables of
[the design spec](https://github.com/bellman-sh/bellman/blob/main/docs/superpowers/specs/2026-10-02-comparison-pages-design.md).
If a claim is not there, check it and add it, or cut it.

Two things that are explicitly **unconfirmed**, and that the ChatGPT Space page
therefore says nothing about: whether a non-OpenAI agent can participate in a
Space, and per-Space member limits. Do not fill those gaps from memory.

| Claim | Where to verify |
|---|---|
| Subagents are context-isolated, not context-sharing | [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) |
| Claude Code reaches your sessions on other machines, but only yours | [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) |
| A ChatGPT Space member must already be in your workspace | [Teams in ChatGPT](https://help.openai.com/en/articles/20001541-teams-in-chatgpt) |
| OpenRig is tmux pods on one machine, needing Node and tmux | [openrig.dev](https://openrig.dev/) |
| Tool definitions cost ~3,730 tokens | `bellman/docs/ARCHITECTURE.md` §11 |
```

- [ ] **Step 5: Deploy a preview and confirm extension-less nested URLs**

The site's existing clean URLs are all top-level (`/pricing`). A nested
directory is unproven, and it is the one thing local `http.server` cannot
tell you, because it serves `/compare/subagents` as a 404 while Cloudflare
may not.

```bash
npx wrangler versions upload 2>&1 | tee /tmp/preview.txt
PREVIEW=$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' /tmp/preview.txt | head -1)
echo "preview: $PREVIEW"
for u in /compare/ /compare/subagents /compare/chatgpt-space /pricing; do
  printf '%s %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' -L "$PREVIEW$u")" "$u"
done
```

Expected: `200` on all four. If `/compare/subagents` is a 404 while
`/compare/subagents.html` is a 200, Cloudflare is not doing extension-less
matching inside a directory. Fix it by writing each page as
`public/compare/<slug>/index.html` instead: change the `wanted` dict in
`comparelib.write_all` to key on `f"{slug}/index.html"`, `mkdir` each
parent, and change the sweep's glob to `**/*.html`. Re-run Task 8 Step 2
and Step 3 after that change, and update the `curl` paths in Step 3.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: how the compare pages are built, and how to keep them honest

Every claim about another product has to appear in the spec's facts
tables, and two ChatGPT Space facts are marked unconfirmed so nobody
fills them in from memory later."
```

---

### Task 9: Open the PR, and close #83

**Files:** none.

**Interfaces:** none.

- [ ] **Step 1: Confirm the branch is clean and complete**

```bash
cd ~/src/github.com/bellman-sh/site
git status --porcelain
git log --oneline main..HEAD
```

Expected: no uncommitted changes, and six commits.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin mcfearsome/compare-pages
gh pr create --repo bellman-sh/bellman.sh --title "Six comparison pages, starting with \"why not just use subagents?\"" --body "$(cat <<'BODY'
Closes bellman-sh/bellman#83.

Six pages and an index at `/compare/`, generated from one config the way
`pricing.html` is. [Design spec](https://github.com/bellman-sh/bellman/blob/main/docs/superpowers/specs/2026-10-02-comparison-pages-design.md).

## What the research changed

Two things in #83 did not survive checking, and both are in the spec:

- **Claude Code shipped cross-session messaging** in v2.1.224. It reaches
  your other local sessions, your cloud sessions, and your sessions on other
  machines through Remote Control. "Separate machines" is not a
  differentiator, and a page claiming it would have been wrong the day it
  published. What survives is narrower and true: the inbox socket is
  restricted to your OS user, so another person's sessions cannot reach it,
  and it is Claude Code to Claude Code.
- **Subagents are context-isolated**, not context-sharing. #83 says they
  "share its context lineage"; a subagent starts with its own system prompt
  and the delegated task, and a fork is the exception.

**ChatGPT Space** also landed on 2026-09-29, after #83 was filed, so it gets
the sixth page. It is the closest thing to a room any vendor has shipped, and
it breaks the single line #83 proposed — its members *are* other people. So
the spine is a reach ladder instead: every tool here stops somewhere (the
turn, your OS user, your account, your machine, your process, your
workspace's seats), and a room's members need none of it.

## What the build enforces

- A page with no "what it is better at" section **fails the build**. That
  section is the comparison, and it is the one a deadline attacks.
- Every prose fragment is parsed; an unclosed tag is fatal.
- A page no slug claims is deleted, so a renamed slug cannot leave a stale
  page being served.
- A `verified.date` over 90 days old warns loudly.

Each of those was proven by breaking it on purpose; the steps are in the plan.

## Verification

- `python3 -m unittest discover -s tools -p 'test_*.py'` — 37 tests
- `./tools/build-compare.py` twice, `git status` clean after the second
- every cited source URL checked for a 2xx
- all seven URLs served locally, and on a wrangler preview extension-less
- 375px wide: no horizontal page scroll
- `pricing.html` regenerated; the only diff is the two new nav links
BODY
)"
```

- [ ] **Step 3: Close #83 against the PR**

```bash
PR=$(gh pr view --repo bellman-sh/bellman.sh --json url -q .url)
gh issue comment 83 --repo bellman-sh/bellman --body "Shipped in $PR — six pages at \`/compare/\`, generated from one config.

Two corrections to this issue, both recorded in [the spec](https://github.com/bellman-sh/bellman/blob/main/docs/superpowers/specs/2026-10-02-comparison-pages-design.md):

- Subagents do not share the parent's context lineage. They are context-isolated by default; a fork is the exception.
- Claude Code shipped cross-session messaging in v2.1.224, which reaches your sessions on other machines. \"Separate machines\" is not the differentiator. Ownership and client are: the inbox socket is restricted to your OS user, and it is Claude Code to Claude Code.

ChatGPT Space shipped on 2026-09-29, after this was filed, so it got the sixth page. It also broke the line this issue proposed — \"Bellman is for when the other agent is not yours\" — because a Space's members are other people. The page argues tenancy instead: a Space's members are members of your ChatGPT workspace, on your seats.

The OpenRig page says it is a complement, and links #85."
gh issue close 83 --repo bellman-sh/bellman --reason completed
```

- [ ] **Step 4: Report the PR URL**

Print it for the human partner, and note anything the gates flagged that was
left unfixed.

---

## Notes for whoever executes this

**The plan refines the spec in three places.** Each is a deliberate change,
not a drift:

1. **The generator is two files, not one.** `build-pricing.py` has a hyphen
   and cannot be imported, so its logic is untestable. `comparelib.py` holds
   everything worth a test and `build-compare.py` is a thin CLI. The spec said
   "modelled on build-pricing.py"; this keeps the shape and the invocation and
   gains unit tests.
2. **`verified.sources` is a list, not a scalar `source`.** The frameworks page
   rests on three products' documentation and the ChatGPT Space page on more
   than one page. A single URL would have forced one of them to lie by
   omission.
3. **The orphan sweep is new.** It is Review Focus item 1, and the spec did not
   anticipate it.

**The content is the deliverable, and it is drawn from the spec's facts
tables.** If while writing you find a claim you cannot trace to a row in those
tables, that is the signal to stop and check it — not to soften the wording
until it sounds safe.
