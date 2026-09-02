"""Markdown for the report editor: HTML preview and PDF export."""

import html
import io
import os
import re
import time

try:
    from markdown_it import MarkdownIt
    HAVE_MD = True
except ImportError:
    MarkdownIt = None
    HAVE_MD = False

try:
    import linkify_it
    HAVE_LINKIFY = True
except ImportError:
    HAVE_LINKIFY = False

try:
    from pygments import highlight as _pyg_highlight
    from pygments.formatters import HtmlFormatter
    from pygments.lexers import get_lexer_by_name, guess_lexer
    from pygments.util import ClassNotFound
    HAVE_PYGMENTS = True
except ImportError:
    HAVE_PYGMENTS = False

try:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (BaseDocTemplate, Frame, HRFlowable, Image,
                                    KeepTogether, ListFlowable, ListItem,
                                    NextPageTemplate, PageBreak, PageTemplate,
                                    Paragraph, Preformatted, Spacer, Table,
                                    TableStyle)
    HAVE_PDF = True
except ImportError:
    HAVE_PDF = False

try:
    from PIL import Image as PILImage
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False


APT_HINT = {
    "md": "sudo apt install python3-markdown-it",
    "pdf": "sudo apt install python3-reportlab",
}


def deps():
    """Dependency status, so the UI can warn precisely."""
    return {
        "markdown": HAVE_MD, "pygments": HAVE_PYGMENTS,
        "pdf": HAVE_PDF, "pil": HAVE_PIL, "linkify": HAVE_LINKIFY,
        "hint_md": APT_HINT["md"], "hint_pdf": APT_HINT["pdf"],
    }


WIKILINK = re.compile(r"\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]")
_ATLAS_HREF = re.compile(r"^atlas:node:(\d+)$")


def expand_wikilinks(text, nodes):
    """Turn [[SQL01]] and [[SQL01|the server]] into normal Markdown links."""
    by_name = {}
    for n in nodes:
        name = (n.get("name") or "").strip().lower()
        if name and name not in by_name:
            by_name[name] = n

    def sub(m):
        target = m.group(1).strip()
        label = (m.group(2) or target).strip()
        n = by_name.get(target.lower())
        nid = n["id"] if n else 0
        return "[%s](atlas:node:%d)" % (label, nid)

    return WIKILINK.sub(sub, text or "")


def wikilink_names(text):
    """The names referenced with [[...]] in the document."""
    return [m.group(1).strip() for m in WIKILINK.finditer(text or "")]


def _md():
    return MarkdownIt("js-default", {"breaks": False, "linkify": HAVE_LINKIFY})


def parse(text):
    """markdown-it tokens. Raises RuntimeError if the library is missing."""
    if not HAVE_MD:
        raise RuntimeError(
            "markdown-it-py is required to process the document (%s)" % APT_HINT["md"])
    return _md().parse(text or "")


def pygments_css(style="monokai"):
    if not HAVE_PYGMENTS:
        return ""
    return HtmlFormatter(style=style).get_style_defs(".hl")


