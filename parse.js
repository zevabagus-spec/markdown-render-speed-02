// A fast drop-in for marked 18.1.3 (default options, GFM on): parse(markdown)
// returns exactly the HTML marked renders, byte for byte. Written from scratch
// for the make.fun markdown-render-speed-02 bounty; no dependencies, no vendored
// code. Architecture: a line-based block parser (container stack, lazy
// continuation) producing block nodes, then an inline scanner with a delimiter
// stack for emphasis / strikethrough, then a renderer. Link reference
// definitions are collected document-wide during block parsing, so inline
// parsing (which runs at render time) resolves definitions that appear later
// in the document, exactly like the reference.

// ---------------------------------------------------------------------------
// Character helpers and HTML escaping
// ---------------------------------------------------------------------------

const ESCAPES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

// Escape text the way the reference does when it does NOT preserve entities:
// every & < > " ' becomes an entity.
const ESC_ALL_RE = /[&<>"']/g;
function escapeAll(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  return s.replace(ESC_ALL_RE, (c) => ESCAPES[c]);
}

// Escape text while leaving valid-looking entities (&name; &#123; &#xAB;) alone.
const ESC_KEEP_ENT_RE = /&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)|[<>"']/g;
function escapeKeepEnt(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  return s.replace(ESC_KEEP_ENT_RE, (c) => ESCAPES[c]);
}

const NUMREF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
// Decode numeric character references the way the reference does: 0, surrogates
// and > U+10FFFF become U+FFFD, 38 becomes &amp; (so it survives escaping).
function decodeNumericRefs(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g, (_m, dec, hex) => {
    const n = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

function encodeUri(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link label: trim, collapse internal whitespace to one space,
// case-fold (lower then upper then lower, as the reference does).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function isSpace(c) { return c === 32 || c === 9; }
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ASCII punctuation test (CommonMark's punctuation class, ASCII only).
function isAsciiPunct(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
         (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}
function isPunctChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  if (code < 128) return isAsciiPunct(code);
  // Unicode punctuation / symbol: use a cached regex test on the single char.
  return PUNCT_RE.test(ch);
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
// Whitespace for delimiter flanking: the reference uses JS \s (Unicode
// whitespace, including NBSP and other Unicode spaces), not just ASCII.
const WS_RE = /\s/;
function isSpaceChar(ch) {
  return WS_RE.test(ch);
}
function isAlnumChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return /[\p{L}\p{N}]/u.test(ch);
}

// Visual column width of the leading whitespace of a line (tab = next
// multiple of 4). Returns [columns, stringIndexAfterWhitespace].
function leadingIndent(s, col0 = 0) {
  // Leading indent in columns, measured from absolute column `col0`
  // (tabs expand to the next multiple of 4). Returns [indent, chars].
  let col = col0, i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return [col - col0, i];
}

// Remove up to `cols` columns of indentation from the start of a line. Tabs
// in the leading whitespace are expanded to spaces first (relative to their
// absolute columns), so a tab that straddles the boundary leaves the right
// number of spaces behind.
function stripIndentCols(s, cols, col0 = 0) {
  if (cols <= 0) return s; // nothing to strip: keep tabs verbatim
  // Only expand tabs that are (partly) inside the stripped region: once
  // `col` reaches `col0 + cols` the rest of the line is content, tabs
  // included. A tab straddling the cut becomes spaces for its remainder.
  let col = col0, i = 0, out = '';
  while (i < s.length && col - col0 < cols) {
    const c = s.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return out.slice(cols) + s.slice(i);
}

// Expand the leading whitespace run of `s` to spaces, with tabs advancing
// to the next multiple of four from absolute column `col0`. The reference
// expands a list item's leading whitespace this way before removing the
// item indent, so a tab the strip ends on becomes spaces, not a tab.
function expandLeadingTabs(s, col0 = 0) {
  let col = col0, i = 0, out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { out += ' '; i++; col++; }
    else if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); i++; col += w; }
    else break;
  }
  return out + s.slice(i);
}

// Remove up to `n` leading whitespace characters (spaces or tabs, each
// counting as one) from `s`. The reference strips a fenced code block's
// content this way: by character count, not columns.
function stripFenceIndent(s, n) {
  let i = 0;
  while (i < s.length && n > 0 && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) { i++; n--; }
  return s.slice(i);
}

// Remove `cols` columns from the start of `s`, where `s` begins at absolute
// column `col0` (tabs expand relative to col0).
function stripIndentColsAt(s, cols, col0) {
  let col = col0, i = 0, out = '';
  while (i < s.length && col < col0 + cols) {
    const c = s.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return out.slice(cols) + s.slice(i);
}

// Expand tabs in a string to spaces, starting at column `col0`.
function expandTabs(s, col0) {
  if (s.indexOf('\t') === -1) return s;
  let out = '', col = col0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w); col += w;
    } else { out += ch; col++; }
  }
  return out;
}

// Strip trailing blank lines the way the reference's "ge" does: keep at most
// one trailing blank line; if there are two or more, drop them all.
function stripTrailingBlanks(text) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && isBlankLine(lines[t])) t--;
  if (lines.length - t <= 2) return text;
  return lines.slice(0, t + 1).join('\n');
}

// Check whether parens in `s` are balanced; returns -1 when balanced,
// -2 when a closing paren appears with nothing open, else the index of the
// first unmatched closing paren.
function parenBalance(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Nodes: {k:'t', s} text (numeric refs already decoded; escaped at render)
//        {k:'code', s} code span content (raw; newlines already folded)
//        {k:'br'} hard break
//        {k:'html', s} raw HTML tag/comment/etc.
//        {k:'link', href, title, img, auto, children} link or image
//        {k:'em'|'strong'|'del', children}
//        {k:'d', ch, len, open, close} delimiter run (removed by emphasis pass)

const SPECIAL_RE = /[\\`*_~<>&\[!\n]/g;
const EMAIL_LOCAL = /[A-Za-z0-9._+\-]+@/;
const EMAIL_RE = /[A-Za-z0-9._+\-]+@[a-zA-Z0-9\-_]+(?:\.[a-zA-Z0-9\-_]*[a-zA-Z0-9])+(?![\w-])/y;
const MAILTO_RE = /(?:mailto:[A-Za-z0-9._+\-]+@[a-zA-Z0-9\-_]+(?:\.[a-zA-Z0-9\-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+\-]+@[a-zA-Z0-9\-_]+(?:\.[a-zA-Z0-9\-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/y;
// Special chars for the autolink candidate window: like SPECIAL_RE but
// without '_' — the reference's GFM text rule does not stop at '_' inside
// an email address, so the window must extend across it.
const SCAN_RE = /[\\`*~<>&\[!\n]/g;
// Narrow email local-part characters, matching EMAIL_RE above.
const LOCAL_NARROW_RE = /[A-Za-z0-9._+\-]/;
const SCHEME_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//;
const SCHEME_URL_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/;
const WWW_RE = /^www\.(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const AUTOLINK_RE = /^<(?:([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*)|([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])))>/;
const TAG_RE = /^(?:<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)/;
const PUNCT_ESC_RE = /\\([\p{P}\p{S}])/gu;

// --- marked 18 emphasis (emStrong / del) over the node list -------------
// The reference does NOT use the CommonMark delimiter stack: its emStrong
// scans the masked source (inline links, code spans and HTML tags replaced
// by same-length "[aaa...]" placeholders) for a closer, with the "rule of
// 3" and an opener/closer budget. `~` (del) is a separate opener-driven
// scan that requires equal-length runs. The node list is the masked
// source's equivalent: code/link/html nodes are atomic, so their inner
// delimiters are invisible, and neighbour characters are read off the
// adjacent nodes (only the punctuation class matters to the classifier,
// and both '`' and ']' are punctuation).

const OPEN_QUOTE_RE = /[\p{Pi}\p{Ps}"']/u;
function isOpenQuoteChar(ch) {
  return !!ch && OPEN_QUOTE_RE.test(ch);
}

// First / last character of a node, as the reference's masked source would
// see it next to a delimiter run: a code span is masked as "[aaa...]" and
// a regular link (or a bracketed autolink, masked by the html alternative)
// as "[aaa...]", so both read as punctuation at the boundary. An extended
// autolink (www./email, no brackets) is NOT masked — the reference sees
// its display text — so it reads as its own first/last character. A
// wrapped em/strong/del reads as its own delimiter character.
function nodeFirstChar(node) {
  switch (node.k) {
    case 't': return node.s.length ? node.s[0] : '';
    case 'esc': return node.s;
    case 'code': return '`';
    case 'link': {
      if (node.auto && !node.angle && node.children && node.children.length) {
        const c = nodeFirstChar(node.children[0]);
        if (c !== '') return c;
      }
      return node.img ? '!' : '[';
    }
    case 'html': return '<';
    case 'br': return ' ';
    case 'em': case 'strong': case 'del': return node.ch || '';
    case 'd': return node.ch;
    default: return '';
  }
}
function nodeLastChar(node) {
  switch (node.k) {
    case 't': return node.s.length ? node.s[node.s.length - 1] : '';
    case 'esc': return node.s;
    case 'code': return '`';
    case 'link': {
      if (node.auto && !node.angle && node.children && node.children.length) {
        const c = nodeLastChar(node.children[node.children.length - 1]);
        if (c !== '') return c;
      }
      return ')';
    }
    case 'html': return '>';
    case 'br': return '\n';
    case 'em': case 'strong': case 'del': return node.ch || '';
    case 'd': return node.ch;
    default: return '';
  }
}

// Classify a delimiter run by its neighbours, the reference's RDelim
// groups: 1 = prev punct + next space/EOS (closer); 2 = prev non-punct
// non-space + next punct-or-space/EOS (closer); 3 = prev punct-or-space +
// next non-punct non-space (opener); 4 = prev space + next punct (opener);
// 5 = prev punct + next punct (ambiguous); 6 = prev non-punct non-space +
// next non-punct non-space (ambiguous; `*` and `~` only — the reference's
// `_` RDelim has no group 6). Returns 0 when the run matches no group.
// For `*`, the reference's RDelim treats '~' as a word character (not
// punctuation); for '_' and '~' it is punctuation.
function classifyDelimRun(prev, next, ch) {
  const tildeWord = ch === '*';
  const prevSpace = prev !== '' && isSpaceChar(prev);
  const prevPunct = prev !== '' && isPunctChar(prev) && !(tildeWord && prev === '~');
  const prevNotPS = prev !== '' && !prevSpace && !prevPunct;
  const nextSpace = next === '' || isSpaceChar(next);
  const nextPunct = next !== '' && isPunctChar(next) && !(tildeWord && next === '~');
  const nextNotPS = next !== '' && !nextSpace && !nextPunct;
  if (prevPunct) {
    if (nextSpace) return 1;
    if (nextPunct) return 5;
    if (nextNotPS) return 3;
    return 0;
  }
  if (prevSpace) {
    if (nextPunct) return 4;
    if (nextNotPS) return 3;
    return 0;
  }
  if (prevNotPS) {
    if (nextSpace || nextPunct) return 2;
    if (nextNotPS) return ch === '_' ? 0 : 6;
    return 0;
  }
  return 0;
}

// The reference's previous-character values at a delimiter run:
// - p: the character before the run in the masked source (the actual
//   character before the run, or before the whole run when it extends left
//   over split-off characters of the same run).
// - n: the loop's `r` — the last character of the preceding token, except
//   a text token ending in '_' does not update it; when the run extends
//   left over split-off characters, n is p instead.
// - nQuirk: the loop's `r` without the left-extension adjustment (what the
//   del scan uses, since it has no left-extension step).
// - ext: how many characters the run extends left over split-off text.
function openerPrev(nodes, idx, ch) {
  let ext = 0;
  for (let j = idx - 1; j >= 0; j--) {
    const nd = nodes[j];
    if (nd.k === 't' && nd.split && nd.s === ch) ext++;
    else break;
  }
  const p = idx - ext - 1 >= 0 ? nodeLastChar(nodes[idx - ext - 1]) : '';
  let nQuirk = '';
  for (let j = idx - 1; j >= 0; j--) {
    const nd = nodes[j];
    if (nd.k === 't' && nd.s.length > 0 && nd.s[nd.s.length - 1] === '_') continue;
    nQuirk = nodeLastChar(nd);
    break;
  }
  const n = ext > 0 ? p : nQuirk;
  return { n, p, ext, nQuirk };
}

// The reference's emStrong/del masking (its "#n"): code-span inner
// backticks become '+', escaped punctuation becomes '++', then inline
// links / code spans / HTML tags are replaced by same-length "[aaa...]"
// placeholders. A delimiter run inside such a placeholder is invisible to
// the emphasis scan — so when a link FAILS to form (label with mismatched
// backtick runs), its label's delimiters still cannot open/close. Only the
// link spans matter here: code spans and HTML tags are already atomic
// nodes in our list.
const OT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
function otNormalize(src) {
  return src.replace(OT_RE, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
}
const BLOCKSKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
// Returns [start, end) spans of the source that the reference masks for
// the emphasis scan (its "#n" blockSkip: inline links, code spans and
// HTML tags, on the Ot-normalized source). Length-preserving, so the
// coordinates apply to the raw source too. A code span the blockSkip
// regex matches need not be a real code span — e.g. a backtick inside a
// failed link label can start a long bogus span that swallows the
// delimiters after the link — so all three alternatives matter, not just
// links.
function maskedSpans(src) {
  const norm = otNormalize(src);
  const spans = [];
  BLOCKSKIP_RE.lastIndex = 0;
  let m;
  while ((m = BLOCKSKIP_RE.exec(norm)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) BLOCKSKIP_RE.lastIndex++;
  }
  return spans;
}

// Trim trailing punctuation off an extended autolink, the reference's
// "backpedal": repeat until the match stops changing.
function backpedal(s) {
  let prev;
  do {
    prev = s;
    const m = BACKPEDAL_RE.exec(s);
    s = m ? m[0] : '';
  } while (s !== prev);
  return s;
}

// Find the end of a link label starting at src[i] === '['. Returns the index
// of the matching ']' or -1. `nested` allows balanced [...] inside (inline
// links); otherwise a bare '[' ends the label. Code spans and backslash
// escapes are skipped over.
// The reference's label rule, as a sticky regex (same alternatives, in
// the same order, with the same backtracking): nested brackets, escapes,
// code spans (runs of any length, content without backticks), a 2+
// backtick run right before ']', or any ordinary char — lazy, ending at
// ']'. Using the regex itself matters: a hand-rolled scan that jumps to
// the next backtick run cannot backtrack when that run lies past the
// label's ']' (e.g. inside a later link), but the regex backtracks to the
// 2+-run-before-']' alternative and the label still closes.
const LABEL_RE = /\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]/y;
function findLabelEnd(src, i) {
  LABEL_RE.lastIndex = i;
  const m = LABEL_RE.exec(src);
  if (!m) return -1;
  return i + m[0].length - 1;
}

// Parse a link destination + optional title starting at src[i] === '('.
// Returns {href, title, end} (end = index just past ')') or null.
function parseLinkTarget(src, i) {
  const n = src.length;
  let p = i + 1;
  // skip whitespace/newlines
  while (p < n && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9 || src.charCodeAt(p) === 10)) p++;
  if (p >= n) return null;
  let href;
  if (src.charCodeAt(p) === 60) { // <...>
    let q = p + 1;
    let ok = false;
    while (q < n) {
      const c = src.charCodeAt(q);
      if (c === 92) { q += 2; continue; }
      if (c === 10 || c === 60) return null;
      if (c === 62) { ok = true; break; }
      q++;
    }
    if (!ok) return null;
    href = src.slice(p + 1, q).replace(PUNCT_ESC_RE, '$1');
    p = q + 1;
  } else {
    // bare destination: no spaces, balanced parens (an empty destination
    // is allowed: it ends immediately at the ')')
    let q = p, depth = 0;
    while (q < n) {
      const c = src.charCodeAt(q);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92) { q += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      q++;
    }
    if (depth > 0) return null;
    href = src.slice(p, q).replace(PUNCT_ESC_RE, '$1');
    p = q;
  }
  // optional title: the reference only accepts one when whitespace
  // separates it from the destination
  let title = '';
  let save = p;
  let hadWs = false;
  // skip whitespace, possibly across one newline
  while (p < n && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) { p++; hadWs = true; }
  if (p < n && src.charCodeAt(p) === 10) {
    let q = p + 1;
    while (q < n && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
    if (q < n && src.charCodeAt(q) !== 10) { p = q; hadWs = true; } else { p = save; }
  }
  if (hadWs && p < n) {
    const c = src.charCodeAt(p);
    if (c === 34 || c === 39 || c === 40) { // " ' (
      const open = c === 40 ? 41 : c;
      let q = p + 1, ok = false;
      while (q < n) {
        const ch = src.charCodeAt(q);
        if (ch === 92) { q += 2; continue; }
        if (ch === open) { ok = true; break; }
        if (c === 39 && ch === 10) {
          let r = q + 1;
          while (r < n && (src.charCodeAt(r) === 32 || src.charCodeAt(r) === 9)) r++;
          if (r < n && src.charCodeAt(r) === 10) return null;
        }
        if (c === 40 && ch === 10) { /* paren titles may span lines */ }
        q++;
      }
      if (!ok) return null;
      title = src.slice(p + 1, q).replace(PUNCT_ESC_RE, '$1');
      p = q + 1;
    }
  }
  while (p < n && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9 || src.charCodeAt(p) === 10)) p++;
  if (p >= n || src.charCodeAt(p) !== 41) return null;
  return { href, title, end: p + 1 };
}

// Does the label text contain a '<' that opens a tag/autolink running past
// the label's end? If so the ']' is inside markup and the link is invalid.
function labelHasRunawayTag(src, labelStart, labelEnd) {
  for (let i = labelStart; i < labelEnd; i++) {
    if (src.charCodeAt(i) === 92) { i++; continue; }
    if (src.charCodeAt(i) === 96) {
      // skip a code span: a matching run of the same length of backticks.
      // The closing run may sit past the label end (the reference scans
      // the rest of the source), so search the whole source.
      const n = src.length;
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const run = j - i;
      let p = j, found = -1;
      while (p < n) {
        if (src.charCodeAt(p) === 96) {
          let q = p;
          while (q < n && src.charCodeAt(q) === 96) q++;
          if (q - p === run) { found = q; break; }
          p = q;
        } else p++;
      }
      if (found !== -1) { i = found - 1; continue; }
      i = j - 1;
      continue;
    }
    if (src.charCodeAt(i) !== 60) continue;
    const rest = src.slice(i);
    const t = TAG_RE.exec(rest) || AUTOLINK_RE.exec(rest);
    if (t && t[0].length > labelEnd - i) return true;
    if (t) i += t[0].length - 1;
  }
  return false;
}

// Try to parse a link or image starting at src[i] ('[' or '![').
// Returns {node, end} or null (not a link: caller emits the '[' as text).
function tryLink(src, i, links, inLink) {
  const img = src.charCodeAt(i) === 33; // '!'
  const open = img ? i + 1 : i;
  if (src.charCodeAt(open) !== 91) return null;
  const close = findLabelEnd(src, open);
  if (close === -1) return null;
  const label = src.slice(open + 1, close);
  // A '<' inside the label that opens markup running past the label's end
  // invalidates every link form (the ']' sits inside the markup).
  if (labelHasRunawayTag(src, open + 1, close)) return null;
  // inline link: ](... — an empty label is allowed here
  if (src.charCodeAt(close + 1) === 40) {
    const tgt = parseLinkTarget(src, close + 1);
    if (tgt) {
      const inner = scanInline(label, links, true);
      if (inner.hadLink && !img) return null; // links can't nest
      return { node: { k: 'link', href: tgt.href, title: tgt.title, img, auto: false, children: inner.nodes }, end: tgt.end };
    }
    // fall through: not an inline link; try the reference forms below.
  }
  // full reference: ][ref] — a bracketed label that parses but has no
  // definition blocks the shortcut: the link does not form at all.
  if (src.charCodeAt(close + 1) === 91) {
    const refEnd = findLabelEndRef(src, close + 1);
    if (refEnd !== -1) {
      const ref = src.slice(close + 2, refEnd);
      if (ref.trim().length > 0) {
        const def = links[normalizeLabel(ref)];
        if (def) {
          const inner = scanInline(label, links, true);
          if (inner.hadLink && !img) return null;
          return { node: { k: 'link', href: def.href, title: def.title, img, auto: false, children: inner.nodes }, end: refEnd + 1 };
        }
        return null;
      }
    }
  }
  // collapsed reference: [][]
  if (src.charCodeAt(close + 1) === 91 && src.charCodeAt(close + 2) === 93) {
    const def = links[normalizeLabel(label)];
    if (def) {
      const inner = scanInline(label, links, true);
      if (inner.hadLink && !img) return null;
      return { node: { k: 'link', href: def.href, title: def.title, img, auto: false, children: inner.nodes }, end: close + 3 };
    }
  }
  // shortcut reference: [label] — an empty label never has a definition
  if (label.length > 0) {
    const def = links[normalizeLabel(label)];
    if (def) {
      const inner = scanInline(label, links, true);
      if (inner.hadLink && !img) return null;
      return { node: { k: 'link', href: def.href, title: def.title, img, auto: false, children: inner.nodes }, end: close + 1 };
    }
  }
  return null;
}

// Find the ']' of a reference label (no nesting, no code spans). A single
// newline is allowed inside the label, but not a blank line.
function findLabelEndRef(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 93) return j;
    if (c === 91) return -1;
    if (c === 10) {
      let k = j + 1;
      while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
      if (k < n && src.charCodeAt(k) === 10) return -1;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

// Persistent inLink state: the reference's inline lexer keeps `inLink`
// (set by an unclosed <a> start tag) across the whole document, so an
// unclosed <a> in one paragraph suppresses extended autolinks in later
// paragraphs. It is saved/restored around link-label scans (those pass
// inLink=true and never write back). Reset in parse() per document.
let inlineLink = false;

// Scan inline content into nodes. `inLink` suppresses extended autolinks
// (they are not created inside links or raw <a>...</a>).
function scanInline(src, links, inLink) {
  const nodes = [];
  const n = src.length;
  let i = 0;
  let buf = '';
  let hadLink = false;
  let rawBlock = false; // inside <pre>/<code>/<kbd>/<script>
  let linkState = !!inLink || inlineLink;
  // Spans the reference masks as inline links for the emphasis scan (see
  // maskedLinkSpans): delimiter runs inside them cannot open/close. Only
  // computed when a "](" is present at all.
  const maskSpans = ((src.indexOf('*') !== -1 || src.indexOf('_') !== -1 || src.indexOf('~') !== -1) && (src.indexOf('`') !== -1 || src.indexOf('[') !== -1 || src.indexOf('<') !== -1)) ? maskedSpans(src) : null;
  let maskIdx = 0;
  function inMaskedSpan(pos) {
    if (!maskSpans) return false;
    while (maskIdx < maskSpans.length && maskSpans[maskIdx][1] <= pos) maskIdx++;
    return maskIdx < maskSpans.length && maskSpans[maskIdx][0] <= pos && pos < maskSpans[maskIdx][1];
  }

  function flushText() {
    if (buf.length > 0) {
      nodes.push({ k: 't', s: buf, raw: rawBlock });
      buf = '';
    }
  }

  while (i < n) {
    // Consume a plain-text run up to the next special character, watching for
    // www. / scheme:// / email autolink starts inside the run. A scheme or
    // www. link can only start inside this run (a '_' before it ends the
    // run and is a delimiter); an email's '@' is searched in a wider
    // window that extends across '_' (the reference's GFM text rule does
    // not stop at '_' inside an email address).
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(src);
    const specialAt = m ? m.index : n;
    SCAN_RE.lastIndex = i;
    const sm = SCAN_RE.exec(src);
    const scanEnd = sm ? sm.index : n;
    // Look for autolink candidates inside the run.
    let runEnd = specialAt;
    let linkNode = null, linkEnd = -1;
    {
      let p = i;
      while (p < scanEnd) {
        const atWww = src.indexOf('www.', p);
        const atAt = src.indexOf('@', p);
        const atScheme = src.indexOf('://', p);
        let cand = -1, kind = 0;
        if (atWww !== -1 && atWww < specialAt && (cand === -1 || atWww < cand)) { cand = atWww; kind = 1; }
        if (atAt !== -1 && atAt < scanEnd && (cand === -1 || atAt < cand)) { cand = atAt; kind = 2; }
        if (atScheme !== -1 && atScheme < specialAt) {
          // scheme starts 4 or 5 chars before '://'
          let s = -1;
          if (atScheme >= 5 && SCHEME_RE.test(src.slice(atScheme - 5, atScheme + 3))) s = atScheme - 5;
          else if (atScheme >= 4 && SCHEME_RE.test(src.slice(atScheme - 4, atScheme + 3))) s = atScheme - 4;
          if (s !== -1 && (cand === -1 || s < cand)) { cand = s; kind = 3; }
        }
        if (cand === -1) break;
        if (kind === 1) {
          // www. needs a boundary before it. The autolink must start
          // before the next special character: the extended scan window
          // crosses '_' (for emails), but a www. autolink must not swallow
          // a preceding '_'/'*' delimiter run (e.g. '__a__ www.x.com').
          // Skipping here lets the delimiter be processed first; the
          // autolink is found in a later iteration.
          if (cand >= specialAt) { p = cand + 4; continue; }
          const prev = cand === 0 ? '\n' : src[cand - 1];
          if (prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
            const wm = WWW_RE.exec(src.slice(cand));
            if (wm) {
              const url = backpedal(wm[0]);
              if (url.length > 4) {
                runEnd = cand; linkEnd = cand + url.length;
                linkNode = { k: 'link', href: 'http://' + url, title: '', img: false, auto: true, children: [{ k: 't', s: url, raw: false }] };
                break;
              }
            }
          }
          p = cand + 4;
          continue;
        }
        if (kind === 3) {
          // Same window rule as www.: a scheme autolink must start before
          // the next special character, so it cannot swallow a preceding
          // '_'/'*' delimiter run (e.g. '__a__ http://x.com').
          if (cand >= specialAt) { p = cand + 3; continue; }
          const um = SCHEME_URL_RE.exec(src.slice(cand));
          if (um) {
            const url = backpedal(um[0]);
            if (url.length > 7) {
              runEnd = cand; linkEnd = cand + url.length;
              linkNode = { k: 'link', href: url, title: '', img: false, auto: true, children: [{ k: 't', s: url, raw: false }] };
              break;
            }
          }
          p = cand + 3;
          continue;
        }
        // kind 2: email — scan back over the narrow local-part chars
        let s = cand;
        while (s > i && LOCAL_NARROW_RE.test(src[s - 1])) s--;
        // The email must start at or before the next special character:
        // a '_' inside the local part (s <= specialAt) is part of the
        // email, but a '_'/'*' delimiter before the email's start
        // (s > specialAt, e.g. '__a__ foo@bar.com') must be processed
        // as a delimiter first; the email is found in a later iteration.
        if (s > specialAt) { p = cand + 1; continue; }
        // allow a mailto:/xmpp: prefix
        let prefix = '';
        if (src.slice(s - 7, s) === 'mailto:') { prefix = 'mailto:'; s -= 7; }
        else if (src.slice(s - 5, s) === 'xmpp:') { prefix = 'xmpp:'; s -= 5; }
        let em = null;
        if (prefix) {
          MAILTO_RE.lastIndex = s;
          em = MAILTO_RE.exec(src);
          if (em && em.index === s) em = backpedal(em[0]);
        } else {
          EMAIL_RE.lastIndex = s;
          em = EMAIL_RE.exec(src);
          if (em && em.index === s) em = em[0];
        }
        if (em && typeof em === 'string') {
          runEnd = s; linkEnd = s + em.length;
          const disp = prefix ? em : em;
          linkNode = { k: 'link', href: prefix ? em : 'mailto:' + em, title: '', img: false, auto: true, children: [{ k: 't', s: disp, raw: false }] };
          break;
        }
        p = cand + 1;
      }
    }
    if (linkNode && !linkState) {
      if (runEnd > i) buf += decodeNumericRefs(src.slice(i, runEnd));
      flushText();
      nodes.push(linkNode);
      // An autolink is not a "link" for the no-nesting rule: a link label
      // may contain an autolink (the reference nests the <a> tags), so it
      // must not set hadLink. Only tryLink results set it.
      i = linkEnd;
      continue;
    }
    // No autolink in this run: append the text (with numeric refs decoded,
    // unless inside a raw block) and handle the special char at runEnd.
    if (runEnd > i) {
      const chunk = src.slice(i, runEnd);
      buf += rawBlock ? chunk : decodeNumericRefs(chunk);
      i = runEnd;
    }
    if (i >= n) break;
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      const nx = src[i + 1];
      if (nx === '\n') {
        flushText();
        nodes.push({ k: 'br' });
        i += 2;
        // the reference's hard-break rule eats the next line's leading
        // spaces and tabs
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      } else if (nx !== undefined && isAsciiPunct(nx.charCodeAt(0))) {
        // an escaped char is its own node: it must not merge with following
        // text, or "&" + "ouml;" would look like an entity
        flushText();
        nodes.push({ k: 'esc', s: nx });
        i += 2;
      } else {
        buf += '\\';
        i++;
      }
      continue;
    }
    if (c === 96) { // backtick run: code span
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const run = j - i;
      let p = j, found = -1;
      while (p < n) {
        if (src.charCodeAt(p) === 96) {
          let q = p;
          while (q < n && src.charCodeAt(q) === 96) q++;
          if (q - p === run) { found = q; break; }
          p = q;
        } else p++;
      }
      if (found === -1) {
        buf += src.slice(i, j);
        i = j;
      } else {
        let content = src.slice(j, found - run).replace(/\n/g, ' ');
        if (content.length > 0 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flushText();
        nodes.push({ k: 'code', s: content });
        i = found;
      }
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      const ch = String.fromCharCode(c);
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      let len = j - i;
      if (inMaskedSpan(i)) {
        // Inside a region the reference masks as a link: the delimiters
        // are invisible to the emphasis scan, so they stay literal text.
        buf += src.slice(i, j);
        i = j;
        continue;
      }
      if (ch === '~' && len >= 3) {
        // three or more tildes never open/close a del
        buf += src.slice(i, j);
        i = j;
        continue;
      }
      const prev = i === 0 ? '\n' : src[i - 1];
      const next = j >= n ? '\n' : src[j];
      const prevSpace = isSpaceChar(prev);
      const nextSpace = isSpaceChar(next);
      const prevPunct = isPunctChar(prev);
      const nextPunct = isPunctChar(next);
      let canOpen, canClose;
      if (ch === '~' || ch === '*') {
        // `~` (GFM strikethrough) follows the same flanking rules as `*`.
        const leftFlank = !nextSpace && (!nextPunct || prevSpace || prevPunct);
        const rightFlank = !prevSpace && (!prevPunct || nextSpace || nextPunct);
        canOpen = leftFlank;
        canClose = rightFlank;
      } else {
        const leftFlank = !nextSpace && (!nextPunct || prevSpace || prevPunct);
        const rightFlank = !prevSpace && (!prevPunct || nextSpace || nextPunct);
        canOpen = leftFlank && (!rightFlank || prevPunct);
        canClose = rightFlank && (!leftFlank || nextPunct);
      }
      flushText();
      nodes.push({ k: 'd', ch, len, open: canOpen, close: canClose });
      i = j;
      continue;
    }
    if (c === 91 || (c === 33 && src.charCodeAt(i + 1) === 91)) { // [ or ![
      // Links inside link text are parsed too: tryLink aborts the outer link
      // when the label contains one, so the inner one wins.
      const r = tryLink(src, i, links, linkState);
      if (r) {
        flushText();
        nodes.push(r.node);
        if (!r.node.img) hadLink = true;
        i = r.end;
        continue;
      }
      buf += src[i];
      i++;
      continue;
    }
    if (c === 60) { // <
      const rest = src.slice(i);
      const am = AUTOLINK_RE.exec(rest);
      if (am) {
        flushText();
        const text = am[2] !== undefined ? am[2] : am[1];
        const href = am[2] !== undefined ? 'mailto:' + text : text;
        nodes.push({ k: 'link', href, title: '', img: false, auto: true, angle: true, children: [{ k: 't', s: text, raw: false }] });
        // Bracketed autolinks are allowed inside link labels (the
        // reference nests them), so they must not set hadLink.
        i += am[0].length;
        continue;
      }
      const tm = TAG_RE.exec(rest);
      if (tm) {
        flushText();
        const tag = tm[0];
        nodes.push({ k: 'html', s: tag });
        if (/^<a[ \t]/i.test(tag) || /^<a>/i.test(tag)) linkState = true;
        else if (/^<\/a[ \t>]/i.test(tag)) linkState = false;
        if (/^<(pre|code|kbd|script)(?:[ \t>]|$)/i.test(tag)) rawBlock = true;
        else if (/^<\/(pre|code|kbd|script)(?:[ \t>]|$)/i.test(tag)) rawBlock = false;
        i += tag.length;
        continue;
      }
      buf += '&lt;';
      i++;
      continue;
    }
    if (c === 38) { // &
      const em = /^&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/.exec(src.slice(i));
      if (em) {
        const num = em[1] !== undefined ? parseInt(em[1], 10) : parseInt(em[2], 16);
        if (num === 0 || num > 0x10FFFF || (num >= 0xD800 && num <= 0xDFFF)) buf += '\uFFFD';
        else if (num === 38) buf += '&amp;';
        else buf += String.fromCodePoint(num);
        i += em[0].length;
        continue;
      }
      // named entity: leave as-is (the renderer keeps &name; intact)
      const nm = /^&[A-Za-z0-9]+;/.exec(src.slice(i));
      if (nm) {
        buf += nm[0];
        i += nm[0].length;
        continue;
      }
      buf += '&amp;';
      i++;
      continue;
    }
    if (c === 10) { // newline: hard break if 2+ trailing spaces and more text follows
      let sp = 0;
      for (let k = buf.length - 1; k >= 0 && buf[k] === ' '; k--) sp++;
      const restHasText = /[^\s]/.test(src.slice(i + 1));
      if (sp >= 2 && restHasText) {
        buf = buf.slice(0, buf.length - sp);
        flushText();
        nodes.push({ k: 'br' });
        i++;
        // the reference's hard-break rule eats the next line's leading
        // spaces and tabs
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    // '!' not followed by '[', ']' and '>' etc: plain text
    buf += src[i];
    i++;
  }
  flushText();
  processEmStrong(nodes);
  // Email autolinks the reference forms inside an emphasis span (see
  // fixTrailingEmails). Skipped inside link labels, where the reference
  // suppresses GFM autolinks.
  if (!inLink) fixTrailingEmails(nodes);
  // Persist the <a>-driven inLink state for later top-level scans; label
  // scans (inLink=true) leave the document state untouched.
  if (!inLink) inlineLink = linkState;
  return { nodes, hadLink };
}

// The reference's emphasis pass (marked 18 emStrong + del), replacing the
// CommonMark delimiter stack. Delimiter runs are processed left to right:
// the first run in the source claims its span first, and a matched span's
// inner text is re-processed (the reference re-tokenizes it), so inner
// spans form from leftover delimiter characters. Wrapped nodes keep their
// delimiter character (`ch`) so a parent scan reads the right neighbour.
function processEmStrong(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.k !== 'd') { i++; continue; }
    const res = node.ch === '~' ? tryDel(nodes, i) : tryEmStrong(nodes, i);
    if (res) { i = res.nextIndex; continue; }
    // No match: the reference consumes one delimiter character as text
    // and retries the rest of the run (e.g. `***foo**` -> `*` + `**foo**`,
    // where the `**` then forms a strong).
    if (node.len > 1) {
      nodes.splice(i, 1, { k: 't', s: node.ch, raw: false, split: true }, { k: 'd', ch: node.ch, len: node.len - 1, open: node.open, close: node.close });
      i++; // the shortened run is retried next
      continue;
    }
    i++;
  }
  // Unmatched delimiters become literal text. This must walk the whole
  // tree: delimiters wrapped inside a matched em/strong/del can no longer
  // match, so they are literal too (otherwise they would vanish).
  literalizeDelims(nodes);
}

// The reference's RDelim skip pattern: on the first scan step it skips a
// single '*' inside the first '__...__' region (or a single '_' inside
// the first '**...**' region), so that delimiter cannot count as an
// opener or a closer for an outer span. Only the first such region
// counts, and only a run of exactly length 1 is skipped. '~' runs do not
// break the pattern (they are not '*'/'_'), so they are ignored here.
// Returns the index of the node to skip, or -1.
function skipNodeForEmStrong(nodes, idx, ch) {
  const openCh = ch === '*' ? '_' : '*';
  const openLen = 2;
  let seen = 0;
  let skipIdx = -1;
  for (let j = idx + 1; j < nodes.length; j++) {
    const nd = nodes[j];
    if (nd.k !== 'd' || nd.ch === '~') continue;
    if (seen === 0) {
      if (nd.ch !== openCh || nd.len !== openLen) return -1;
      seen = 1;
    } else if (seen === 1) {
      if (nd.ch !== ch || nd.len !== 1) return -1;
      skipIdx = j;
      seen = 2;
    } else {
      if (nd.ch !== openCh || nd.len < openLen) return -1;
      return skipIdx;
    }
  }
  return -1;
}

// Try the reference's emStrong at nodes[idx] (a '*' or '_' delimiter run).
// Returns { nextIndex } when a span is wrapped, or null when no match.
// The node list is rebuilt in place on a match.
function tryEmStrong(nodes, idx) {
  const node = nodes[idx];
  const ch = node.ch;
  const k = node.len;
  const next = idx + 1 < nodes.length ? nodeFirstChar(nodes[idx + 1]) : '';
  // LDelim gate: an opener needs a non-space character after the run.
  if (next === '' || isSpaceChar(next)) return null;
  const { n, p, ext } = openerPrev(nodes, idx, ch);
  // '_' intraword rule (s[4]): the character after the run is not
  // punctuation (or is '~') — with an alnum before it, a '_' cannot open.
  const s4 = ch === '_' && next !== '_' && !(isPunctChar(next) && next !== '~');
  if (s4 && isAlnumChar(n)) return null;
  // d (s[1]/s[3]): the character after the run is punctuation, but not
  // the delimiter itself and not '~'.
  const d = (next !== ch && isPunctChar(next) && next !== '~') ? next : '';
  // The reference's `punctuation` rule is punct-or-space (not '*'/'_'):
  // h is whether the character before the run is punct-or-space, u is
  // whether the loop's previous character is punct-or-space (not '*'/'_').
  const h = p !== '' && (isSpaceChar(p) || isPunctChar(p));
  const u = n !== '' && (isSpaceChar(n) || isPunctChar(n)) && n !== '*' && n !== '_';
  // LDelim gate: a punctuation character after the run needs the previous
  // character to be absent or punctuation-or-space (not '*'/'_').
  if (d !== '' && n !== '' && !u) return null;
  const o = n === ch;
  const y = k + ext;
  const R = p !== '' && !isSpaceChar(p) && (d !== '' || (ch === '*' && !h));
  const skipIdx = skipNodeForEmStrong(nodes, idx, ch);
  let m = k, f = 0;
  for (let j = idx + 1; j < nodes.length; j++) {
    const cand = nodes[j];
    if (cand.k !== 'd' || cand.ch !== ch) continue;
    if (j === skipIdx) continue;
    const cp = nodeLastChar(nodes[j - 1]);
    const cn = j + 1 < nodes.length ? nodeFirstChar(nodes[j + 1]) : '';
    const grp = classifyDelimRun(cp, cn, ch);
    if (grp === 0) continue;
    const b = cand.len;
    if (grp === 3 || grp === 4) { m += b; continue; }
    if (grp === 5 || grp === 6 || R) {
      if (o && (grp === 5 || grp === 6)) return null; // break: no match
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const bAdj = Math.min(b, b + m + f);
    const use = (Math.min(k, bAdj) % 2 === 1) ? 1 : 2;
    const kind = use === 1 ? 'em' : 'strong';
    // Leftover opener (k-use) and leftover closer (bAdj-use) characters
    // stay INSIDE the span text; the rest of the closer run (b-bAdj)
    // stays AFTER the span.
    const middle = nodes.slice(idx + 1, j);
    const children = [];
    if (k - use > 0) children.push({ k: 'd', ch, len: k - use, open: true, close: true });
    children.push(...middle);
    if (bAdj - use > 0) children.push({ k: 'd', ch, len: bAdj - use, open: true, close: true });
    const wrapped = { k: kind, ch, children };
    const repl = [wrapped];
    if (cand.len - bAdj > 0) repl.push({ k: 'd', ch, len: cand.len - bAdj, open: true, close: true });
    nodes.splice(idx, j - idx + 1, ...repl);
    // Re-tokenize the inner text the way the reference does.
    processEmStrong(children);
    return { nextIndex: idx + 1 };
  }
  return null;
}

// Try the reference's del at nodes[idx] (a '~' delimiter run, length 1
// or 2). Like emStrong but simpler: the closer must have exactly the
// opener's length, there is no rule of 3, and the runs are fully consumed
// (no leftovers). Returns { nextIndex } on a match, else null.
function tryDel(nodes, idx) {
  const node = nodes[idx];
  const o = node.len;
  const next = idx + 1 < nodes.length ? nodeFirstChar(nodes[idx + 1]) : '';
  // delLDelim gate: needs a non-space character after the run; a
  // punctuation character after it (other than '~') needs the loop's
  // previous character to be absent or punctuation-or-space (not '*'/'_').
  if (next === '' || isSpaceChar(next)) return null;
  const n = openerPrev(nodes, idx, '~').nQuirk;
  const s1 = isPunctChar(next) && next !== '~';
  const u = n !== '' && (isSpaceChar(n) || isPunctChar(n)) && n !== '*' && n !== '_';
  if (s1 && n !== '' && !u) return null;
  let p = o;
  for (let j = idx + 1; j < nodes.length; j++) {
    const cand = nodes[j];
    if (cand.k !== 'd' || cand.ch !== '~') continue;
    if (cand.len !== o) continue;
    const cp = nodeLastChar(nodes[j - 1]);
    const cn = j + 1 < nodes.length ? nodeFirstChar(nodes[j + 1]) : '';
    const grp = classifyDelimRun(cp, cn, '~');
    if (grp === 0) continue;
    if (grp === 3 || grp === 4) { p += cand.len; continue; }
    p -= cand.len;
    if (p > 0) continue;
    const wrapped = { k: 'del', ch: '~', children: nodes.slice(idx + 1, j) };
    nodes.splice(idx, j - idx + 1, wrapped);
    processEmStrong(wrapped.children);
    return { nextIndex: idx + 1 };
  }
  return null;
}

// Email autolinks that the reference forms inside an emphasis span: the
// reference re-tokenizes the span's inner text, so an email at the end of
// it passes its lookahead (the closer is not part of the inner text), but
// our single-pass scan sees the trailing '_' closer and backtracks (or
// finds no email at all). Repair the two shapes after the emphasis pass,
// only inside em/strong/del nodes — never inside links, where the
// reference suppresses GFM autolinks.
const TRAILING_EMAIL_RE = /([A-Za-z0-9._+\-]+)@([a-zA-Z0-9\-_]+(?:\.[a-zA-Z0-9\-_]*[a-zA-Z0-9])+)$/;
const DOT_GROUP_RE = /^\.[A-Za-z0-9\-_]*[A-Za-z0-9]$/;
function fixTrailingEmails(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.k !== 'em' && node.k !== 'strong' && node.k !== 'del') continue;
    fixTrailingEmails(node.children);
    const ch = node.children;
    if (ch.length === 0) continue;
    const last = ch[ch.length - 1];
    if (last.k !== 't') continue;
    // Sub-case 2: an auto mailto link followed by exactly one dot-group
    // of text (the scan-time backtrack dropped one dot-group).
    if (DOT_GROUP_RE.test(last.s) && ch.length >= 2) {
      const prev = ch[ch.length - 2];
      if (prev.k === 'link' && prev.auto && typeof prev.href === 'string' && prev.children.length === 1 && prev.children[0].k === 't') {
        const disp = prev.children[0].s + last.s;
        prev.href = (disp.startsWith('mailto:') || disp.startsWith('xmpp:')) ? disp : 'mailto:' + disp;
        prev.children = [{ k: 't', s: disp, raw: false }];
        ch.pop();
        continue;
      }
    }
    // Sub-case 1: a text node ending in an email (no scan-time match).
    const m = TRAILING_EMAIL_RE.exec(last.s);
    if (m) {
      let email = m[0], start = m.index, prefix = '';
      const before = last.s.slice(0, start);
      if (before.endsWith('mailto:')) prefix = 'mailto:';
      else if (before.endsWith('xmpp:')) prefix = 'xmpp:';
      if (prefix) { email = prefix + email; start -= prefix.length; }
      const head = last.s.slice(0, start);
      const linkNode = { k: 'link', href: prefix ? email : 'mailto:' + email, title: '', img: false, auto: true, children: [{ k: 't', s: email, raw: false }] };
      const repl = [];
      if (head) repl.push({ k: 't', s: head, raw: last.raw });
      repl.push(linkNode);
      ch.splice(ch.length - 1, 1, ...repl);
    }
  }
}

// Replace every remaining delimiter node in the tree with its literal text.
function literalizeDelims(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.k === 'd') {
      nodes[i] = { k: 't', s: node.ch.repeat(node.len), raw: false };
    } else if (node.children) {
      literalizeDelims(node.children);
    }
  }
}

// Render inline nodes to HTML.
function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 't':
        out += node.raw ? node.s : escapeKeepEnt(node.s);
        break;
      case 'esc':
        out += escapeAll(node.s);
        break;
      case 'code':
        out += '<code>' + escapeAll(node.s) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'html':
        out += node.s;
        break;
      case 'em':
        out += '<em>' + renderInline(node.children) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInline(node.children) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderInline(node.children) + '</del>';
        break;
      case 'link': {
        const href = encodeUri(node.href);
        if (node.img) {
          if (href === null) { out += escapeKeepEnt(renderText(node.children)); break; }
          out += '<img src="' + escapeKeepEnt(href) + '" alt="' + escapeKeepEnt(renderText(node.children)) + '"';
          if (node.title) out += ' title="' + escapeKeepEnt(node.title) + '"';
          out += '>';
        } else {
          if (href === null) { out += renderInline(node.children); break; }
          out += '<a href="' + (node.auto ? escapeAll(href) : escapeKeepEnt(href)) + '"';
          if (node.title) out += ' title="' + escapeKeepEnt(node.title) + '"';
          out += '>' + (node.auto ? escapeAll(node.children[0].s) : renderInline(node.children)) + '</a>';
        }
        break;
      }
    }
  }
  return out;
}