def to_html(text, nodes=None):
    """Preview HTML. Without markdown-it it returns the raw text."""
    text = expand_wikilinks(text, nodes or [])
    if not HAVE_MD:
        return ('<div class="mdwarn">Instala markdown-it-py para la vista previa '
                'formateada: <code>%s</code></div><pre class="mdraw">%s</pre>'
                % (APT_HINT["md"], html.escape(text)))
    md = _md()

    def link_open(self, tokens, idx, options, env):
        tok = tokens[idx]
        href = tok.attrGet("href") or ""
        m = _ATLAS_HREF.match(href)
        if m:
            nid = int(m.group(1))
            if nid:
                return '<a class="wikilink" href="#" data-node-id="%d">' % nid
            return '<span class="wikilink broken" title="no node with that name">'
        if href.startswith(("http://", "https://")):
            tok.attrSet("target", "_blank")
            tok.attrSet("rel", "noopener noreferrer")
        return self.renderToken(tokens, idx, options, env)

    def link_close(self, tokens, idx, options, env):
        opens = 0
        for t in reversed(tokens[:idx]):
            if t.type == "link_close":
                opens += 1
            elif t.type == "link_open":
                if opens:
                    opens -= 1
                    continue
                m = _ATLAS_HREF.match(t.attrGet("href") or "")
                if m and int(m.group(1)) == 0:
                    return "</span>"
                break
        return "</a>"

    def fence(self, tokens, idx, options, env):
        tok = tokens[idx]
        info = (tok.info or "").strip().split()
        lang = info[0] if info else ""
        code = tok.content
        attr = ' data-lang="%s"' % html.escape(lang, quote=True) if lang else ""
        label = ('<span class="cb-lang">%s</span>' % html.escape(lang)) if lang else ""
        if HAVE_PYGMENTS:
            try:
                lexer = get_lexer_by_name(lang) if lang else guess_lexer(code)
            except (ClassNotFound, ValueError):
                lexer = None
            if lexer is not None:
                out = _pyg_highlight(code, lexer, HtmlFormatter(cssclass="hl"))
                return '<div class="codewrap"%s>%s%s</div>' % (attr, label, out)
        return ('<div class="codewrap"%s>%s<pre class="hl"><code>%s</code></pre></div>'
                % (attr, label, html.escape(code)))

    def image(self, tokens, idx, options, env):
        tok = tokens[idx]
        src = tok.attrGet("src") or ""
        alt = tok.content or ""
        title = tok.attrGet("title") or ""
        cap = title or alt
        return ('<figure class="mdfig"><img src="%s" alt="%s" loading="lazy">'
                '%s</figure>' % (html.escape(src, quote=True), html.escape(alt),
                                 ('<figcaption>%s</figcaption>' % html.escape(cap)) if cap else ""))

    md.add_render_rule("link_open", link_open)
    md.add_render_rule("link_close", link_close)
    md.add_render_rule("fence", fence)
    md.add_render_rule("image", image)
    return md.render(text)


_INLINE_TAGS = {
    "strong_open": "<b>", "strong_close": "</b>",
    "em_open": "<i>", "em_close": "</i>",
    "s_open": "<strike>", "s_close": "</strike>",
}


def _inline_pdf(tok):
    """Inline tokens -> the mini-HTML that ReportLab's Paragraph understands."""
    out = []
    for t in (tok.children or []):
        if t.type == "text":
            out.append(html.escape(t.content))
        elif t.type in _INLINE_TAGS:
            out.append(_INLINE_TAGS[t.type])
        elif t.type == "code_inline":
            out.append('<font face="Courier" size="9">%s</font>' % html.escape(t.content))
        elif t.type == "softbreak":
            out.append(" ")
        elif t.type == "hardbreak":
            out.append("<br/>")
        elif t.type == "link_open":
            href = t.attrGet("href") or ""
            if _ATLAS_HREF.match(href):
                out.append("<b>")
            else:
                out.append('<a href="%s" color="#b3123b">' % html.escape(href, quote=True))
        elif t.type == "link_close":
            out.append("</a>")
        elif t.type == "image":
            pass
        elif t.type == "html_inline":
            out.append(html.escape(t.content))
    s = "".join(out)
    if s.count("<a ") != s.count("</a>"):
        s = s.replace("</a>", "</b>", s.count("</a>") - s.count("<a "))
    return s


def _images_in(tok):
    """(src, caption) for any images inside an inline token."""
    out = []
    for t in (tok.children or []):
        if t.type == "image":
            cap = t.attrGet("title") or t.content or ""
            out.append((t.attrGet("src") or "", cap))
    return out