// Plain-text rendering (image alt text): markup stripped, entities kept raw.
function renderText(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 't': out += node.s; break;
      case 'esc': out += node.s; break;
      case 'code': out += node.s; break;
      case 'br': break;
      case 'html': out += node.s; break;
      case 'em': case 'strong': case 'del': out += renderText(node.children); break;
      case 'link': out += renderText(node.children); break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|[ \t]*$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_MARKER_RE = /^ {0,3}([*+-]|\d{1,9}[.)])(?:[ \t]+|[ \t]*$)/;
const TABLE_DELIM_CELL = /^:?-+:?$/;

// Strip a blockquote marker from the start of a line. Returns
// {line, col} (the rest of the line and its absolute column), or null when
// the line does not start a blockquote. `col0` is the line's starting column.
function stripQuoteMarker(line, col0 = 0) {
  let i = 0;
  while (i < 3 && i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length || line.charCodeAt(i) !== 62) return null; // '>'
  const markerEnd = i + 1;
  // The reference expands tabs in the whitespace after '>' (measured
  // from the marker's own column, i.e. within this line) before re-lexing
  // the quote's content, then strips the marker plus one space. A tab
  // after two or more spaces must expand the same way, not stay a tab.
  let j = markerEnd;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === markerEnd) return { line: line.slice(markerEnd), col: col0 + markerEnd };
  let col = markerEnd, expanded = '';
  for (let k = markerEnd; k < j; k++) {
    if (line.charCodeAt(k) === 9) {
      const w = 4 - (col % 4);
      expanded += ' '.repeat(w);
      col += w;
    } else {
      expanded += ' ';
      col++;
    }
  }
  return { line: expanded.slice(1) + line.slice(j), col: col0 + markerEnd + 1 };
}

// Parse a list marker at the start of `line`. Returns null when there is none,
// else {ordered, bullet, delim, start, indent, contentIndent, contentLine, empty}.
// `col0` is the line's absolute starting column (tabs expand from it).
function parseListMarker(line, col0 = 0) {
  const m = /^ {0,3}([*+-]|\d{1,9}[.)])/.exec(line);
  if (!m) return null;
  // A thematic break (e.g. `* * *`, `- - -`) is not a list item.
  if (HR_RE.test(line)) return null;
  const marker = m[1];
  const ordered = /\d/.test(marker[0]);
  const markerCol = m[0].length - marker.length; // leading spaces (0-3)
  const markerWidth = marker.length;
  const afterIdx = m[0].length;
  // Measure the whitespace run after the marker in columns.
  let col = col0 + markerCol + markerWidth;
  let j = afterIdx, spaces = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === 32) { spaces++; col++; j++; }
    else if (c === 9) { const w = 4 - (col % 4); spaces += w; col += w; j++; }
    else break;
  }
  const rest = line.slice(j);
  const base = { ordered, bullet: ordered ? null : marker, delim: ordered ? marker[marker.length - 1] : null,
                 start: ordered ? parseInt(marker.slice(0, -1), 10) : 0, indent: markerCol };
  if (rest.length === 0) {
    return { ...base, contentIndent: markerCol + markerWidth + 1, contentLine: '', empty: true };
  }
  if (spaces === 0) return null; // marker must be followed by space or EOL
  if (spaces >= 5) {
    return { ...base, contentIndent: markerCol + markerWidth + 1,
             contentLine: stripIndentColsAt(line.slice(afterIdx), 1, col0 + markerCol + markerWidth), empty: false };
  }
  return { ...base, contentIndent: markerCol + markerWidth + spaces,
           contentLine: rest, empty: false };
}

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  if (a.ordered) return a.delim === b.delim;
  return a.bullet === b.bullet;
}