def _styles():
    ss = getSampleStyleSheet()
    base = dict(fontName="Helvetica", fontSize=10, leading=14.5, spaceAfter=7,
                textColor=colors.HexColor("#1a1d24"))
    st = {
        "body": ParagraphStyle("body", alignment=TA_JUSTIFY, **base),
        "h1": ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=19, leading=24,
                             spaceBefore=16, spaceAfter=10,
                             textColor=colors.HexColor("#b3123b")),
        "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=14.5, leading=19,
                             spaceBefore=14, spaceAfter=7,
                             textColor=colors.HexColor("#1a1d24")),
        "h3": ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=11.5, leading=16,
                             spaceBefore=11, spaceAfter=5,
                             textColor=colors.HexColor("#3a4150")),
        "h4": ParagraphStyle("h4", fontName="Helvetica-BoldOblique", fontSize=10.5,
                             leading=15, spaceBefore=9, spaceAfter=4,
                             textColor=colors.HexColor("#3a4150")),
        "quote": ParagraphStyle("quote", fontName="Helvetica-Oblique", fontSize=9.8,
                                leading=14, leftIndent=10, spaceAfter=8,
                                textColor=colors.HexColor("#4a5160"),
                                borderColor=colors.HexColor("#d8dce4"), borderWidth=0),
        "code": ParagraphStyle("code", fontName="Courier", fontSize=8.4, leading=11.4,
                               textColor=colors.HexColor("#12151c")),
        "caption": ParagraphStyle("caption", fontName="Helvetica-Oblique", fontSize=8.5,
                                  leading=11, alignment=TA_CENTER, spaceBefore=3,
                                  spaceAfter=10, textColor=colors.HexColor("#6a7280")),
        "cover_t": ParagraphStyle("cover_t", fontName="Helvetica-Bold", fontSize=27,
                                  leading=33, alignment=TA_CENTER,
                                  textColor=colors.HexColor("#b3123b")),
        "cover_s": ParagraphStyle("cover_s", fontName="Helvetica", fontSize=13,
                                  leading=18, alignment=TA_CENTER,
                                  textColor=colors.HexColor("#3a4150")),
        "cover_m": ParagraphStyle("cover_m", fontName="Helvetica", fontSize=9.5,
                                  leading=14, alignment=TA_CENTER,
                                  textColor=colors.HexColor("#6a7280")),
        "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=8.6, leading=11.6),
        "cellh": ParagraphStyle("cellh", fontName="Helvetica-Bold", fontSize=8.6,
                                leading=11.6, textColor=colors.white),
        "tbl_ss": ss,
    }
    return st


def _resolve_image(src, captures_dir, capture_lookup):
    """From a document image URL to the real file on disk."""
    dirs = [captures_dir] if isinstance(captures_dir, str) else list(captures_dir or [])
    m = re.search(r"/api/captures/(\d+)/file", src or "")
    if m and capture_lookup:
        c = capture_lookup(int(m.group(1)))
        if c and c.get("filename"):
            for d in dirs:
                p = os.path.join(d, os.path.basename(c["filename"]))
                if os.path.isfile(p):
                    return p
    if src and not src.startswith(("http://", "https://", "data:")):
        for d in dirs:
            p = os.path.join(d, os.path.basename(src))
            if os.path.isfile(p):
                return p
    return None


def _fit_image(path, max_w, max_h):
    """Image scaled to fit the page width without distortion."""
    w = h = None
    if HAVE_PIL:
        try:
            with PILImage.open(path) as im:
                w, h = im.size
        except Exception:
            w = h = None
    if not w or not h:
        return Image(path, width=max_w, height=max_w * 0.6)
    ratio = min(max_w / float(w), max_h / float(h), 1.0)
    return Image(path, width=w * ratio, height=h * ratio)