// Split a table row/header line into cells, the way the reference does:
// escaped pipes stay literal; other pipes split (with a space forced before
// them); leading/trailing empty cells from edge pipes are dropped.
function splitTableCells(line, count) {
  let s = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '|') {
      let bs = 0, p = i - 1;
      while (p >= 0 && line[p] === '\\') { bs++; p--; }
      s += bs % 2 === 1 ? '|' : ' |';
    } else s += c;
  }
  let cells = s.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    while (cells.length < count) cells.push('');
  }
  return cells;
}

// Is `line` a GFM table delimiter row? Returns the alignments or null.
function tableDelimiter(line) {
  // a delimiter row indented by more than three columns is not a table
  if (leadingIndent(line)[0] > 3) return null;
  const t = line.trim();
  if (t.indexOf(':') === -1 && t.indexOf('|') === -1) return null;
  let cells = splitTableCells(t);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!TABLE_DELIM_CELL.test(c)) return null;
    if (/^:-+:$/.test(c)) aligns.push('center');
    else if (/^-+:$/.test(c)) aligns.push('right');
    else if (/^:-+$/.test(c)) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// HTML block start detection. Returns {end: 'blank'|'marker', marker} or null.
// `interrupt` is false while a paragraph is open (type 7 cannot interrupt).
function htmlBlockStart(line, interrupt) {
  let i = 0;
  while (i < 3 && i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length || line.charCodeAt(i) !== 60) return null; // '<'
  const rest = line.slice(i);
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m1) return { end: 'marker', marker: '</' + m1[1].toLowerCase() };
  if (/^<!--/.test(rest)) return { end: 'marker', marker: '-->' };
  if (/^<\?/.test(rest)) return { end: 'marker', marker: '?>' };
  if (/^<![A-Za-z]/.test(rest)) return { end: 'marker', marker: '>' };
  if (/^<!\[CDATA\[/.test(rest)) return { end: 'marker', marker: ']]>' };
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]+|\/?>|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { end: 'blank', marker: '' };
  if (!interrupt) return null;
  // type 7: a complete open or close tag alone on the line
  if (/^<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][\w.:-]*(?:[ \t]*=[ \t]*"[^"]*"|[ \t]*=[ \t]*'[^']*'|[ \t]*=[ \t]*[^\s"'=<>`]+)?)*[ \t]*\/?>[ \t]*$/.test(rest)) return { end: 'blank', marker: '' };
  if (/^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(rest)) return { end: 'blank', marker: '' };
  return null;
}

// Parse a link reference definition starting at lines[i]. Returns the number
// of lines consumed (0 when the lines do not form a definition).
function tryDefinitionText(joined, links) {
  let p = 0;
  const n = joined.length;
  while (p < 3 && p < n && joined.charCodeAt(p) === 32) p++;
  if (p >= n || joined.charCodeAt(p) !== 91) return 0; // '['
  // label
  let label = '';
  let q = p + 1;
  let ok = false;
  while (q < n) {
    const c = joined.charCodeAt(q);
    if (c === 92) { label += joined.slice(q, q + 2); q += 2; continue; }
    if (c === 93) { ok = true; break; } // ']'
    if (c === 91) return 0;
    if (c === 10) {
      let r = q + 1;
      while (r < n && (joined.charCodeAt(r) === 32 || joined.charCodeAt(r) === 9)) r++;
      if (r < n && joined.charCodeAt(r) === 10) return 0;
      label += '\n';
      q++;
      continue;
    }
    label += joined[q];
    q++;
  }
  if (!ok) return 0;
  const norm = normalizeLabel(label);
  if (norm.length === 0) return 0;
  q++; // past ']'
  if (q >= n || joined.charCodeAt(q) !== 58) return 0; // ':'
  q++;
  // optional spaces, optional single newline + spaces
  while (q < n && (joined.charCodeAt(q) === 32 || joined.charCodeAt(q) === 9)) q++;
  if (q < n && joined.charCodeAt(q) === 10) {
    let r = q + 1;
    while (r < n && (joined.charCodeAt(r) === 32 || joined.charCodeAt(r) === 9)) r++;
    if (r < n && joined.charCodeAt(r) !== 10) q = r; else return 0;
  }
  if (q >= n) return 0;
  // destination
  let href;
  if (joined.charCodeAt(q) === 60) { // <...>
    let r = q + 1, closed = false;
    while (r < n) {
      const c = joined.charCodeAt(r);
      if (c === 92) { r += 2; continue; }
      if (c === 10 || c === 60) return 0;
      if (c === 62) { closed = true; break; }
      r++;
    }
    if (!closed) return 0;
    href = joined.slice(q + 1, r).replace(PUNCT_ESC_RE, '$1');
    q = r + 1;
  } else {
    let r = q, depth = 0;
    while (r < n) {
      const c = joined.charCodeAt(r);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92) { r += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      r++;
    }
    if (depth > 0 || r === q) return 0;
    href = joined.slice(q, r).replace(PUNCT_ESC_RE, '$1');
    q = r;
  }
  // optional title (same line, or on the next line). A title is only
  // accepted when whitespace separates it from the destination; when the
  // title does not parse, or junk follows it, the definition falls back
  // to the no-title form (destination only, to end of line).
  const destEnd = q;
  let title = '';
  let titleEnd = -1;
  {
    let q2 = q;
    let hadWs = false;
    while (q2 < n && (joined.charCodeAt(q2) === 32 || joined.charCodeAt(q2) === 9)) { q2++; hadWs = true; }
    if (q2 < n && joined.charCodeAt(q2) === 10) {
      let r = q2 + 1;
      while (r < n && (joined.charCodeAt(r) === 32 || joined.charCodeAt(r) === 9)) r++;
      if (r < n && joined.charCodeAt(r) !== 10) { q2 = r; hadWs = true; }
    }
    if (hadWs && q2 < n) {
      const c = joined.charCodeAt(q2);
      if (c === 34 || c === 39 || c === 40) {
        const open = c === 40 ? 41 : c;
        let r = q2 + 1, closed = false;
        while (r < n) {
          const ch = joined.charCodeAt(r);
          if (ch === 92) { r += 2; continue; }
          if (ch === open) { closed = true; break; }
          if (c === 39 && ch === 10) {
            // a single-quoted title may span one newline, not a blank line
            let s = r + 1;
            while (s < n && (joined.charCodeAt(s) === 32 || joined.charCodeAt(s) === 9)) s++;
            if (s < n && joined.charCodeAt(s) === 10) break;
          }
          r++;
        }
        if (closed) {
          title = joined.slice(q2 + 1, r).replace(PUNCT_ESC_RE, '$1');
          titleEnd = r + 1;
        }
      }
    }
  }
  if (titleEnd !== -1) {
    // title must be followed by only spaces/tabs to end of line
    let q2 = titleEnd;
    while (q2 < n && (joined.charCodeAt(q2) === 32 || joined.charCodeAt(q2) === 9)) q2++;
    if (q2 >= n || joined.charCodeAt(q2) === 10) {
      const consumed = joined.slice(0, q2).split('\n').length;
      if (!Object.prototype.hasOwnProperty.call(links, norm)) {
        links[norm] = { href, title };
      }
      return consumed;
    }
    // junk after the title: fall through to the no-title attempt
  }
  // no-title definition: only spaces/tabs after the destination to EOL
  {
    let q2 = destEnd;
    while (q2 < n && (joined.charCodeAt(q2) === 32 || joined.charCodeAt(q2) === 9)) q2++;
    if (q2 >= n || joined.charCodeAt(q2) === 10) {
      const consumed = joined.slice(0, q2).split('\n').length;
      if (!Object.prototype.hasOwnProperty.call(links, norm)) {
        links[norm] = { href, title: '' };
      }
      return consumed;
    }
  }
  return 0;
}

const TASK_TEST_RE = /^\[[ xX]\][ \t]+\S/;
const TASK_RE = /^\[[ xX]\][ \t]+/;