def to_pdf(text, title="Report", project=None, nodes=None,
           captures_dir="", capture_lookup=None):
    """Return the PDF bytes. Raises RuntimeError if ReportLab is missing."""
    if not HAVE_PDF:
        raise RuntimeError(
            "ReportLab is required to export to PDF (%s)" % APT_HINT["pdf"])
    tokens = parse(expand_wikilinks(text, nodes or []))
    S = _styles()
    buf = io.BytesIO()

    page_w, page_h = A4
    margin = 20 * mm
    avail = page_w - 2 * margin
    proj_name = (project or {}).get("name") or "Audit"
    stamp = time.strftime("%Y-%m-%d")

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#9aa1ad"))
        canvas.drawString(margin, 12 * mm, "%s · %s" % (proj_name, title))
        canvas.drawRightString(page_w - margin, 12 * mm, "Page %d" % doc.page)
        canvas.drawCentredString(page_w / 2.0, 12 * mm, "CONFIDENTIAL")
        canvas.setStrokeColor(colors.HexColor("#e2e6ec"))
        canvas.line(margin, 15 * mm, page_w - margin, 15 * mm)
        canvas.restoreState()

    doc = BaseDocTemplate(buf, pagesize=A4, leftMargin=margin, rightMargin=margin,
                          topMargin=margin, bottomMargin=25 * mm,
                          title=title, author="ATLAS", subject=proj_name)
    frame = Frame(margin, 25 * mm, avail, page_h - margin - 25 * mm, id="main")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[frame]),
        PageTemplate(id="body", frames=[frame], onPage=footer),
    ])

    story = []

    story.append(Spacer(1, 52 * mm))
    story.append(Paragraph(html.escape(title), S["cover_t"]))
    story.append(Spacer(1, 6 * mm))
    story.append(HRFlowable(width="38%", thickness=1.4, color=colors.HexColor("#b3123b"),
                            hAlign="CENTER"))
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(html.escape(proj_name), S["cover_s"]))
    if (project or {}).get("scope"):
        story.append(Spacer(1, 3 * mm))
        story.append(Paragraph("Scope: %s" % html.escape(project["scope"]), S["cover_m"]))
    story.append(Spacer(1, 10 * mm))
    story.append(Paragraph("Generated on %s with ATLAS" % stamp, S["cover_m"]))
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(
        "Confidential document. It contains sensitive information obtained during an "
        "authorised audit; distribution is restricted to the parties of the engagement.",
        S["cover_m"]))
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())

    i, n = 0, len(tokens)
    list_stack = []
    item_buf = None

    def emit(flow):
        """A flowable goes to the open list item, or straight to the story."""
        if item_buf is not None:
            item_buf.append(flow)
        else:
            story.append(flow)

    while i < n:
        t = tokens[i]
        ty = t.type

        if ty == "heading_open":
            lvl = int(t.tag[1]) if len(t.tag) > 1 and t.tag[1].isdigit() else 2
            txt = _inline_pdf(tokens[i + 1]) if i + 1 < n else ""
            emit(Paragraph(txt, S.get("h%d" % min(lvl, 4), S["h4"])))
            if lvl == 1:
                emit(HRFlowable(width="100%", thickness=0.7,
                                color=colors.HexColor("#e6c8d2"), spaceAfter=8))
            i += 3
            continue

        if ty == "paragraph_open":
            inl = tokens[i + 1] if i + 1 < n else None
            if inl is not None:
                txt = _inline_pdf(inl).strip()
                if txt:
                    emit(Paragraph(txt, S["body"]))
                for src, cap in _images_in(inl):
                    path = _resolve_image(src, captures_dir, capture_lookup)
                    if path:
                        img = _fit_image(path, avail, page_h * 0.62)
                        block = [img]
                        if cap:
                            block.append(Paragraph(html.escape(cap), S["caption"]))
                        emit(KeepTogether(block))
                    else:
                        emit(Paragraph("<i>[imagen no encontrada: %s]</i>"
                                       % html.escape(src), S["caption"]))
            i += 3
            continue

        if ty in ("bullet_list_open", "ordered_list_open"):
            list_stack.append(("ol" if ty[0] == "o" else "ul", []))
            i += 1
            continue

        if ty in ("bullet_list_close", "ordered_list_close"):
            kind, items = list_stack.pop() if list_stack else ("ul", [])
            if items:
                lf = ListFlowable(
                    items, bulletType="1" if kind == "ol" else "bullet",
                    bulletFontName="Helvetica", bulletFontSize=9,
                    leftIndent=14, bulletColor=colors.HexColor("#b3123b"),
                    spaceAfter=8)
                if list_stack:
                    list_stack[-1][1].append(ListItem(lf))
                else:
                    story.append(lf)
            i += 1
            continue

        if ty == "list_item_open":
            item_buf = []
            i += 1
            continue

        if ty == "list_item_close":
            if list_stack and item_buf is not None:
                list_stack[-1][1].append(ListItem(item_buf or [Spacer(1, 1)],
                                                  leftIndent=14))
            item_buf = None
            i += 1
            continue

        if ty == "fence" or ty == "code_block":
            code = (t.content or "").rstrip("\n")
            box = Table([[Preformatted(code, S["code"])]], colWidths=[avail])
            box.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f4f5f8")),
                ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#dfe3ea")),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]))
            emit(box)
            emit(Spacer(1, 7))
            i += 1
            continue

        if ty == "table_open":
            rows, aligns, j, head_rows = [], [], i + 1, 0
            in_head = False
            while j < n and tokens[j].type != "table_close":
                tt = tokens[j].type
                if tt == "thead_open":
                    in_head = True
                elif tt == "thead_close":
                    in_head = False
                elif tt == "tr_open":
                    cur = []
                    j += 1
                    while j < n and tokens[j].type != "tr_close":
                        if tokens[j].type in ("th_open", "td_open"):
                            style = "cellh" if tokens[j].type == "th_open" else "cell"
                            content = ""
                            if j + 1 < n and tokens[j + 1].type == "inline":
                                content = _inline_pdf(tokens[j + 1])
                            cur.append(Paragraph(content, S[style]))
                        j += 1
                    rows.append(cur)
                    if in_head:
                        head_rows += 1
                j += 1
            if rows:
                ncols = max(len(r) for r in rows)
                for r in rows:
                    while len(r) < ncols:
                        r.append(Paragraph("", S["cell"]))
                tbl = Table(rows, colWidths=[avail / float(ncols)] * ncols,
                            repeatRows=head_rows or 1, hAlign="LEFT")
                tbl.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, (head_rows or 1) - 1),
                     colors.HexColor("#b3123b")),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d8dce4")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ("ROWBACKGROUNDS", (0, head_rows or 1), (-1, -1),
                     [colors.white, colors.HexColor("#f7f8fa")]),
                ]))
                emit(tbl)
                emit(Spacer(1, 9))
            i = j + 1
            continue

        if ty == "blockquote_open":
            j, parts = i + 1, []
            depth = 1
            while j < n:
                if tokens[j].type == "blockquote_open":
                    depth += 1
                elif tokens[j].type == "blockquote_close":
                    depth -= 1
                    if depth == 0:
                        break
                elif tokens[j].type == "inline":
                    parts.append(_inline_pdf(tokens[j]))
                j += 1
            body = "<br/>".join(p for p in parts if p)
            cell = Table([[Paragraph(body, S["quote"])]], colWidths=[avail])
            cell.setStyle(TableStyle([
                ("LINEBEFORE", (0, 0), (0, -1), 2.2, colors.HexColor("#b3123b")),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fafbfc")),
            ]))
            emit(cell)
            emit(Spacer(1, 7))
            i = j + 1
            continue

        if ty == "hr":
            emit(HRFlowable(width="100%", thickness=0.7,
                            color=colors.HexColor("#dfe3ea"), spaceBefore=6, spaceAfter=10))
            i += 1
            continue

        i += 1

    if len(story) <= 12:
        story.append(Paragraph("<i>The document is empty.</i>", S["body"]))

    doc.build(story)
    return buf.getvalue()