// The block parser: lines -> block nodes. `links` is filled with the
// document's link reference definitions.
function parseBlocks(src, links) {
  const lines = src.split('\n');
  const root = { t: 'doc', children: [] };
  const stack = [root]; // open containers + at most one leaf at the end
  let sawBlank = false;
  let i = 0;

  function top() { return stack[stack.length - 1]; }
  function leaf() {
    const t = top();
    return (t.t === 'para' || t.t === 'text' || t.t === 'fence' || t.t === 'icode' || t.t === 'html' || t.t === 'table') ? t : null;
  }
  function parent() {
    for (let j = stack.length - 1; j >= 0; j--) {
      const b = stack[j];
      if (b.t === 'doc' || b.t === 'quote' || b.t === 'item') return b;
    }
    return root;
  }
  function innermostIsItem() {
    for (let j = stack.length - 1; j >= 0; j--) {
      const b = stack[j];
      if (b.t === 'item') return true;
      if (b.t === 'quote' || b.t === 'doc') return false;
    }
    return false;
  }
  function addNode(node) {
    parent().children.push(node);
  }
  function closeLeaf() {
    const lf = leaf();
    if (!lf) return;
    stack.pop();
    if (lf.t === 'icode') {
      lf.text = stripTrailingBlanks(lf.lines.join('\n'));
    } else if (lf.t === 'fence') {
      lf.text = lf.lines.join('\n');
    } else if (lf.t === 'html') {
      lf.text = lf.lines.join('\n') + (lf.trailNl ? '\n' : '');
    } else if (lf.t === 'para' || lf.t === 'text') {
      lf.text = lf.lines.join('\n');
    }
    delete lf.lines;
  }
  function closeItem(item) {
    // close any open leaf inside the item, then pop the item
    if (leaf()) closeLeaf();
    stack.pop();
    // task items: strip the checkbox marker from the first text/para child
    if (item.task) {
      const first = item.children[0];
      if (first && (first.t === 'text' || first.t === 'para')) {
        if (first.text !== undefined) first.text = first.text.replace(TASK_RE, '');
      } else {
        item.task = false;
      }
    }
  }
  function closeList(list) {
    // close any open item, then pop the list
    if (leaf()) closeLeaf();
    if (top().t === 'item') closeItem(top());
    stack.pop();
    if (list.loose) {
      for (const item of list.items) {
        for (const child of item.children) {
          if (child.t === 'text') child.t = 'para';
        }
      }
    }
  }
  function closeFrom(idx) {
    // close everything from stack[idx] onward
    while (stack.length > idx) {
      const b = top();
      if (b.t === 'item') closeItem(b);
      else if (b.t === 'list') closeList(b);
      else if (b.t === 'quote') stack.pop();
      else closeLeaf();
    }
  }
  function markLooseIfNeeded() {
    // a blank line separates blocks inside the innermost open item
    if (!sawBlank) return;
    for (let j = stack.length - 1; j >= 0; j--) {
      const b = stack[j];
      if (b.t === 'item') {
        if (b.children.length > 0) b.list.loose = true;
        return;
      }
      if (b.t === 'quote' || b.t === 'doc') return;
    }
  }

  // Strip the open containers' prefixes from `line`. Returns the stripped
  // line, how many stack entries matched (stack[0] is the document), and the
  // absolute column `col` where the stripped line starts (tabs expand from
  // absolute columns, so this must travel with the line).
  function stripContainers(line, col0 = 0) {
    let matched = 1;
    let col = col0;
    let strippedQuote = false;
    while (matched < stack.length) {
      const c = stack[matched];
      if (c.t === 'list') { matched++; continue; } // lists are transparent
      if (c.t === 'quote') {
        const r = stripQuoteMarker(line, col);
        if (r === null) break;
        line = r.line;
        col = r.col;
        strippedQuote = true;
        matched++;
      } else if (c.t === 'item') {
        if (c.dead) break; // ended by a blank line while it had no content
        if (isBlankLine(line)) { line = ''; matched++; continue; }
        const [ind] = leadingIndent(line, col);
        if (ind >= c.indent) {
          // the reference expands the line's leading tabs to spaces
          // before removing the item indent, so a tab the strip ends on
          // becomes spaces instead of staying a tab
          line = expandLeadingTabs(line, col).slice(c.indent);
          col += c.indent;
          matched++;
          continue;
        }
        break;
      } else break;
    }
    return { line, matched, col, strippedQuote };
  }
  // Does the newline after an HTML block's last (marker) line survive?
  // The reference keeps it iff exactly one newline follows the marker
  // line: the next (container-stripped) line is non-empty — a spaces- or
  // tabs-only line still counts — or the source ends with a single
  // trailing newline (the empty string split() leaves at the end). A
  // truly empty next line means two or more newlines follow, and the
  // newline is dropped. (Call after i++.)
  function htmlTrailNl() {
    if (i >= lines.length) return false;
    const nx = stripContainers(lines[i]).line;
    if (nx !== '') return true;
    return i === lines.length - 1 && lines[i] === '';
  }
  // Transform a lazy continuation line the way the reference does. A
  // setext-looking line inside a blockquote paragraph is kept with four
  // spaces in front (so it cannot become a heading); lines with four or
  // more columns of indent lose four of them (the reference re-lexes such
  // a line as indented code merged into the paragraph). Inside a list
  // item the re-lexing is line by line, so each line is stripped on its
  // own indent; inside a blockquote the paragraph pattern swallows a run
  // of lazy lines whole, so only a maximal prefix of lines indented by
  // four or more is stripped — the run mode is tracked on the paragraph.
  function lazyLine(leafNode, line, col0) {
    const se = SETEXT_RE.exec(line);
    if (se) {
      if (leafNode.t === 'text') return line;
      line = line.replace(/^ {0,3}(=+|-+)([ \t]*)$/, '    $1$2');
    }
    const [ind] = leadingIndent(line, col0);
    if (leafNode.t === 'text') {
      return ind >= 4 ? stripIndentCols(line, 4, col0) : line;
    }
    if (leafNode.runLastI !== i - 1) {
      leafNode.runMode = ind >= 4 ? 'code' : 'para';
    }
    leafNode.runLastI = i;
    if (leafNode.runMode === 'code') {
      if (ind >= 4) return stripIndentCols(line, 4, col0);
      leafNode.runMode = 'para';
    }
    return line;
  }
  // Does the next raw line continue the innermost open blockquote? Used
  // to tell a whitespace-only quote line that is paragraph content (the
  // quote ends here) from a real blank line (the quote continues).
  function nextLineContinuesQuote() {
    let qIdx = -1;
    for (let j = stack.length - 1; j >= 0; j--) if (stack[j].t === 'quote') { qIdx = j; break; }
    if (qIdx === -1 || i + 1 >= lines.length) return false;
    return stripContainers(lines[i + 1]).matched > qIdx;
  }
  function tryTableConvert(leafNode, line) {
    const aligns = tableDelimiter(line);
    if (!aligns) return false;
    const lastLine = leafNode.lines[leafNode.lines.length - 1];
    const headerCells = splitTableCells(lastLine.trim().replace(/^ +/, ''));
    if (headerCells.length !== aligns.length || headerCells.length === 0) return false;
    const p = parent();
    p.children.pop();
    stack.pop();
    const headLines = leafNode.lines.slice(0, -1);
    if (headLines.length > 0) {
      addNode({ t: leafNode.t, text: headLines.join('\n') });
    }
    const header = headerCells.map((c, k) => ({ text: c, align: aligns[k] }));
    const table = { t: 'table', header, rows: [] };
    addNode(table);
    stack.push(table);
    return true;
  }
  // The reference only accepts a lazy continuation line into a list item
  // when the item's current line is not blank, not indented code, and
  // does not start a fence, heading, HTML block or thematic break. The
  // current line is the open leaf's last line (a fence with no content
  // yet has the fence opener as its current line, so it never accepts).
  function itemAllowsLazy(leaf) {
    if (leaf.t !== 'para' && leaf.t !== 'text' && leaf.t !== 'fence' && leaf.t !== 'html') return false;
    if (leaf.lines.length === 0) return false;
    const m = leaf.lines[leaf.lines.length - 1];
    if (!m.trim()) return false;
    const exp = m.replace(/\t/g, '    ');
    if (exp.search(/[^ ]/) >= 4) return false;
    if (FENCE_RE.test(m)) return false;
    if (ATX_RE.test(m)) return false;
    if (htmlBlockStart(m, false)) return false;
    if (HR_RE.test(m)) return false;
    return true;
  }
  // Is there a (nested) list item between the stack entry at `failIdx`
  // and the open leaf? A lazy line belongs to the outer item, not to a
  // nested item's content.
  function nestedItemBetween(failIdx) {
    for (let j = failIdx + 1; j < stack.length; j++) {
      if (stack[j].t === 'item') return true;
    }
    return false;
  }
  // Does `line` start a block that breaks a lazy paragraph continuation?
  // Any list marker, blockquote marker, ATX heading, fence, thematic break
  // or HTML block (types 1-6) ends the paragraph's container instead.
  function breaksLaziness(line, col0 = 0) {
    if (stripQuoteMarker(line, col0) !== null) return true;
    if (parseListMarker(line, col0)) return true;
    if (ATX_RE.test(line)) return true;
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const info = line.slice(fm[0].length);
      if (!(fm[1][0] === '`' && info.includes('`'))) return true;
    }
    if (HR_RE.test(line)) return true;
    if (htmlBlockStart(line, false)) return true;
    return false;
  }

  // The main loop processes one raw line at a time. A raw line may be
  // reprocessed (after a leaf closes, or after a container opens) without
  // advancing `i`: the inner loop keeps the current `line` until a path
  // consumes it (i++), at which point the inner loop breaks to the next raw
  // line. `needStrip` says whether phase A (container matching) still has
  // to run for the current line.
  while (i < lines.length) {
    const startI = i;
    let line = lines[i];
    let lineCol = 0; // absolute column where `line` starts
    let needStrip = true;
    let strippedQuote = false; // a quote marker was stripped for this line
    for (;;) {
      if (i !== startI) break;
      // ---- Phase A: match open containers ----
      if (needStrip) {
        const r = stripContainers(line, lineCol);
        line = r.line;
        lineCol = r.col;
        strippedQuote = r.strippedQuote;
        const matched = r.matched;
        const lf0 = leaf();
        // The leaf on top of the stack is not a container: `matched` stops
        // before it, so only compare against the container depth.
        const contDepth = stack.length - (lf0 ? 1 : 0);
        if (matched < contDepth && lf0 && !isBlankLine(line)) {
          if (!breaksLaziness(line, lineCol)) {
            const failed = stack[matched];
            const isItemFail = failed && failed.t === 'item';
            // A lazy line may continue an item only when the item's
            // current line is not blank, indented code, or the start of
            // a fence, heading, HTML block or thematic break.
            const lazyOk = !isItemFail || itemAllowsLazy(lf0);
            if (lazyOk && (lf0.t === 'para' || lf0.t === 'text')) {
              // A lazy line can still be a table delimiter for the paragraph's
              // last line, but never a setext underline (that stays literal text).
              if (!tryTableConvert(lf0, line)) {
                lf0.lines.push(lazyLine(lf0, line, lineCol));
              }
              sawBlank = false;
              i++;
              continue;
            }
            if (lazyOk && (lf0.t === 'fence' || lf0.t === 'html') && isItemFail && !nestedItemBetween(matched)) {
              // a lazy line is fence/HTML content as-is: the reference
              // appends it to the item text unstripped
              lf0.lines.push(line);
              sawBlank = false;
              i++;
              continue;
            }
          }
        }
        // ---- Close containers that did not match ----
        if (matched < contDepth) {
          const failed = stack[matched];
          if (failed && failed.t === 'item') {
            const m = parseListMarker(line, lineCol);
            if (m && sameListType(m, failed.list) && !isBlankLine(line)) {
              // a new item of the same list: close everything from the
              // failed item up (nested lists/items/leaves may sit above it)
              // instead of popping the item directly.
              closeFrom(matched);
              if (sawBlank) failed.list.loose = true;
              sawBlank = false;
              const item = { t: 'item', list: failed.list, indent: m.contentIndent,
                             task: false, checked: false, children: [], dead: false };
              if (!m.empty && TASK_TEST_RE.test(m.contentLine)) {
                item.task = true;
                item.checked = /^\[[xX]\]/.test(m.contentLine);
              }
              failed.list.items.push(item);
              stack.push(item);
              line = m.contentLine;
              lineCol = lineCol + m.contentIndent;
              if (line === '') { i++; continue; }
              needStrip = false;
              continue;
            }
          }
          closeFrom(matched);
        }
        needStrip = false;
      }
      // ---- Phase B: process the line at the current level ----
    const cur = leaf();
    if (cur) {
      if (cur.t === 'para' || cur.t === 'text') {
        if (isBlankLine(line)) {
          // A line that is blank only because a blockquote marker was
          // stripped, leaving spaces behind, is paragraph content when
          // it is the last line of the blockquote (the reference re-lexes
          // the quote's text, where the trailing spaces are part of the
          // paragraph).
          if (line.length > 0 && strippedQuote && !nextLineContinuesQuote()) {
            cur.lines.push(line);
            sawBlank = false;
            i++;
            continue;
          }
          closeLeaf(); continue; // reprocess as blank
        }
        const se = SETEXT_RE.exec(line);
        if (se) {
          // setext heading: replace the paragraph with a heading
          const text = cur.lines.join('\n').trim();
          const p = parent();
          p.children.pop();
          stack.pop();
          addNode({ t: 'heading', depth: se[1][0] === '=' ? 1 : 2, text });
          sawBlank = false;
          i++;
          continue;
        }
        const aligns = tableDelimiter(line);
        if (aligns && tryTableConvert(cur, line)) {
          sawBlank = false;
          i++;
          continue;
        }
        // interrupting blocks?
        if (startsBlock(line, cur, lineCol)) {
          closeLeaf();
          continue; // reprocess the line without a paragraph open
        }
        // Inside a list item the reference re-lexes the item text, where
        // a line indented by four or more columns is indented code merged
        // into the text with four columns stripped.
        if (cur.t === 'text') {
          const [ind] = leadingIndent(line, lineCol);
          cur.lines.push(ind >= 4 ? stripIndentCols(line, 4, lineCol) : line);
        } else {
          cur.lines.push(line);
        }
        sawBlank = false;
        i++;
        continue;
      }
      if (cur.t === 'fence') {
        const close = isClosingFence(line, cur);
        if (close) { closeLeaf(); sawBlank = false; i++; continue; }
        // The reference strips the fence indent from content lines only
        // for backtick fences; tilde-fence content is kept verbatim.
        cur.lines.push(cur.fence === '`' ? stripFenceIndent(line, cur.indent) : line);
        sawBlank = false;
        i++;
        continue;
      }
      if (cur.t === 'icode') {
        // A blank line inside indented code keeps its (indent-stripped)
        // spaces; a trailing run of them is dropped when the block closes.
        if (isBlankLine(line)) { cur.lines.push(stripIndentCols(line, 4, lineCol)); sawBlank = false; i++; continue; }
        const [ind] = leadingIndent(line, lineCol);
        if (ind >= 4) { cur.lines.push(stripIndentCols(line, 4, lineCol)); sawBlank = false; i++; continue; }
        closeLeaf();
        continue; // reprocess
      }
      if (cur.t === 'html') {
        if (cur.end === 'blank') {
          if (isBlankLine(line)) {
            // a trailing newline at the very end of the source is kept
            cur.trailNl = i === lines.length - 1 && lines[i] === '';
            closeLeaf();
            continue;
          }
          cur.lines.push(line);
          sawBlank = false;
          i++;
          continue;
        }
        cur.lines.push(line);
        sawBlank = false;
        i++;
        if (cur.marker && line.toLowerCase().includes(cur.marker)) {
          cur.trailNl = htmlTrailNl();
          closeLeaf();
        }
        continue;
      }
      if (cur.t === 'table') {
        // The reference's table-body regex only ends the table on a
        // spaces-only blank line, another block start, or an indented-code
        // line ((?: {4}| {0,3}\t) followed by a character). A tab-only
        // line is a table row, not a blank line, and a pipe-less line is
        // a row too (its cells are padded to the header width).
        const spaceBlank = /^[ ]*$/.test(line);
        const codeLine = /^(?: {4}| {0,3}\t).+/.test(line);
        if (spaceBlank || codeLine || startsBlock(line, cur, lineCol)) {
          closeLeaf();
          continue; // reprocess
        }
        cur.rows.push(splitTableCells(line, cur.header.length).map((c, k) => ({ text: c, align: cur.header[k].align })));
        sawBlank = false;
        i++;
        continue;
      }
    }
    // No leaf open.
    if (isBlankLine(line)) {
      // A line that only reached this point because a blockquote marker
      // was stripped is a real blank line when the quote continues after
      // it, but just the quote's trailing whitespace when the quote ends
      // here (it must not loosen an enclosing list then).
      if (!strippedQuote || nextLineContinuesQuote()) sawBlank = true;
      // A blank line inside an item that has no content yet ends the
      // item: a later line cannot join it (the reference's list tokenizer
      // consumes the blank line and closes the item).
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].t === 'item') {
          if (stack[j].children.length === 0) stack[j].dead = true;
          break;
        }
      }
      i++;
      continue;
    }
    markLooseIfNeeded();
    // Try new blocks, in order.
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const info = line.slice(fm[0].length);
      if (!(fm[1][0] === '`' && info.includes('`'))) {
        const [ind] = leadingIndent(line, lineCol);
        const fence = { t: 'fence', fence: fm[1][0], len: fm[1].length, indent: ind,
                        lang: info.trim().replace(PUNCT_ESC_RE, '$1'), lines: [] };
        addNode(fence);
        stack.push(fence);
        sawBlank = false;
        i++;
        continue;
      }
    }
    const hm = ATX_RE.exec(line);
    if (hm) {
      let text = line.slice(hm[0].length).trim();
      if (text.endsWith('#')) {
        const stripped = text.replace(/#+$/, '');
        if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
      }
      addNode({ t: 'heading', depth: hm[1].length, text });
      sawBlank = false;
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      addNode({ t: 'hr' });
      sawBlank = false;
      i++;
      continue;
    }
    if (stripQuoteMarker(line, lineCol) !== null) {
      const quote = { t: 'quote', children: [] };
      addNode(quote);
      stack.push(quote);
      sawBlank = false;
      const qr = stripQuoteMarker(line, lineCol);
      line = qr.line;
      lineCol = qr.col;
      needStrip = false;
      continue; // process the content line inside the quote
    }
    const lm = parseListMarker(line, lineCol);
    if (lm) {
      const list = { t: 'list', ordered: lm.ordered, bullet: lm.bullet, delim: lm.delim,
                     start: lm.start, loose: false, items: [] };
      addNode(list);
      stack.push(list);
      const item = { t: 'item', list, indent: lm.contentIndent, task: false, checked: false, children: [], dead: false };
      if (!lm.empty && TASK_TEST_RE.test(lm.contentLine)) {
        item.task = true;
        item.checked = /^\[[xX]\]/.test(lm.contentLine);
      }
      list.items.push(item);
      stack.push(item);
      line = lm.contentLine;
      lineCol = lineCol + lm.contentIndent;
      sawBlank = false;
      needStrip = false;
      if (line === '') { i++; continue; }
      continue; // process the content line inside the item
    }
    const hb = htmlBlockStart(line, true);
    if (hb) {
      const html = { t: 'html', end: hb.end, marker: hb.marker, trailNl: false, lines: [line] };
      addNode(html);
      stack.push(html);
      sawBlank = false;
      i++;
      if (hb.end === 'marker' && hb.marker && line.toLowerCase().includes(hb.marker)) {
        html.trailNl = htmlTrailNl();
        closeLeaf();
      }
      continue;
    }
    const [ind] = leadingIndent(line, lineCol);
    if (ind >= 4) {
      const code = { t: 'icode', lines: [stripIndentCols(line, 4, lineCol)] };
      addNode(code);
      stack.push(code);
      sawBlank = false;
      i++;
      continue;
    }
    const defParts = [line];
    for (let k = 1; k <= 4 && i + k < lines.length; k++) defParts.push(stripContainers(lines[i + k]).line);
    const consumed = tryDefinitionText(defParts.join('\n'), links);
    if (consumed > 0) {
      sawBlank = false;
      i += consumed;
      continue;
    }
    // Paragraph (or plain text inside a list item).
    const top = !innermostIsItem();
    const para = { t: top ? 'para' : 'text', lines: [line], runMode: null, runLastI: -1 };
    addNode(para);
    stack.push(para);
    sawBlank = false;
    i++;
    }
  }
  // Close everything left open.
  closeFrom(1);
  return root;
}

// Does `line` start a block that can interrupt an open paragraph?
function startsBlock(line, curLeaf, col0 = 0) {
  const fm = FENCE_RE.exec(line);
  if (fm) {
    const info = line.slice(fm[0].length);
    if (!(fm[1][0] === '`' && info.includes('`'))) return true;
  }
  if (ATX_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (stripQuoteMarker(line, col0) !== null) return true;
  const lm = parseListMarker(line, col0);
  if (lm && !lm.empty) {
    // A list interrupts a paragraph only when its first item is non-empty
    // and (for ordered lists) it starts at 1 — but that start-number rule
    // is a property of top-level paragraphs: plain text inside a list
    // item is interrupted by an ordered list starting at any number.
    if (!lm.ordered || lm.start === 1 || curLeaf.t !== 'para') return true;
  }
  if (htmlBlockStart(line, false)) return true;
  return false;
}

// Is `line` the closing fence for `fence`?
function isClosingFence(line, fence) {
  let i = 0;
  while (i < 3 && i < line.length && line.charCodeAt(i) === 32) i++;
  if (line.slice(i, i + 1) !== fence.fence) return false;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === fence.fence.charCodeAt(0)) j++;
  if (j - i < fence.len) return false;
  return /^[ \t]*$/.test(line.slice(j));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(node, links) {
  switch (node.t) {
    case 'doc': {
      let out = '';
      for (const c of node.children) out += renderBlocks(c, links);
      return out;
    }
    case 'para':
      return '<p>' + renderInline(scanInline(node.text, links).nodes) + '</p>\n';
    case 'text':
      return renderInline(scanInline(node.text, links).nodes);
    case 'heading':
      return '<h' + node.depth + '>' + renderInline(scanInline(node.text, links).nodes) + '</h' + node.depth + '>\n';
    case 'fence':
    case 'icode': {
      const lang = node.lang ? node.lang.match(/^\S*/)[0] : '';
      const text = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
      const open = lang ? '<pre><code class="language-' + escapeKeepEnt(lang) + '">' : '<pre><code>';
      return open + escapeAll(text) + '</code></pre>\n';
    }
    case 'hr':
      return '<hr>\n';
    case 'html':
      return node.text;
    case 'quote': {
      let out = '<blockquote>\n';
      for (const c of node.children) out += renderBlocks(c, links);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of node.items) out += renderItem(item, links);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let head = '';
      for (const cell of node.header) {
        head += cell.align ? '<th align="' + cell.align + '">' : '<th>';
        head += renderInline(scanInline(cell.text, links).nodes) + '</th>\n';
      }
      let out = '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        let body = '';
        for (const row of node.rows) {
          let cells = '';
          for (const cell of row) {
            cells += cell.align ? '<td align="' + cell.align + '">' : '<td>';
            cells += renderInline(scanInline(cell.text, links).nodes) + '</td>\n';
          }
          body += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<tbody>' + body + '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

function renderItem(item, links) {
  const checkbox = item.task
    ? (item.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ')
    : '';
  let out = '<li>';
  const kids = item.children;
  if (kids.length === 0) return out + checkbox + '</li>\n';
  const first = kids[0];
  if (item.task && first.t === 'para') {
    out += '<p>' + checkbox + renderInline(scanInline(first.text, links).nodes) + '</p>\n';
    for (let k = 1; k < kids.length; k++) out += renderBlocks(kids[k], links);
    return out + '</li>\n';
  }
  if (item.task && first.t === 'text') {
    out += checkbox + renderInline(scanInline(first.text, links).nodes);
    for (let k = 1; k < kids.length; k++) out += renderBlocks(kids[k], links);
    return out + '</li>\n';
  }
  for (const c of kids) out += renderBlocks(c, links);
  return out + '</li>\n';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  inlineLink = false;
  const links = Object.create(null);
  const root = parseBlocks(String(markdown).replace(/\r\n?/g, '\n'), links);
  return renderBlocks(root, links);
}
