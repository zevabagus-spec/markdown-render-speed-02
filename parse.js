// parse.js — CommonMark + GFM renderer producing byte-identical output to
// marked 18.1.3 with default options (gfm on, breaks off, pedantic off).
// Dependency-free ES module. Exported: parse(markdown) -> html string.
//
// Architecture: line-based block parser (container matching with a
// column/pending-space cursor for tab handling), then a single-pass inline
// parser with a delimiter stack for emphasis / strikethrough and a bracket
// stack for links / images. Link reference definitions are collected from
// paragraph starts during block parsing; rendering happens afterwards so
// definitions apply document-wide.

// ---------------------------------------------------------------- helpers

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'; }
function isAsciiPunct(c) {
  const n = c.charCodeAt(0);
  return (n >= 33 && n <= 47) || (n >= 58 && n <= 64) || (n >= 91 && n <= 96) || (n >= 123 && n <= 126);
}
function isPunct(c) { return (c.length === 1 && isAsciiPunct(c)) || PUNCT_RE.test(c); }
function isAlnum(c) { return ALNUM_RE.test(c); }
function isWhitespace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || /\s/.test(c); }

function countChar(s, ch) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

// ------------------------------------------------------- escaping / entities

// Text context: escape everything; entities are separate nodes, never text.
function escapeText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

// Code context: escape everything, no entity preservation.
function escapeCode(s) { return escapeText(s); }

// Attribute context (href / title / alt / class): entity-like sequences
// (&name; &#123; &#x1a;) are preserved verbatim, bare & is escaped.
function escapeAttr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const m = /^&(?:#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z0-9]+);/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
      out += '&amp;';
    }
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

// encodeURI-like encoding that leaves '%' untouched (already-encoded
// sequences and bare % pass through verbatim).
function encodeUriLike(dest) {
  let out = '';
  for (let i = 0; i < dest.length; i++) {
    const c = dest[i];
    if (c === '%') { out += '%'; continue; }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
        ';/?:@&=+$-_.!~*\'()#,'.includes(c)) { out += c; continue; }
    const code = dest.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < dest.length) {
      const next = dest.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        try { out += encodeURIComponent(dest.slice(i, i + 2)); } catch (e) { out += dest.slice(i, i + 2); }
        i++;
        continue;
      }
    }
    try { out += encodeURIComponent(c); } catch (e) { out += c; }
  }
  return out;
}

function encodeHref(dest) {
  return escapeAttr(encodeUriLike(dest));
}

// Bare-autolink hrefs: & is escaped WITHOUT entity preservation.
function encodeAutolinkHref(dest) {
  return escapeText(encodeUriLike(dest));
}

function decodeNumericRef(body) {
  // body is the text between &# and ; (e.g. "35" or "x41" or "X22")
  let cp;
  if (body[0] === 'x' || body[0] === 'X') {
    if (!/^[xX][0-9a-fA-F]+$/.test(body)) return null;
    cp = parseInt(body.slice(1), 16);
  } else {
    if (!/^\d+$/.test(body)) return null;
    cp = parseInt(body, 10);
  }
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  try { return String.fromCodePoint(cp); } catch (e) { return '\uFFFD'; }
}

// Unescape backslash escapes: \ + ASCII punct -> punct; otherwise literal.
function unescapeStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

function normalizeRefLabel(s) {
  // Unicode case folding: toLowerCase plus the full-fold mappings that
  // lowercasing misses (ß/ẞ -> ss, ligatures, long s, final sigma,
  // digraphs), so [ẞ] matches [SS] (cm-540).
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st')
    .replace(/ſ/g, 's').replace(/ς/g, 'σ')
    .replace(/ǆ/g, 'dž').replace(/ǉ/g, 'lj').replace(/ǌ/g, 'nj');
}

// ------------------------------------------------------------- node helpers

function mkNode(type, props) {
  const n = { type, parent: null, firstChild: null, lastChild: null, prev: null, next: null };
  if (props) for (const k in props) n[k] = props[k];
  return n;
}
function appendChild(p, c) {
  c.parent = p; c.prev = p.lastChild; c.next = null;
  if (p.lastChild) p.lastChild.next = c; else p.firstChild = c;
  p.lastChild = c;
}
function unlinkNode(n) {
  if (n.prev) n.prev.next = n.next; else if (n.parent) n.parent.firstChild = n.next;
  if (n.next) n.next.prev = n.prev; else if (n.parent) n.parent.lastChild = n.prev;
  n.parent = null; n.prev = null; n.next = null;
}
function insertBeforeNode(ref, n) {
  const p = ref.parent;
  n.parent = p; n.next = ref; n.prev = ref.prev;
  if (ref.prev) ref.prev.next = n; else p.firstChild = n;
  ref.prev = n;
}

// ------------------------------------------- link destination / label parsing

// Parse an inline link destination + optional title starting at text[p0]=='('.
// Returns {dest, title|null, endIdx} (endIdx just past ')') or null.
function parseInlineLink(text, p0) {
  const len = text.length;
  let j = p0 + 1;
  while (j < len && isSpace(text[j])) j++;
  let dest = '';
  if (text[j] === '<') {
    let k = j + 1;
    let buf = '';
    let closed = false;
    while (k < len) {
      const c = text[k];
      if (c === '\n') return null;
      if (c === '\\' && k + 1 < len && isAsciiPunct(text[k + 1])) { buf += text[k + 1]; k += 2; continue; }
      if (c === '<') return null;
      if (c === '>') { closed = true; k++; break; }
      buf += c; k++;
    }
    if (!closed) return null;
    dest = buf;
    j = k;
  } else {
    let depth = 0;
    let buf = '';
    let k = j;
    while (k < len) {
      const c = text[k];
      if (c === '\\' && k + 1 < len && isAsciiPunct(text[k + 1])) { buf += text[k + 1]; k += 2; continue; }
      if (c === '(') { depth++; buf += c; k++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; buf += c; k++; continue;
      }
      if (isSpace(c)) break;
      buf += c; k++;
    }
    if (depth !== 0) return null;
    dest = buf;
    j = k;
  }
  while (j < len && isSpace(text[j])) j++;
  let title = null;
  if (text[j] === '"' || text[j] === "'" || text[j] === '(') {
    const q = text[j];
    let k = j + 1;
    let buf = '';
    let closed = false;
    while (k < len) {
      const c = text[k];
      if (c === '\\' && k + 1 < len && isAsciiPunct(text[k + 1])) { buf += text[k + 1]; k += 2; continue; }
      if (q === '(' && c === '(') return null;
      if (c === (q === '(' ? ')' : q)) { closed = true; k++; break; }
      buf += c; k++;
    }
    if (!closed) return null;
    title = buf;
    j = k;
    while (j < len && isSpace(text[j])) j++;
  }
  if (text[j] !== ')') return null;
  return { dest, title, endIdx: j + 1 };
}

// Parse a reference label starting at text[b0]=='['. Returns {label, endIdx}
// (endIdx just past ']') or null. Labels may nest and span lines.
function parseRefLabel(text, b0) {
  let depth = 1;
  let j = b0 + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\' && j + 1 < text.length && isAsciiPunct(text[j + 1])) { j += 2; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        const label = text.slice(b0 + 1, j);
        if (label.length > 999) return null;
        return { label, endIdx: j + 1 };
      }
    }
    j++;
  }
  return null;
}

// Backtick-compatibility of a raw link label (probed, 30+ cases): collect
// its backtick runs (skipping backslash-escape pairs). An EVEN run count
// is always compatible. An ODD count is compatible only when the last run
// has length >= 2 and ends exactly at the end of the label. Examples:
// [1] no, [2] no, [1,1]/[2,1]/[1,2] yes, [1,1,1] no, [2,1,2] yes only with
// the last run at the end, [1,2,1]/[3,1,3]-mid no, [3,1,3]-end yes.
function backtickCompatible(labelRaw) {
  const runs = [];
  for (let k = 0; k < labelRaw.length; k++) {
    const c = labelRaw[k];
    if (c === '\\' && k + 1 < labelRaw.length && isAsciiPunct(labelRaw[k + 1])) { k++; continue; }
    if (c === '`') {
      let e = k;
      while (e < labelRaw.length && labelRaw[e] === '`') e++;
      runs.push({ len: e - k, end: e });
      k = e - 1;
    }
  }
  if (runs.length % 2 === 0) return true;
  const last = runs[runs.length - 1];
  return last.len >= 2 && last.end === labelRaw.length;
}

// Attempt to resolve a link/image for bracket br closed at text[closeIdx]==']'.
// Pure: no mutation. Returns {dest, title, endIdx} or null.
function tryResolveLink(text, br, closeIdx, refs) {
  const labelRaw = text.slice(br.labelStart, closeIdx);
  const after = closeIdx + 1;
  const next = text[after];
  if (next === '(') {
    const inl = parseInlineLink(text, after);
    if (inl && backtickCompatible(labelRaw)) {
      return { dest: inl.dest, title: inl.title, endIdx: inl.endIdx };
    }
    // Inline parse failed: fall back to the shortcut reference (cm-568).
  } else if (next === '[') {
    const lbl = parseRefLabel(text, after);
    if (lbl) {
      const key = lbl.label === '' ? normalizeRefLabel(labelRaw) : normalizeRefLabel(lbl.label);
      const ref = refs.get(key);
      if (ref && backtickCompatible(labelRaw)) {
        return { dest: ref.dest, title: ref.title, endIdx: lbl.endIdx };
      }
    }
    // A following [label] commits to the full/collapsed form: no
    // shortcut fallback (probed: [foo][bar] with only [foo] defined).
    return null;
  }
  const key = normalizeRefLabel(labelRaw);
  if (!key) return null;
  const ref = refs.get(key);
  if (!ref) return null;
  if (!backtickCompatible(labelRaw)) return null;
  return { dest: ref.dest, title: ref.title, endIdx: after };
}

// ---------------------------------------------------------- extended autolinks

const EMAIL_LOCAL = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-".split(''));
function isDomainChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_';
}

// Chars the email local-part backward scan may cross: alphanumerics plus
// ., +, -, _. Every other punctuation breaks the local part (probed:
// a#b, a$b, a%b, a'b, a/b, a=b, a?b, a^b, a{b, a|b, a}b, a!b, a*b,
// a`b, a&b, a~b all link only b@c.co), while a+b, a.b, a-b, a_b join.
function isLocalBackChar(c) {
  return isAlnum(c) || c === '.' || c === '+' || c === '-' || c === '_';
}

// Scan an email domain starting after '@' at atPos. Returns the domain end
// index, or -1. Labels are [A-Za-z0-9_-]+ runs, >= 2 labels; the domain
// must end with an alphanumeric -- a trailing - or _ poisons the whole
// match (no backtracking): a@b- and a@b_ do not link.
function matchEmailDomain(text, atPos, hasUndOpener) {
  let j = atPos + 1;
  let labels = 0;
  for (;;) {
    const ls2 = j;
    while (j < text.length && isDomainChar(text[j])) {
      // A trailing _ run that can close an open _ delimiter is not part
      // of the domain (__x@y.com__ links; x@y.com__ does not).
      if (hasUndOpener && text[j] === '_') {
        let k = j;
        while (k < text.length && text[k] === '_') k++;
        const fl = flankingInfo(text, j, k - j);
        if (fl.rightFlanking && (!fl.leftFlanking || fl.afterPunct)) break;
      }
      j++;
    }
    if (j === ls2) break;
    labels++;
    if (text[j] === '.' && j + 1 < text.length && isDomainChar(text[j + 1])) { j++; continue; }
    break;
  }
  if (labels < 2) return -1;
  if (!isAlnum(text[j - 1])) return -1;
  return j;
}

// Match an email ending at/after atPos ('@' at atPos). The local part is
// scanned backward over isLocalBackChar (unbounded: it may reach before
// the current run, across _ delimiters; the caller rewinds emitted nodes).
// Returns {start, end} or null.
function matchEmailAt(text, atPos, hasUndOpener) {
  let ls = atPos;
  while (ls > 0 && isLocalBackChar(text[ls - 1])) ls--;
  if (ls < atPos && ls > 0 && text[ls - 1] === '\\') {
    // An odd run of backslashes escapes the first local char: exclude it
    // (foo\+@... links nothing; a\+b@... links only b@...; a\\+b@...
    // links +b@... because the backslashes pair up).
    let bs = 0, p = ls - 1;
    while (p >= 0 && text[p] === '\\') { bs++; p--; }
    if (bs % 2 === 1) ls++;
  }
  if (ls === atPos) return null;
  const local = text.slice(ls, atPos);
  if (local.startsWith('.') || local.endsWith('.')) return null;
  const end = matchEmailDomain(text, atPos, hasUndOpener);
  if (end < 0) return null;
  return { start: ls, end };
}

// Match an email whose local part starts exactly at emailStart (the
// mailto:/xmpp: scheme form). Returns {start, end} or null.
function matchEmailFrom(text, emailStart) {
  let k = emailStart;
  while (k < text.length && isLocalBackChar(text[k])) k++;
  if (text[k] !== '@') return null;
  const local = text.slice(emailStart, k);
  if (!local || local.startsWith('.') || local.endsWith('.')) return null;
  const end = matchEmailDomain(text, k);
  if (end < 0) return null;
  return { start: emailStart, end };
}

// Optional single /segment after an xmpp: email. Segment chars are
// [A-Za-z0-9.@], starting with an alnum; trailing . and @ are stripped.
// Returns the segment end index, or `end` when there is no segment.
function matchXmppSegmentEnd(text, end) {
  if (text[end] !== '/') return end;
  const c1 = text[end + 1];
  if (!c1 || !isAlnum(c1)) return end;
  let k = end + 1;
  while (k < text.length && (isAlnum(text[k]) || text[k] === '.' || text[k] === '@')) k++;
  while (k > end + 1 && (text[k - 1] === '.' || text[k - 1] === '@')) k--;
  if (k === end + 1) return end;
  return k;
}

// Paren depth with floor 0: a ) before an ( does not cover it (probed:
// https://a.com/x)](y truncates at the (, https://a.com/a)b(c too).
function parenDepth(s) {
  let d = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '(') d++;
    else if (s[k] === ')') d = Math.max(0, d - 1);
  }
  return d;
}

// Scan a bare-autolink path starting at `start` (which includes the www. /
// scheme prefix). Applies the bracket-aware ][label] / ]( / shortcut stops,
// then the trailing-trim rules. Returns {path, end} or null.
function scanAutolinkPath(text, start, brackets, refs) {
  const len = text.length;
  const inBracket = brackets.length > 0;
  // A bracket whose label already contains a link can never form one, so
  // the ] stops do not apply inside it (probed doc-08/doc-12).
  const poisoned = inBracket && brackets[brackets.length - 1].hasLink;
  let end = start;
  while (end < len) {
    const c = text[end];
    if (isSpace(c) || c === '<') break;
    if (inBracket && !poisoned && c === ']') {
      const nx = text[end + 1];
      if (nx === '(') break;
      if (nx === '[') {
        const lbl = parseRefLabel(text, end + 1);
        if (lbl) {
          let key;
          if (lbl.label === '') {
            const br = brackets[brackets.length - 1];
            key = normalizeRefLabel(text.slice(br.labelStart, end));
          } else key = normalizeRefLabel(lbl.label);
          if (refs.has(key)) break;
        }
      } else {
        const br = brackets[brackets.length - 1];
        const raw = text.slice(br.labelStart, end);
        const key = normalizeRefLabel(raw);
        if (key && refs.has(key) && backtickCompatible(raw)) break;
      }
    }
    end++;
  }
  let p = text.slice(start, end);
  for (;;) {
    let changed = false;
    const em = /&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z0-9]+);$/.exec(p);
    if (em) { p = p.slice(0, -em[0].length); changed = true; }
    while (p.endsWith(')') && parenDepth(p.slice(0, -1)) === 0) {
      p = p.slice(0, -1); changed = true;
    }
    const pm = /[?!.,:;*_~]+$/.exec(p);
    if (pm) { p = p.slice(0, -pm[0].length); changed = true; }
    if (parenDepth(p) > 0) {
      const lastClose = p.lastIndexOf(')');
      const cutAt = p.indexOf('(', lastClose + 1);
      if (cutAt >= 0) { p = p.slice(0, cutAt); changed = true; }
    }
    if (!changed) break;
  }
  if (p === '') return null;
  return { path: p, end: start + p.length };
}

// Try to match a bare autolink (www. / scheme) at position j.
// Returns {end, href, display} or null. The caller checks suppression.
function matchBareAutolink(text, j, brackets, refs) {
  if (text.startsWith('www.', j)) {
    const prev = j > 0 ? text[j - 1] : '';
    if (prev !== '' && (isAlnum(prev) || prev === '.' || prev === '/' || prev === '-')) return null;
    const c0 = text[j + 4];
    if (!c0 || !(isAlnum(c0) || c0 === '_' || c0 === '-')) return null;
    const p = scanAutolinkPath(text, j, brackets, refs);
    if (!p || p.path.length <= 4) return null;
    return { end: p.end, href: encodeAutolinkHref('http://' + p.path), display: p.path };
  }
  const sm = /^(https?:\/\/|ftp:\/\/)/i.exec(text.slice(j, j + 8));
  if (sm) {
    const p = scanAutolinkPath(text, j, brackets, refs);
    if (!p || p.path.length <= sm[1].length) return null;
    return { end: p.end, href: encodeAutolinkHref(p.path), display: p.path };
  }
  // Only mailto: and xmpp: (lowercase) form scheme+email autolinks;
  // every other scheme leaves the bare email to link on its own (probed).
  // mailto: takes no path; xmpp: takes one /segment.
  for (const scheme of ['mailto:', 'xmpp:']) {
    if (text.startsWith(scheme, j)) {
      const prev = j > 0 ? text[j - 1] : '';
      if (prev !== '' && /[A-Za-z0-9+.-]/.test(prev)) continue;
      const em = matchEmailFrom(text, j + scheme.length);
      if (!em) continue;
      let end = em.end;
      if (scheme === 'xmpp:') end = matchXmppSegmentEnd(text, end);
      const display = text.slice(j, end);
      return { end, href: encodeAutolinkHref(display), display };
    }
  }
  return null;
}

// ------------------------------------------------------- angle autolinks / html

function tryAngleAutolink(text, j) {
  const rest = text.slice(j);
  const m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:)([^ \t\n\r<>]*)>/.exec(rest);
  if (m && m[2].length > 0) {
    const dest = m[1] + m[2];
    return { end: j + m[0].length, href: encodeHref(dest), display: dest };
  }
  const m2 = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)>/.exec(rest);
  if (m2) {
    const email = m2[1];
    const local = email.slice(0, email.indexOf('@'));
    if (!local.startsWith('.') && !local.endsWith('.')) {
      return { end: j + m2[0].length, href: 'mailto:' + encodeHref(email), display: email };
    }
  }
  return null;
}

function tryHtmlToken(text, j) {
  const rest = text.slice(j);
  if (rest.startsWith('<!--')) {
    // Abruptly-closed comments are complete tokens (cm-626).
    if (rest.startsWith('<!-->')) return { end: j + 5, raw: '<!-->' };
    if (rest.startsWith('<!--->')) return { end: j + 6, raw: '<!--->' };
    const e = rest.indexOf('-->', 4);
    if (e >= 0) return { end: j + e + 3, raw: rest.slice(0, e + 3) };
    return null;
  }
  if (rest.startsWith('<?')) {
    const e = rest.indexOf('?>', 2);
    if (e >= 0) return { end: j + e + 2, raw: rest.slice(0, e + 2) };
    return null;
  }
  if (rest.startsWith('<![CDATA[')) {
    const e = rest.indexOf(']]>', 9);
    if (e >= 0) return { end: j + e + 3, raw: rest.slice(0, e + 3) };
    return null;
  }
  if (/^<![A-Za-z]/.test(rest)) {
    const e = rest.indexOf('>');
    if (e >= 0) return { end: j + e + 1, raw: rest.slice(0, e + 1) };
    return null;
  }
  const mc = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(rest);
  if (mc) return { end: j + mc[0].length, raw: mc[0] };
  const mo = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t\n\r"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.exec(rest);
  if (mo) return { end: j + mo[0].length, raw: mo[0] };
  return null;
}

// ------------------------------------------------------------ inline parser

function flankingInfo(text, pos, runLen) {
  const before = pos > 0 ? text[pos - 1] : '';
  const after = pos + runLen < text.length ? text[pos + runLen] : '';
  const beforeWs = before === '' || isWhitespace(before);
  const afterWs = after === '' || isWhitespace(after);
  const beforePunct = before !== '' && isPunct(before);
  const afterPunct = after !== '' && isPunct(after);
  return {
    leftFlanking: !afterWs && (!afterPunct || beforeWs || beforePunct),
    rightFlanking: !beforeWs && (!beforePunct || afterWs || afterPunct),
    beforePunct, afterPunct
  };
}

function isSpecialInlineChar(c) {
  return c === '\\' || c === '`' || c === '*' || c === '_' || c === '~' ||
    c === '[' || c === ']' || c === '!' || c === '<' || c === '&' || c === '\n';
}

function findCodeCloserGlobal(text, from, runLen) {
  let j = from;
  while (j < text.length) {
    if (text[j] === '`') {
      let k = j;
      while (k < text.length && text[k] === '`') k++;
      if (k - j === runLen) return { start: j, end: k };
      j = k;
    } else j++;
  }
  return null;
}

// First ']' closing the innermost open bracket at/after `from` (depth and
// escape aware; code spans are NOT skipped). Returns index or -1.
function findBracketClose(text, from) {
  let depth = 0;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === '\\' && j + 1 < text.length && isAsciiPunct(text[j + 1])) { j++; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

function altTextOf(node) {
  switch (node.type) {
    case 'text': return node.literal;
    case 'entity': return node.raw;
    case 'code': return node.content;
    case 'br': case 'softbreak': return '\n';
    case 'autolink': return node.display;
    case 'html': return node.raw;
    default: {
      let s = '';
      for (let c = node.firstChild; c; c = c.next) s += altTextOf(c);
      return s;
    }
  }
}

function isInside(node, ancestor) {
  let p = node.parent;
  while (p) { if (p === ancestor) return true; p = p.parent; }
  return false;
}

function containsLinkNode(node) {
  if (node.type === 'link') return true;
  for (let c = node.firstChild; c; c = c.next) if (containsLinkNode(c)) return true;
  return false;
}

function unwrapBareAutolinks(node) {
  let c = node.firstChild;
  while (c) {
    const nx = c.next;
    if (c.type === 'autolink' && c.kind === 'bare') {
      const t = mkNode('text', { literal: c.display });
      insertBeforeNode(c, t);
      unlinkNode(c);
    } else {
      unwrapBareAutolinks(c);
    }
    c = nx;
  }
}

// Global code-span zones for delimiter suppression (probed, doc-09): scan
// sequentially like the main pass. Outside a span, \+punct is an escape
// (skipped); a backtick run seeks the next run of EQUAL length, and the
// closer search treats backslashes as literal (they are span content), so
// a \` inside a would-be span still closes it (probed, doc-06). A
// delimiter run inside a zone is literal text, even when the zone's
// opener sits inside a link label (where it renders literally) and its
// closer pairs with a later run for rendering.
function computeCodeZones(text) {
  const zones = [];
  let k = 0;
  while (k < text.length) {
    const c = text[k];
    if (c === '\\' && k + 1 < text.length && isAsciiPunct(text[k + 1])) { k += 2; continue; }
    if (c === '`') {
      let e = k;
      while (e < text.length && text[e] === '`') e++;
      const len = e - k;
      let j = e, closerEnd = -1;
      while (j < text.length) {
        if (text[j] === '`') {
          let f = j;
          while (f < text.length && text[f] === '`') f++;
          if (f - j === len) { closerEnd = f; break; }
          j = f;
        } else j++;
      }
      if (closerEnd >= 0) { zones.push([k, closerEnd]); k = closerEnd; }
      else k = e;
      continue;
    }
    k++;
  }
  return zones;
}

// Pre-scan: label ranges [labelStart, closeIdx] of brackets that WILL form
// a link/image in the main scan. Replicates the main scan's backtick and
// bracket handling (code spans consume their content, so brackets inside
// them never resolve; a backtick run inside a resolving label stays
// literal). Backtick runs inside a formed label are scoped to it and must
// not pair globally (probed, doc-35); labels that never resolve stay
// unscoped (doc-09 behavior).
function computeScopedLabels(text, refs) {
  const scoped = [];
  const stack = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (c === '\\' && i + 1 < len && isAsciiPunct(text[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let k = i;
      while (k < len && text[k] === '`') k++;
      const runLen = k - i;
      let closer = findCodeCloserGlobal(text, k, runLen);
      let activeBr = null;
      for (let b = stack.length - 1; b >= 0; b--) {
        if (stack[b].active) { activeBr = stack[b]; break; }
      }
      if (activeBr) {
        const closePos = findBracketClose(text, k);
        if (closePos >= 0 && (!closer || closePos < closer.start)) {
          if (tryResolveLink(text, activeBr, closePos, refs)) closer = null;
        }
      }
      if (closer) { i = closer.end; continue; }
      i = k;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      stack.push({ labelStart: i + 2, image: true, active: true, hasLink: false });
      i += 2;
      continue;
    }
    if (c === '[') {
      stack.push({ labelStart: i + 1, image: false, active: true, hasLink: false });
      i++;
      continue;
    }
    if (c === ']') {
      let bi = -1;
      for (let b = stack.length - 1; b >= 0; b--) {
        if (stack[b].active) { bi = b; break; }
      }
      if (bi >= 0) {
        const br = stack[bi];
        const res = tryResolveLink(text, br, i, refs);
        if (res && (br.image || !br.hasLink)) {
          const nx = text[i + 1];
          scoped.push({ start: br.labelStart, end: i, kind: nx === '(' ? 'inline' : 'ref' });
          for (let k = 0; k < bi; k++) stack[k].hasLink = true;
          for (let k = bi + 1; k < stack.length; k++) stack[k].active = false;
          stack.splice(bi, 1);
        } else {
          br.active = false;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  return scoped;
}

function parseInline(text, refs, doc) {
  const root = mkNode('root');
  const delims = [];
  const brackets = [];
  const scoped = computeScopedLabels(text, refs);
  // Zone validity (probed q1-q6): a code-span zone is dropped when its
  // opener sits inside a formed REFERENCE-link label and the zone escapes
  // that label (q2, doc-35). Zones opening inside formed INLINE-link
  // labels stay valid (q1, q5, q6, doc-09), including when the closer
  // sits inside another formed label (doc-16).
  const zones = computeCodeZones(text).filter(z => {
    const oRange = scoped.find(s => z[0] >= s.start && z[0] < s.end);
    if (oRange && oRange.kind === 'ref') {
      let cStart = z[1] - 1;
      while (cStart > z[0] && text[cStart - 1] === '`') cStart--;
      if (cStart >= oRange.end) return false;
    }
    return true;
  });
  let zoneIdx = 0;
  function inCodeZone(pos) {
    while (zoneIdx < zones.length && zones[zoneIdx][1] <= pos) zoneIdx++;
    if (!(zoneIdx < zones.length && zones[zoneIdx][0] <= pos && pos < zones[zoneIdx][1])) return false;
    // Label immunity (probed q4, doc-35): a delimiter inside a formed
    // link/image label is immune to a zone that opens OUTSIDE that label
    // (the label's inline content is scoped to the label). Zones opening
    // inside the same label still suppress.
    let innerStart = -1;
    for (const s of scoped) {
      if (pos >= s.start && pos < s.end && s.start > innerStart) innerStart = s.start;
    }
    if (innerStart >= 0 && zones[zoneIdx][0] < innerStart) return false;
    return true;
  }
  let curText = null;
  let i = 0;
  const len = text.length;

  function flushText() { curText = null; }
  function addText(s) {
    if (!s) return;
    if (curText) curText.literal += s;
    else { curText = mkNode('text', { literal: s }); appendChild(root, curText); }
  }
  function addDelimRun(char, runLen, canOpen, canClose) {
    flushText();
    const node = mkNode('text', { literal: char.repeat(runLen) });
    appendChild(root, node);
    const entry = {
      char, n: runLen, n0: runLen, canOpen, canClose, node,
      dead: false, nested: false, blockedFailed: false, linkScope: null, index: delims.length
    };
    node._delim = entry;
    delims.push(entry);
  }

  // Scan one run of non-special chars [start, runEnd); autolinks may extend
  // past runEnd (their paths consume ]/[ etc.). Returns the next index.
  function processRun(start, runEnd) {
    let segStart = start;
    let j = start;
    while (j < runEnd) {
      if (!doc.suppress) {
        const bare = matchBareAutolink(text, j, brackets, refs);
        if (bare) {
          addText(text.slice(segStart, j));
          flushText();
          appendChild(root, mkNode('autolink', { href: bare.href, display: bare.display, kind: 'bare' }));
          j = bare.end; segStart = j;
          if (j >= runEnd) return j;
          continue;
        }
        if (text[j] === '@') {
          const hasUndOpener = delims.some(d => d.char === '_' && !d.dead && d.n > 0 && d.canOpen);
          const em = matchEmailAt(text, j, hasUndOpener);
          if (em) {
            let start = em.start;
            let need = segStart - start;
            let ok = true;
            if (need > 0) {
              // The email starts before this run (across _ delimiters):
              // pre-check that trailing root children are text nodes
              // covering `need` chars; otherwise clamp the start.
              let covered = 0;
              let nd = root.lastChild;
              while (nd && covered < need) {
                if (nd.type !== 'text') break;
                // Never rewind across a live delimiter: __x@y.com__ keeps
                // its opener (the email is x@y.com, not __x@y.com).
                if (nd._delim && !nd._delim.dead && nd._delim.n > 0 &&
                    (nd._delim.canOpen || nd._delim.canClose)) break;
                covered += nd.literal.length;
                nd = nd.prev;
              }
              if (covered < need) {
                start = segStart - covered;
                const local = text.slice(start, j);
                if (!local || local.startsWith('.') || local.endsWith('.')) ok = false;
                need = covered;
              }
            }
            if (ok) {
              if (need > 0) {
                let rem = need;
                while (rem > 0) {
                  const nd = root.lastChild;
                  if (nd.literal.length <= rem) {
                    rem -= nd.literal.length;
                    if (nd._delim) { nd._delim.dead = true; nd._delim.n = 0; }
                    unlinkNode(nd);
                  } else {
                    nd.literal = nd.literal.slice(0, nd.literal.length - rem);
                    rem = 0;
                  }
                }
                flushText();
              }
              addText(text.slice(segStart, start));
              flushText();
              const disp = text.slice(start, em.end);
              appendChild(root, mkNode('autolink', { href: 'mailto:' + encodeAutolinkHref(disp), display: disp, kind: 'bare' }));
              j = em.end; segStart = j;
              if (j >= runEnd) return j;
              continue;
            }
          }
        }
      }
      j++;
    }
    addText(text.slice(segStart, runEnd));
    return runEnd;
  }

  function formLink(br, bi, res) {
    const labelNodes = [];
    for (let n = br.node.next; n; n = n.next) labelNodes.push(n);
    if (!br.image) {
      for (const ln of labelNodes) if (containsLinkNode(ln)) return false;
    }
    let node;
    if (br.image) {
      node = mkNode('image', {
        src: encodeHref(res.dest),
        title: res.title !== null ? escapeAttr(res.title) : null
      });
      // Label nodes stay as children; alt text is computed at render time,
      // after emphasis processing has shaped them.
      for (const ln of labelNodes) { unlinkNode(ln); appendChild(node, ln); }
    } else {
      node = mkNode('link', {
        href: encodeHref(res.dest),
        title: res.title !== null ? escapeAttr(res.title) : null
      });
      for (const ln of labelNodes) { unlinkNode(ln); appendChild(node, ln); }
      for (const d of delims) {
        if (d.node && isInside(d.node, node)) d.linkScope = node;
      }
      unwrapBareAutolinks(node);
    }
    insertBeforeNode(br.node, node);
    unlinkNode(br.node);
    flushText();
    // Outer brackets now contain a link in their labels and can never
    // form links themselves (their ] stops no longer apply to autolinks).
    for (let k = 0; k < bi; k++) brackets[k].hasLink = true;
    for (let k = bi + 1; k < brackets.length; k++) brackets[k].active = false;
    brackets.splice(bi, 1);
    return true;
  }

  while (i < len) {
    const ch = text[i];
    if (ch === '\\') {
      if (i + 1 >= len) { addText('\\'); i++; continue; }
      const nx = text[i + 1];
      if (nx === '\n') {
        flushText();
        appendChild(root, mkNode('br'));
        i += 2;
        // A hard break strips all leading whitespace of the next line.
        while (i < len && (text[i] === ' ' || text[i] === '\t')) i++;
      } else if (isAsciiPunct(nx)) {
        addText(nx);
        i += 2;
      } else {
        addText('\\');
        i++;
      }
      continue;
    }
    if (ch === '`') {
      let k = i;
      while (k < len && text[k] === '`') k++;
      const runLen = k - i;
      let closer = findCodeCloserGlobal(text, k, runLen);
      let activeBr = null;
      for (let b = brackets.length - 1; b >= 0; b--) {
        if (brackets[b].active) { activeBr = brackets[b]; break; }
      }
      if (activeBr) {
        const closePos = findBracketClose(text, k);
        if (closePos >= 0 && (!closer || closePos < closer.start)) {
          if (tryResolveLink(text, activeBr, closePos, refs)) closer = null;
        }
      }
      if (closer) {
        let content = text.slice(k, closer.start).replace(/\n/g, ' ');
        if (content.startsWith(' ') && content.endsWith(' ') && !/^ +$/.test(content)) {
          content = content.slice(1, -1);
        }
        flushText();
        appendChild(root, mkNode('code', { content }));
        i = closer.end;
      } else {
        addText(text.slice(i, k));
        i = k;
      }
      continue;
    }
    if (ch === '*' || ch === '_') {
      let k = i;
      while (k < len && text[k] === ch) k++;
      const runLen = k - i;
      const fl = flankingInfo(text, i, runLen);
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = fl.leftFlanking && (!fl.rightFlanking || fl.beforePunct);
        canClose = fl.rightFlanking && (!fl.leftFlanking || fl.afterPunct);
      } else {
        canOpen = fl.leftFlanking;
        canClose = fl.rightFlanking;
      }
      if (inCodeZone(i)) addText(text.slice(i, k));
      else addDelimRun(ch, runLen, canOpen, canClose);
      i = k;
      continue;
    }
    if (ch === '~') {
      let k = i;
      while (k < len && text[k] === '~') k++;
      const runLen = k - i;
      if (runLen >= 3) {
        addText(text.slice(i, k));
      } else if (inCodeZone(i)) {
        addText(text.slice(i, k));
      } else {
        const fl = flankingInfo(text, i, runLen);
        addDelimRun('~', runLen, fl.leftFlanking, fl.rightFlanking);
      }
      i = k;
      continue;
    }
    if (ch === '[') {
      flushText();
      const node = mkNode('text', { literal: '[' });
      appendChild(root, node);
      brackets.push({ node, image: false, active: true, hasLink: false, labelStart: i + 1 });
      i++;
      continue;
    }
    if (ch === '!') {
      if (text[i + 1] === '[') {
        flushText();
        const node = mkNode('text', { literal: '![' });
        appendChild(root, node);
        brackets.push({ node, image: true, active: true, hasLink: false, labelStart: i + 2 });
        i += 2;
      } else {
        addText('!');
        i++;
      }
      continue;
    }
    if (ch === ']') {
      let bi = -1;
      for (let k = brackets.length - 1; k >= 0; k--) {
        if (brackets[k].active) { bi = k; break; }
      }
      if (bi < 0) { addText(']'); i++; continue; }
      const br = brackets[bi];
      const res = tryResolveLink(text, br, i, refs);
      if (!res || !formLink(br, bi, res)) {
        if (!res) {
          // Probed: when a link attempt (followed by `(` or `[`) fails
          // on backtick incompatibility and the label contains a code
          // span whose content includes a backtick, ALL emphasis
          // delimiters in the label stay literal (x3/x5: both pairs
          // suppressed; w6/v9: no following `(`/`[` -> no suppression;
          // w2: span content without a backtick -> no suppression).
          const labelRaw = text.slice(br.labelStart, i);
          const nx = text[i + 1];
          if ((nx === '(' || nx === '[') && !backtickCompatible(labelRaw)) {
            let hasTickSpan = false;
            const labelNodes = [];
            for (let n = br.node.next; n; n = n.next) {
              labelNodes.push(n);
              if (n.type === 'code' && n.content && n.content.includes('`')) hasTickSpan = true;
            }
            if (hasTickSpan) {
              const inLabel = new Set(labelNodes);
              for (const d of delims) if (d.node && inLabel.has(d.node)) d.dead = true;
            }
          }
        }
        br.active = false;
        addText(']'); i++; continue;
      }
      i = res.endIdx;
      continue;
    }
    if (ch === '<') {
      const ang = tryAngleAutolink(text, i);
      if (ang) {
        flushText();
        appendChild(root, mkNode('autolink', { href: ang.href, display: ang.display, kind: 'angle' }));
        i = ang.end;
        continue;
      }
      const h = tryHtmlToken(text, i);
      if (h) {
        if (/^<[aA] /.test(h.raw)) doc.suppress = true;
        if (h.raw === '</a>' || h.raw === '</A>') doc.suppress = false;
        flushText();
        appendChild(root, mkNode('html', { raw: h.raw }));
        i = h.end;
        continue;
      }
      addText('<');
      i++;
      continue;
    }
    if (ch === '&') {
      const em = /^&([A-Za-z0-9]+);/.exec(text.slice(i));
      if (em) {
        flushText();
        appendChild(root, mkNode('entity', { raw: em[0] }));
        i += em[0].length;
        continue;
      }
      const nm = /^&#([xX][0-9a-fA-F]{1,6}|\d{1,7});/.exec(text.slice(i));
      if (nm) {
        const decoded = decodeNumericRef(nm[1]);
        if (decoded !== null) { addText(decoded); i += nm[0].length; continue; }
      }
      addText('&');
      i++;
      continue;
    }
    if (ch === '\n') {
      let hard = false;
      if (curText && /  +$/.test(curText.literal)) {
        curText.literal = curText.literal.replace(/  +$/, '');
        if (curText.literal === '') unlinkNode(curText);
        flushText();
        appendChild(root, mkNode('br'));
        hard = true;
      } else {
        flushText();
        appendChild(root, mkNode('softbreak'));
      }
      i++;
      // A hard break strips all leading whitespace of the next line.
      if (hard) while (i < len && (text[i] === ' ' || text[i] === '\t')) i++;
      continue;
    }
    let runEnd = i;
    while (runEnd < len && !isSpecialInlineChar(text[runEnd])) runEnd++;
    i = processRun(i, runEnd);
  }

  processEmphasis(delims);
  return renderInlineChildren(root);
}

// ------------------------------------------------- emphasis / strikethrough

function processEmphasis(delims) {
  // Wrappers formed so far, in formation order. Each records its delimiter
  // endpoints, match size, and char for the blocking rule.
  const wrappers = [];

  function wrapNodes(opener, closer, use, wrapperType, leftoverInside) {
    const wrapper = mkNode(wrapperType);
    const middles = [];
    let n = opener.node.next;
    while (n && n !== closer.node) { middles.push(n); n = n.next; }
    insertBeforeNode(closer.node, wrapper);
    for (const m of middles) { unlinkNode(m); appendChild(wrapper, m); }
    // Trim used chars: opener keeps its leading chars, closer its trailing.
    const oLit = opener.node.literal;
    const cLit = closer.node.literal;
    if (leftoverInside) {
      // Probed (blocked-match relaxation): up to 2 leftover chars on each
      // side render INSIDE the wrapper (adjacent to the content); any
      // excess stays outside (before the opener / after the closer).
      const oLeft = oLit.length - use;
      const cLeft = cLit.length - use;
      const oIn = Math.min(2, oLeft);
      const cIn = Math.min(2, cLeft);
      if (oIn > 0) {
        const t = mkNode('text', { literal: opener.char.repeat(oIn) });
        if (wrapper.firstChild) insertBeforeNode(wrapper.firstChild, t);
        else appendChild(wrapper, t);
      }
      if (cIn > 0) appendChild(wrapper, mkNode('text', { literal: closer.char.repeat(cIn) }));
      opener.node.literal = opener.char.repeat(oLeft - oIn);
      closer.node.literal = closer.char.repeat(cLeft - cIn);
    } else {
      opener.node.literal = oLit.slice(0, oLit.length - use);
      closer.node.literal = cLit.slice(use);
    }
    if (opener.node.literal === '') unlinkNode(opener.node);
    if (closer.node.literal === '') unlinkNode(closer.node);
    wrappers.push({ opener, closer, use, char: opener.char });
    return wrapper;
  }

  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (closer.dead || closer.nested || closer.n === 0 || !closer.canClose) continue;
    if (closer.node.parent === null) continue;
    // Snapshot live delimiter lengths at search start (for the unblocking
    // check, delimiters consumed during this search still count).
    const snapN = new Map();
    const snapNested = new Map();
    for (const d of delims) { snapN.set(d, d.n); snapNested.set(d, d.nested); }
    let failedOutright = false;
    let oi = ci - 1;
    while (oi >= 0 && closer.n > 0 && !failedOutright) {
      const cand = delims[oi];
      if (cand.dead || cand.nested || cand.n === 0 || cand.char !== closer.char ||
          cand.linkScope !== closer.linkScope || !cand.canOpen ||
          cand.node.parent === null || closer.node.parent === null ||
          cand.node.parent !== closer.node.parent) { oi--; continue; }

      // Odd-match rule (spec rule 9): if either delimiter can both open and
      // close, the sum of ORIGINAL run lengths must not be a multiple of 3
      // unless both lengths are multiples of 3.
      const eitherBoth = (cand.canOpen && cand.canClose) || (closer.canOpen && closer.canClose);
      if (eitherBoth && (cand.n0 + closer.n0) % 3 === 0 &&
          !(cand.n0 % 3 === 0 && closer.n0 % 3 === 0)) { oi--; continue; }
      // P3 skip.
      if (cand.n0 >= 3 && closer.n0 === 1 && closer.canOpen) { oi--; continue; }
      // P1 skip (formulation B).
      if (cand.blockedFailed && !closer.canOpen &&
          (cand.n >= 2 || closer.n === 2) && (cand.n + closer.n) % 3 !== 2) { oi--; continue; }

      const use = (cand.n >= 2 && closer.n >= 2) ? 2 : 1;

      // spanBlocked: a blocking wrapper strictly between cand and closer,
      // with a differing match size, and no unblocking delimiter.
      let blocked = false;
      for (const w of wrappers) {
        if (w.char !== closer.char) continue;
        if (!(w.opener.index > cand.index && w.closer.index < closer.index)) continue;
        const blocksOuter = !w.opener.canClose && w.closer.canOpen;
        if (!blocksOuter) continue;
        // A same-size wrapper exempts the match only when the match
        // consumes the candidate's entire original run (probed: **a *b*c
        // d* does not match, *a *b*c d* does, **a **b**c d** does).
        if (w.use === use && use === cand.n0) continue;
        // Look for an unblocking delimiter strictly between cand and closer.
        let unblocked = false;
        for (let ui = cand.index + 1; ui < closer.index; ui++) {
          const u = delims[ui];
          if (snapN.get(u) > 0 && !snapNested.get(u) && (u.canOpen || u.canClose) &&
              snapN.get(u) % 3 !== closer.n0 % 3 && snapN.get(u) !== use) { unblocked = true; break; }
        }
        if (!unblocked) { blocked = true; break; }
      }
      // Blocked-match relaxation (probed matrix over opener/closer run
      // lengths with a single inner use-1 wrapper): a blocked match is
      // still allowed for fresh runs when the closer run is at least 3
      // and at least the opener's length (opener 2-4). The match then
      // uses 1 char when the opener run is exactly 3, else 2, and its
      // leftover chars render inside the wrapper (see wrapNodes).
      // Denied configurations stay blocked: (2,1),(2,2),(3,1),(3,2),
      // (4,1),(4,2),(4,3),(5,*) — verified against the oracle matrix.
      let relaxUse = 0;
      if (blocked && cand.n === cand.n0 && closer.n === closer.n0 &&
          cand.n0 >= 2 && cand.n0 <= 4 && closer.n0 >= 3 && closer.n0 >= cand.n0) {
        relaxUse = (cand.n0 === 3) ? 1 : 2;
        if (relaxUse > cand.n || relaxUse > closer.n) relaxUse = 0;
      }
      if (blocked && !relaxUse) {
        // Blocked against this candidate: skip it and keep searching
        // (probed doc-11: the closer still matches an outer opener).
        closer.blockedFailed = true;
        oi--;
        continue;
      }
      const matchUse = relaxUse || use;

      const wrapperType = closer.char === '~' ? 'del' : (matchUse === 2 ? 'strong' : 'em');
      wrapNodes(cand, closer, matchUse, wrapperType, relaxUse > 0);
      if (relaxUse > 0) {
        // Relaxed matches consume both runs entirely for matching: the
        // leftover text is literal and cannot match again (probed m34:
        // no second wrapper forms from the leftovers).
        cand.n = 0;
        closer.n = 0;
        cand.dead = true;
        closer.dead = true;
      } else {
        cand.n -= matchUse;
        closer.n -= matchUse;
        if (cand.n === 0) cand.dead = true;
      }
      // Do not advance oi: the same opener may match again with leftovers.
    }
    if (closer.n === 0) closer.dead = true;
  }
}

// ------------------------------------------------------------ inline rendering

function renderInlineNode(n) {
  switch (n.type) {
    case 'text': return escapeText(n.literal);
    case 'entity': return n.raw;
    case 'code': return '<code>' + escapeCode(n.content) + '</code>';
    case 'br': return '<br>';
    case 'softbreak': return '\n';
    case 'em': return '<em>' + renderInlineChildren(n) + '</em>';
    case 'strong': return '<strong>' + renderInlineChildren(n) + '</strong>';
    case 'del': return '<del>' + renderInlineChildren(n) + '</del>';
    case 'link': {
      let s = '<a href="' + n.href + '"';
      if (n.title !== null) s += ' title="' + n.title + '"';
      return s + '>' + renderInlineChildren(n) + '</a>';
    }
    case 'image': {
      let s = '<img src="' + n.src + '" alt="' + escapeAttr(altTextOf(n)) + '"';
      if (n.title !== null) s += ' title="' + n.title + '"';
      return s + '>';
    }
    case 'autolink': return '<a href="' + n.href + '">' + escapeText(n.display) + '</a>';
    case 'html': return n.raw;
    default: return renderInlineChildren(n);
  }
}

function renderInlineChildren(n) {
  let out = '';
  for (let c = n.firstChild; c; c = c.next) out += renderInlineNode(c);
  return out;
}

// ------------------------------------------------------- line cursor helpers

function makePos(line) { return { s: line, i: 0, col: 0 }; }
function posContent(pos) { return pos.s.slice(pos.i); }

// Expand tabs in the leading whitespace run in place (they become spaces).
function expandLeadingTabs(pos) {
  let j = pos.i, c = pos.col;
  while (j < pos.s.length) {
    const ch = pos.s[j];
    if (ch === ' ') { j++; c++; }
    else if (ch === '\t') {
      const w = 4 - (c % 4);
      pos.s = pos.s.slice(0, j) + ' '.repeat(w) + pos.s.slice(j + 1);
      j += w; c += w;
    } else break;
  }
}

function measureIndentStr(str, baseCol) {
  let col = baseCol;
  for (let j = 0; j < str.length; j++) {
    const ch = str[j];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col - baseCol;
}

// Strip up to n columns of leading whitespace (tabs expand lazily as they
// are consumed; a partially consumed tab leaves spaces behind).
function stripColumns(str, baseCol, n) {
  let s = str, col = baseCol, i = 0, left = n;
  while (left > 0 && i < s.length) {
    const ch = s[i];
    if (ch === ' ') { i++; col++; left--; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      s = s.slice(0, i) + ' '.repeat(w) + s.slice(i + 1);
    }
    else break;
  }
  return s.slice(i);
}

// Consume exactly n columns of leading whitespace in pos (tabs expand in
// place). Returns false if a non-whitespace char is hit first; reaching EOL
// counts as success (blank line).
function consumeColumns(pos, n) {
  while (n > 0) {
    if (pos.i >= pos.s.length) return true;
    const ch = pos.s[pos.i];
    if (ch === ' ') { pos.i++; pos.col++; n--; }
    else if (ch === '\t') {
      const w = 4 - (pos.col % 4);
      pos.s = pos.s.slice(0, pos.i) + ' '.repeat(w) + pos.s.slice(pos.i + 1);
    }
    else return false;
  }
  return true;
}

function atomicStrip(str, n) {
  let i = 0, left = n;
  while (left > 0 && i < str.length) {
    if (str[i] === ' ' || str[i] === '\t') { i++; left--; }
    else break;
  }
  return str.slice(i);
}

// --------------------------------------------------------- container matching

// Try to match one open blockquote at pos. Resets the column grid at this
// quote level. Restores pos on failure.
function matchQuote(pos) {
  const saveS = pos.s, saveI = pos.i, saveCol = pos.col;
  pos.col = 0;
  let skipped = 0;
  while (skipped < 3 && pos.i < pos.s.length) {
    const ch = pos.s[pos.i];
    if (ch === ' ') { pos.i++; pos.col++; skipped++; }
    else if (ch === '\t') {
      const w = 4 - (pos.col % 4);
      if (skipped + w > 3) break;
      pos.s = pos.s.slice(0, pos.i) + ' '.repeat(w) + pos.s.slice(pos.i + 1);
    }
    else break;
  }
  if (pos.s[pos.i] !== '>') { pos.s = saveS; pos.i = saveI; pos.col = saveCol; return false; }
  pos.i++; pos.col++;
  if (pos.s[pos.i] === ' ') { pos.i++; pos.col++; }
  else if (pos.s[pos.i] === '\t') {
    const w = 4 - (pos.col % 4);
    pos.s = pos.s.slice(0, pos.i) + ' '.repeat(w) + pos.s.slice(pos.i + 1);
    pos.i++; pos.col++;
  }
  return true;
}

// Match the open containers against the line. Returns {matchedDepth,
// allMatched}. On failure pos rests at the failure point. For blank lines
// failures are vacuous (containers stay open).
function matchContainers(pos, containers, isBlank) {
  let depth = 0;
  for (let d = 1; d < containers.length; d++) {
    const c = containers[d];
    if (c.type === 'list') { depth = d; continue; }
    if (c.type === 'blockquote') {
      if (!matchQuote(pos)) return { matchedDepth: depth, allMatched: false };
      depth = d;
      continue;
    }
    if (c.type === 'item') {
      const saveS = pos.s, saveI = pos.i, saveCol = pos.col;
      if (!consumeColumns(pos, c.contentIndent)) {
        pos.s = saveS; pos.i = saveI; pos.col = saveCol;
        return { matchedDepth: depth, allMatched: false };
      }
      depth = d;
    }
  }
  return { matchedDepth: depth, allMatched: true };
}

// ------------------------------------------------------- block-start checkers
// All operate on a content string with a content-relative (base 0) grid.

function parseATX(content) {
  const indent = measureIndentStr(content, 0);
  if (indent >= 4) return null;
  const rest = stripColumns(content, 0, indent);
  let k = 0;
  while (k < rest.length && rest[k] === '#') k++;
  if (k === 0 || k > 6) return null;
  if (k < rest.length && rest[k] !== ' ' && rest[k] !== '\t') return null;
  let text = rest.slice(k).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  else {
    const cm = /[ \t]+#+$/.exec(text);
    if (cm) text = text.slice(0, cm.index).replace(/[ \t]+$/, '');
  }
  return { level: k, text };
}

function parseFenceStart(content) {
  const indent = measureIndentStr(content, 0);
  if (indent >= 4) return null;
  const rest = stripColumns(content, 0, indent);
  const ch = rest[0];
  if (ch !== '`' && ch !== '~') return null;
  let k = 0;
  while (k < rest.length && rest[k] === ch) k++;
  if (k < 3) return null;
  const infoRaw = rest.slice(k).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (ch === '`' && infoRaw.includes('`')) return null;
  // Backslash escapes in the info string are resolved (cm-024).
  const info = unescapeStr(infoRaw);
  return { fenceChar: ch, fenceLen: k, fenceIndent: indent, info };
}

function isFenceClose(content, leaf) {
  const indent = measureIndentStr(content, 0);
  if (indent >= 4) return false;
  const rest = stripColumns(content, 0, indent);
  const ch = leaf.fenceChar;
  let k = 0;
  while (k < rest.length && rest[k] === ch) k++;
  if (k < leaf.fenceLen) return false;
  return /^[ \t]*$/.test(rest.slice(k));
}

function isHR(content) {
  const indent = measureIndentStr(content, 0);
  if (indent >= 4) return false;
  const rest = stripColumns(content, 0, indent);
  return /^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest);
}

function parseSetext(content) {
  const indent = measureIndentStr(content, 0);
  if (indent >= 4) return 0;
  const rest = stripColumns(content, 0, indent);
  if (/^=+[ \t]*$/.test(rest)) return 1;
  if (/^-+[ \t]*$/.test(rest)) return 2;
  return 0;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

function htmlBlockStart(content) {
  const indent = measureIndentStr(content, 0);
  if (indent >= 4) return null;
  const rest = stripColumns(content, 0, indent);
  const m1 = /^<(pre|script|style|textarea)(?:[ \t/>]|$)/i.exec(rest);
  if (m1) return { htmlType: 1, tag: m1[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { htmlType: 2 };
  if (rest.startsWith('<?')) return { htmlType: 3 };
  if (/^<![A-Za-z]/.test(rest)) return { htmlType: 4 };
  if (rest.startsWith('<![CDATA[')) return { htmlType: 5 };
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t/>]|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { htmlType: 6 };
  // Type 7: a complete open/close tag alone on the line (plus whitespace).
  const m7o = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t\n\r"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>[ \t]*$/.exec(rest);
  if (m7o) return { htmlType: 7 };
  const m7c = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/.exec(rest);
  if (m7c) return { htmlType: 7 };
  return null;
}

function htmlBlockEnds(node, contentLine) {
  switch (node.htmlType) {
    case 1: return new RegExp('</' + node.tag + '(?:[ \\t/>]|$)', 'i').test(contentLine);
    case 2: return contentLine.includes('-->');
    case 3: return contentLine.includes('?>');
    case 4: return contentLine.includes('>');
    case 5: return contentLine.includes(']]>');
    default: return false;
  }
}

// Parse a NEW blockquote start from content. Returns {rest, colAfter} or null.
function matchQuoteStart(content) {
  let s = content, j = 0, col = 0;
  while (col < 3 && j < s.length) {
    if (s[j] === ' ') { j++; col++; }
    else if (s[j] === '\t') {
      const w = 4 - (col % 4);
      if (col + w > 3) break;
      s = s.slice(0, j) + ' '.repeat(w) + s.slice(j + 1);
    }
    else break;
  }
  if (s[j] !== '>') return null;
  j++; col++;
  if (s[j] === ' ') { j++; col++; }
  else if (s[j] === '\t') {
    const w = 4 - (col % 4);
    s = s.slice(0, j) + ' '.repeat(w) + s.slice(j + 1);
    j++; col++;
  }
  return { rest: s.slice(j), colAfter: col };
}

function parseListStart(content) {
  const indent = measureIndentStr(content, 0);
  if (indent >= 4) return null;
  const rest = stripColumns(content, 0, indent);
  let markerLen = 0, ordered = false, bullet = null, delimiter = null, startNum = null;
  const c0 = rest[0];
  if (c0 === '-' || c0 === '+' || c0 === '*') {
    markerLen = 1; bullet = c0;
  } else if (c0 >= '0' && c0 <= '9') {
    let k = 0;
    while (k < rest.length && rest[k] >= '0' && rest[k] <= '9') k++;
    if (k > 9) return null;
    if (rest[k] !== '.' && rest[k] !== ')') return null;
    ordered = true; delimiter = rest[k]; startNum = parseInt(rest.slice(0, k), 10);
    markerLen = k + 1;
  } else return null;
  const after = rest.slice(markerLen);
  if (after.length > 0 && after[0] !== ' ' && after[0] !== '\t') return null;
  const sepStartCol = indent + markerLen;
  let sepCols = 0, sepEnd = 0, col = sepStartCol;
  while (sepEnd < after.length) {
    const ch = after[sepEnd];
    if (ch === ' ') { sepEnd++; col++; sepCols++; }
    else if (ch === '\t') { const w = 4 - (col % 4); col += w; sepCols += w; sepEnd++; }
    else break;
  }
  const empty = sepEnd >= after.length;
  let contentIndent, isCode;
  if (empty) { contentIndent = indent + markerLen + 1; isCode = false; }
  else if (sepCols >= 5) { contentIndent = indent + markerLen + 1; isCode = true; }
  else { contentIndent = indent + markerLen + sepCols; isCode = false; }
  return { ordered, bullet, delimiter, startNum, markerLen, indent, sepCols, empty, contentIndent, isCode };
}

// Advance past the marker + separator of a list start. Returns {rest, colAfter}.
function advancePastListMarker(content, ls) {
  let s = content, j = 0, col = 0;
  while (col < ls.indent && j < s.length) {
    if (s[j] === ' ') { j++; col++; }
    else if (s[j] === '\t') {
      const w = 4 - (col % 4);
      s = s.slice(0, j) + ' '.repeat(w) + s.slice(j + 1);
    } else break;
  }
  j += ls.markerLen; col += ls.markerLen;
  if (ls.empty) return { rest: '', colAfter: col };
  if (ls.isCode) {
    if (s[j] === ' ') { j++; col++; }
    else if (s[j] === '\t') {
      const w = 4 - (col % 4);
      s = s.slice(0, j) + ' '.repeat(w) + s.slice(j + 1);
      j++; col++;
    }
    return { rest: s.slice(j), colAfter: col };
  }
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) { j++; col++; }
  return { rest: s.slice(j), colAfter: col };
}

// ------------------------------------------------------------- table helpers

// Unescape \| -> | inside a table cell (escape-aware: \\ pairs survive).
// Runs after splitting, so \| inside code spans is also resolved (gfm-200).
function unescapePipes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '\\') { out += '\\\\'; i++; continue; }
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { out += '|'; i++; continue; }
    out += c;
  }
  return out;
}

// Table-cell splitting pairs backtick runs two-by-two in scan order; a
// pair forms a span (no split inside) only when both runs have EQUAL
// length (probed: ``used` | `a|b` splits, `` a ` b `` | `a|b` splits).
function tableSpanIntervals(line) {
  const runs = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && (line[i + 1] === '\\' || line[i + 1] === '|')) { i += 2; continue; }
    if (c === '`') {
      let k = i;
      while (k < line.length && line[k] === '`') k++;
      runs.push({ start: i, end: k, len: k - i });
      i = k; continue;
    }
    i++;
  }
  const intervals = [];
  for (let p = 0; p + 1 < runs.length; p += 2) {
    if (runs[p].len === runs[p + 1].len) intervals.push([runs[p].start, runs[p + 1].end]);
  }
  return intervals;
}

function splitTableCells(line) {
  // Probed (s1/s2/s4/s6/s7/s8/s9): the splitter has NO code-span
  // protection — it splits on every unescaped `|`, even inside backtick
  // spans. Only `\|` (and `\\` pairs) escape the split.
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\\' && i + 1 < n && line[i + 1] === '\\') { cur += '\\\\'; i += 2; continue; }
    if (c === '\\' && i + 1 < n && line[i + 1] === '|') { cur += '\\|'; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  const trimmed = line.trim();
  if (trimmed.startsWith('|') && cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (trimmed.endsWith('|') && cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(s => unescapePipes(s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')));
}

function parseDelimiterRow(line) {
  const cells = splitTableCells(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    if (m[1] === ':' && m[2] === ':') aligns.push('center');
    else if (m[1] === ':') aligns.push('left');
    else if (m[2] === ':') aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

function tryTableStart(headerLine, delimLine) {
  if (!headerLine.includes('|')) return null;
  const header = splitTableCells(headerLine);
  const aligns = parseDelimiterRow(delimLine);
  if (!aligns) return null;
  if (header.length !== aligns.length) return null;
  return { header, aligns };
}

function isTableTabRow(content) {
  if (!/^[ \t]*\t$/.test(content)) return false;
  return measureIndentStr(content, 0) === 4;
}

// ------------------------------------------------- link reference definitions

function parseDefTitle(lines, li, col) {
  const q = lines[li][col];
  const closeCh = q === '(' ? ')' : q;
  let buf = '';
  let curLi = li, k = col + 1;
  while (curLi < lines.length) {
    const L = lines[curLi];
    while (k < L.length) {
      const c = L[k];
      if (c === '\\' && k + 1 < L.length && isAsciiPunct(L[k + 1])) { buf += L[k + 1]; k += 2; continue; }
      if (q === '(' && c === '(') return null;
      if (c === closeCh) {
        let e = k + 1;
        while (e < L.length && (L[e] === ' ' || L[e] === '\t')) e++;
        if (e < L.length) return null;
        return { title: buf, endLi: curLi };
      }
      buf += c; k++;
    }
    curLi++;
    if (curLi < lines.length) { buf += '\n'; k = 0; }
  }
  return null;
}

function parseOneRefDef(lines, startIdx) {
  const line0 = lines[startIdx];
  let indent = 0, j = 0;
  while (j < line0.length) {
    if (line0[j] === ' ') { indent++; j++; }
    else if (line0[j] === '\t') { indent += 4 - (indent % 4); j++; }
    else break;
  }
  if (indent > 3) return null;
  if (line0[j] !== '[') return null;
  let label = '';
  let k = j + 1;
  let curLi = startIdx;
  let found = false, endLi = -1, endCol = -1;
  outer: while (curLi < lines.length) {
    const L = lines[curLi];
    while (k < L.length) {
      const c = L[k];
      if (c === '\\' && k + 1 < L.length && isAsciiPunct(L[k + 1])) { label += L[k] + L[k + 1]; k += 2; continue; }
      // An unescaped '[' inside a ref-def label invalidates it (cm-546).
      if (c === '[') return null;
      // Ref-def labels end at the FIRST unescaped ']' (no nesting): a
      // label like [[foo]] never forms a definition (cm-590).
      if (c === ']') { found = true; endLi = curLi; endCol = k; break outer; }
      label += c; k++;
    }
    curLi++;
    if (curLi < lines.length) { label += '\n'; k = 0; }
  }
  if (!found) return null;
  if (label.length > 999) return null;
  if (normalizeRefLabel(label) === '') return null;
  const endLine = lines[endLi];
  if (endLine[endCol + 1] !== ':') return null;
  let dLi = endLi, dCol = endCol + 2;
  for (;;) {
    const L = lines[dLi];
    while (dCol < L.length && (L[dCol] === ' ' || L[dCol] === '\t')) dCol++;
    if (dCol < L.length) break;
    dLi++;
    if (dLi >= lines.length) return null;
    dCol = 0;
  }
  const dLine = lines[dLi];
  let dest = '';
  let afterDestLi, afterDestCol;
  if (dLine[dCol] === '<') {
    let k2 = dCol + 1, buf = '';
    let closed = false;
    while (k2 < dLine.length) {
      const c = dLine[k2];
      if (c === '\\' && k2 + 1 < dLine.length && isAsciiPunct(dLine[k2 + 1])) { buf += dLine[k2 + 1]; k2 += 2; continue; }
      if (c === '<') return null;
      if (c === '>') { closed = true; k2++; break; }
      buf += c; k2++;
    }
    if (!closed) return null;
    dest = buf;
    afterDestLi = dLi; afterDestCol = k2;
  } else {
    let depth2 = 0, buf = '';
    let k2 = dCol;
    while (k2 < dLine.length) {
      const c = dLine[k2];
      if (c === '\\' && k2 + 1 < dLine.length && isAsciiPunct(dLine[k2 + 1])) { buf += dLine[k2 + 1]; k2 += 2; continue; }
      if (c === '(') { depth2++; buf += c; k2++; continue; }
      if (c === ')') {
        if (depth2 === 0) break;
        depth2--; buf += c; k2++; continue;
      }
      if (c === ' ' || c === '\t') break;
      buf += c; k2++;
    }
    if (depth2 !== 0) return null;
    if (buf === '') return null;
    dest = buf;
    afterDestLi = dLi; afterDestCol = k2;
  }
  let tLi = afterDestLi, tCol = afterDestCol;
  const tLine = lines[tLi];
  while (tCol < tLine.length && (tLine[tCol] === ' ' || tLine[tCol] === '\t')) tCol++;
  // A same-line title requires whitespace between dest and title:
  // [foo]: <bar>(baz) is not a definition (cm-201).
  if (tCol < tLine.length && tCol === afterDestCol) return null;
  let title = null;
  let endIdx = tLi + 1;
  if (tCol >= tLine.length) {
    if (tLi + 1 < lines.length) {
      const nL = lines[tLi + 1];
      let nc = 0;
      while (nc < nL.length && (nL[nc] === ' ' || nL[nc] === '\t')) nc++;
      const qc = nL[nc];
      if (qc === '"' || qc === "'" || qc === '(') {
        const tp = parseDefTitle(lines, tLi + 1, nc);
        // A malformed next-line title does not kill the definition: the
        // def stands without a title and the line is left over (cm-210).
        if (tp) {
          title = tp.title;
          endIdx = tp.endLi + 1;
        }
      }
    }
    return { label, dest, title, nextIdx: endIdx };
  }
  const qc = tLine[tCol];
  if (qc !== '"' && qc !== "'" && qc !== '(') return null;
  const tp = parseDefTitle(lines, tLi, tCol);
  if (!tp) return null;
  title = tp.title;
  endIdx = tp.endLi + 1;
  return { label, dest, title, nextIdx: endIdx };
}

function stripRefDefs(lines, refs) {
  let idx = 0;
  while (idx < lines.length) {
    const res = parseOneRefDef(lines, idx);
    if (!res) break;
    const key = normalizeRefLabel(res.label);
    if (key && !refs.has(key)) refs.set(key, { dest: res.dest, title: res.title });
    idx = res.nextIdx;
  }
  return lines.slice(idx);
}

// ------------------------------------------------------------ block parser

function sameListType(list, ls) {
  if (list.ordered !== ls.ordered) return false;
  if (ls.ordered) return list.delimiter === ls.delimiter;
  return list.bullet === ls.bullet;
}

function parseBlocks(lines, endsWithNL, refs) {
  const doc = { type: 'document', children: [], open: true };
  const containers = [doc];
  let leaf = null;
  let skipNext = -1;

  function tip() { return containers[containers.length - 1]; }

  function finalizeParagraph(p) {
    const rem = stripRefDefs(p.lines, refs);
    if (rem.length === 0) {
      const par = p._parent;
      par.children.splice(par.children.indexOf(p), 1);
      return false;
    }
    p.text = rem.join('\n');
    p.lines = rem;
    p.open = false;
    return true;
  }

  function closeLeaf() {
    if (!leaf) return;
    const l = leaf;
    leaf = null;
    if (l.type === 'paragraph') { finalizeParagraph(l); return; }
    if (l.type === 'codeblock' && !l.fenced) {
      while (l.lines.length > 0 && l.lines[l.lines.length - 1] === '') l.lines.pop();
    }
    if (l.type === 'codeblock' && l.fenced) {
      // Exactly one trailing blank line is dropped (probed: 1 blank -> 0,
      // 2 -> 1, 3 -> 2; blanks before later content are kept).
      if (l.lines.length > 0 && l.lines[l.lines.length - 1] === '') l.lines.pop();
    }
    if (l.type === 'htmlblock') {
      l.text = l.lines.join('\n');
    }
    l.open = false;
  }

  function closeContainersTo(depth) {
    if (leaf && containers.length - 1 > depth) closeLeaf();
    while (containers.length > depth + 1) {
      const c = containers.pop();
      c.open = false;
    }
  }

  function addBlock(node, isContainer) {
    // A list contains only items: any other block closes open lists first.
    while (containers.length > 1 && tip().type === 'list' && node.type !== 'item') {
      const l = containers.pop();
      l.open = false;
    }
    const parent = tip();
    if (leaf && leaf._parent === parent) closeLeaf();
    // Looseness: the addition belongs to the deepest enclosing list L.
    // If L saw a blank line, it becomes loose. Lists outside L only saw
    // an interior blank: their pending flag is cleared, not honored.
    let listIdx = -1;
    for (let d = containers.length - 1; d >= 1; d--) {
      if (containers[d].type === 'list') { listIdx = d; break; }
    }
    if (listIdx >= 0) {
      if (containers[listIdx].blankPending) containers[listIdx].loose = true;
      for (let d = 1; d < listIdx; d++) {
        if (containers[d].type === 'list') containers[d].blankPending = false;
      }
    }
    node._parent = parent;
    parent.children.push(node);
    if (isContainer) containers.push(node);
    else if (node.type === 'paragraph' || node.type === 'codeblock' || node.type === 'htmlblock' || node.type === 'table') {
      leaf = node;
    }
    return node;
  }

  function appendParaLine(content) {
    let line = content;
    const parent = leaf._parent;
    if (parent && parent.type === 'item') {
      const m = /^ +/.exec(line);
      if (m && m[0].length >= 4) line = line.slice(4);
    }
    leaf.lines.push(line);
  }

  function openListItem(ls) {
    const parent = tip();
    if (parent.type === 'list' && sameListType(parent, ls)) {
      // Same list: the item addition below handles looseness.
    } else {
      const list = {
        type: 'list', ordered: ls.ordered, bullet: ls.bullet,
        delimiter: ls.delimiter, start: ls.startNum,
        loose: false, blankPending: false, children: [], open: true
      };
      addBlock(list, true);
    }
    addBlock({ type: 'item', children: [], open: true, contentIndent: ls.contentIndent }, true);
  }

  function peekDelimiterLine(li, depth) {
    if (li + 1 >= lines.length) return null;
    const nextRaw = lines[li + 1];
    if (/^[ \t]*$/.test(nextRaw)) return null;
    const pos = makePos(nextRaw);
    const m = matchContainers(pos, containers, false);
    if (m.matchedDepth < depth) return null;
    return posContent(pos);
  }

  function startsInterruptingBlock(content, li, depth, forLazy) {
    if (parseATX(content)) return true;
    if (parseFenceStart(content)) return true;
    if (isHR(content)) return true;
    const hb = htmlBlockStart(content);
    if (hb && hb.htmlType !== 7) return true;
    if (matchQuoteStart(content)) return true;
    const ls = parseListStart(content);
    if (ls) {
      // In the lazy path (a container already failed) every list marker
      // interrupts. In the same-container paragraph path, empty items
      // and non-1 ordered items cannot interrupt -- unless the paragraph
      // sits directly in a list item (probed: nested lists of any start
      // number, even empty ones, interrupt an item paragraph).
      if (!forLazy && tip().type !== 'item') {
        if (ls.empty) return false;
        if (ls.ordered && ls.startNum !== 1) return false;
      }
      return true;
    }
    if (content.includes('|')) {
      const delimContent = peekDelimiterLine(li, depth);
      if (delimContent !== null && tryTableStart(content, delimContent)) return true;
    }
    return false;
  }

  function startsBlockForTable(content) {
    if (parseATX(content)) return true;
    if (parseFenceStart(content)) return true;
    if (isHR(content)) return true;
    if (htmlBlockStart(content)) return true;
    if (matchQuoteStart(content)) return true;
    if (parseListStart(content)) return true;
    return false;
  }

  function fenceContentLine(content, leafNode) {
    // Probed: tilde fences never strip content indent (doc or quote);
    // backtick fences strip up to the opener's indent.
    if (leafNode.fenceChar === '~') return content;
    if (leafNode.inContainer) {
      let n = leafNode.fenceIndent, k = 0;
      while (n > 0 && k < content.length && content[k] === ' ') { k++; n--; }
      return content.slice(k);
    }
    return atomicStrip(content, leafNode.fenceIndent);
  }

  let prevLineWasLazy = false;
  let prevLineWasBlank = false;
  for (let li = 0; li < lines.length; li++) {
    if (li === skipNext) continue;
    const wasLazy = prevLineWasLazy;
    const wasBlank = prevLineWasBlank;
    prevLineWasLazy = false;
    const rawLine = lines[li];
    const isBlank = /^[ \t]*$/.test(rawLine);
    const pos = makePos(rawLine);
    const m = matchContainers(pos, containers, isBlank);
    let content = posContent(pos);

    // Blank line: raw whitespace-only line, or nothing left after
    // container matching (e.g. ">" or "> " inside a quote). A line like
    // ">  " leaves a space of content and is NOT blank.
    if (isBlank || content === '') {
      prevLineWasBlank = true;
      // A blank line enters an open leaf only when it matched all
      // containers (cm-128: a bare blank line outside a quote does not
      // enter a fenced block inside it).
      if (m.allMatched && leaf && leaf.type === 'codeblock' && leaf.fenced) {
        leaf.lines.push(fenceContentLine(content, leaf));
        continue;
      }
      if (m.allMatched && leaf && leaf.type === 'codeblock' && !leaf.fenced) {
        leaf.lines.push(stripColumns(content, 0, 4));
        continue;
      }
      if (m.allMatched && leaf && leaf.type === 'htmlblock' && leaf.htmlType !== 6 && leaf.htmlType !== 7 && !leaf.ended) {
        leaf.lines.push(content);
        continue;
      }
      // A whitespace-only line ending with a tab that expands to exactly
      // 4 columns is an empty table row, not a blank line (probed).
      if (m.allMatched && leaf && leaf.type === 'table' && isTableTabRow(content)) {
        leaf.rows.push(new Array(leaf.header.length).fill(''));
        continue;
      }
      if (leaf && (leaf.type === 'paragraph' || leaf.type === 'table')) closeLeaf();
      else if (leaf && leaf.type === 'htmlblock') {
        // Probed: an ended (types 1-5) htmlblock closed by a non-empty
        // whitespace-only line keeps a trailing newline; a truly empty
        // line (or an unended types 6/7 block) does not.
        leaf.trailingNL = leaf.ended && isBlank && rawLine.length > 0;
        closeLeaf();
      }
      else if (leaf && leaf.type === 'codeblock') closeLeaf();
      // A blank line marks lists loose, except lists outside the deepest
      // matched quote: a blank inside a quote belongs to the quote, not
      // to an enclosing list (cm-320). Computed before any closes, while
      // matchedDepth still indexes valid containers.
      let qd = -1;
      for (let d = 1; d <= m.matchedDepth; d++) {
        if (containers[d].type === 'blockquote') qd = d;
      }
      for (let d = qd + 1; d < containers.length; d++) {
        if (containers[d].type === 'list') containers[d].blankPending = true;
      }
      // A blank line that does not match an open quote closes that quote
      // (and everything inside it); lists and items stay open (cm-242).
      let qi = -1;
      for (let d = m.matchedDepth + 1; d < containers.length; d++) {
        if (containers[d].type === 'blockquote') { qi = d; break; }
      }
      if (qi >= 0) closeContainersTo(qi - 1);
      // An empty item (no content yet) followed by a blank line is
      // closed: later indented lines do not belong to it (cm-280).
      for (let d = containers.length - 1; d >= 1; d--) {
        if (containers[d].type === 'item' && containers[d].children.length === 0) {
          closeContainersTo(d - 1);
        }
      }
      continue;
    }

    prevLineWasBlank = false;
    if (!m.allMatched) {
      // Fenced code and HTML blocks inside list items survive lines that
      // fail container matching (probed): the line becomes leaf content
      // verbatim (after matched containers), unless a quote is among the
      // failed containers, a blank line intervened, or the line starts
      // a new list item. A fenced block survives ONLY once it already
      // has content: a mismatched FIRST line ends the fence empty (f2,
      // f3). A mismatched fence-close line never closes the fence: the
      // fence ends via container closing and the line reopens a new
      // fence (f7, f8).
      if (!wasBlank && leaf && ((leaf.type === 'codeblock' && leaf.fenced) || leaf.type === 'htmlblock') && !leaf.ended) {
        const survives = leaf.type !== 'codeblock' ||
          (leaf.lines.length > 0 && !isFenceClose(content, leaf));
        let noQuote = true;
        for (let d = m.matchedDepth + 1; d < containers.length; d++) {
          if (containers[d].type === 'blockquote') { noQuote = false; break; }
        }
        if (survives && noQuote && !parseListStart(content)) {
          if (leaf.type === 'codeblock') {
            leaf.lines.push(content);
          } else {
            leaf.lines.push(content);
            if (htmlBlockEnds(leaf, content)) leaf.ended = true;
          }
          continue;
        }
      }
      // Lazy continuation?
      if (leaf && leaf.type === 'paragraph') {
        const lastMatched = containers[m.matchedDepth];
        const lpos = { s: pos.s, i: pos.i, col: pos.col };
        if (lastMatched.type === 'blockquote' || lastMatched.type === 'item') expandLeadingTabs(lpos);
        const lcontent = lpos.s.slice(lpos.i);
        if (!startsInterruptingBlock(lcontent, li, m.matchedDepth, true)) {
          // Lazy continuation: the paragraph continues.
          let lazyContent = lcontent;
          // A lazy Setext-underline-shaped line that is the second (or
          // later) consecutive lazy line inside a failed quote gets its
          // leading whitespace replaced by exactly 4 spaces (cm-093).
          // Items never trigger this.
          let firstFailed = null;
          for (let d = m.matchedDepth + 1; d < containers.length; d++) {
            if (containers[d].type !== 'list') { firstFailed = containers[d]; break; }
          }
          if (wasLazy && firstFailed && firstFailed.type === 'blockquote' && parseSetext(lcontent) > 0) {
            lazyContent = '    ' + lcontent.replace(/^[ \t]*/, '');
          } else {
            // Indented-code strip: 4 leading spaces, only when the
            // leading space run is >= 4 (tabs are never stripped).
            const sp = /^[ ]+/.exec(lazyContent);
            if (sp && sp[0].length >= 4) lazyContent = lazyContent.slice(4);
          }
          appendParaLine(lazyContent);
          prevLineWasLazy = true;
          continue;
        }
      }
      if (leaf && leaf.type === 'htmlblock') leaf.trailingNL = leaf.ended;
      closeContainersTo(m.matchedDepth);
      content = posContent(pos);
    }

    // Expand leading tabs when the innermost container is a quote or item.
    const inner = tip();
    if (inner.type === 'blockquote' || inner.type === 'item') {
      expandLeadingTabs(pos);
      content = posContent(pos);
    }

    // ---- Leaf continuation ----
    if (leaf && leaf.type === 'codeblock' && leaf.fenced) {
      if (isFenceClose(content, leaf)) { closeLeaf(); continue; }
      leaf.lines.push(fenceContentLine(content, leaf));
      continue;
    }
    if (leaf && leaf.type === 'htmlblock') {
      if (leaf.ended) {
        leaf.trailingNL = true;
        closeLeaf();
      } else {
        leaf.lines.push(content);
        if (htmlBlockEnds(leaf, content)) leaf.ended = true;
        continue;
      }
    }
    if (leaf && leaf.type === 'codeblock' && !leaf.fenced) {
      if (measureIndentStr(content, 0) >= 4) {
        leaf.lines.push(stripColumns(content, 0, 4));
        continue;
      }
      closeLeaf();
    }
    if (leaf && leaf.type === 'table') {
      if (startsBlockForTable(content)) {
        closeLeaf();
      } else if (isTableTabRow(content)) {
        leaf.rows.push(new Array(leaf.header.length).fill(''));
        continue;
      } else {
        leaf.rows.push(splitTableCells(content));
        continue;
      }
    }
    if (leaf && leaf.type === 'paragraph') {
      const sx = parseSetext(content);
      if (sx) {
        const rem = stripRefDefs(leaf.lines, refs);
        if (rem.length > 0) {
          const htext = rem.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          const h = { type: 'heading', level: sx, text: htext, _parent: leaf._parent };
          const p = leaf._parent;
          p.children[p.children.indexOf(leaf)] = h;
          leaf = null;
          continue;
        }
        closeLeaf();
      } else {
        const delim = parseDelimiterRow(content);
        let adopted = false;
        if (delim && leaf.lines.length > 0) {
          const lastLine = leaf.lines[leaf.lines.length - 1];
          if (lastLine.includes('|')) {
            const t = tryTableStart(lastLine, content);
            if (t) {
              leaf.lines.pop();
              finalizeParagraph(leaf);
              leaf = null;
              addBlock({ type: 'table', header: t.header, aligns: t.aligns, rows: [], open: true }, false);
              adopted = true;
            }
          }
        }
        if (adopted) continue;
        if (startsInterruptingBlock(content, li, containers.length - 1)) {
          closeLeaf();
        } else {
          appendParaLine(content);
          continue;
        }
      }
    }

    // ---- Block starts: quote / HR / list loop ----
    let lineDone = false;
    for (;;) {
      const q = matchQuoteStart(content);
      if (q) {
        addBlock({ type: 'blockquote', children: [], open: true }, true);
        const cpos = { s: q.rest, i: 0, col: q.colAfter };
        expandLeadingTabs(cpos);
        content = cpos.s;
        continue;
      }
      if (isHR(content)) {
        addBlock({ type: 'hr' }, false);
        lineDone = true;
        break;
      }
      const ls = parseListStart(content);
      if (ls) {
        openListItem(ls);
        const adv = advancePastListMarker(content, ls);
        if (/^[ \t]*$/.test(adv.rest)) { lineDone = true; break; }
        const cpos = { s: adv.rest, i: 0, col: adv.colAfter };
        expandLeadingTabs(cpos);
        content = cpos.s;
        continue;
      }
      break;
    }
    if (lineDone) continue;
    if (/^[ \t]*$/.test(content)) continue;

    // ---- Leaf starts ----
    const atx = parseATX(content);
    if (atx) { addBlock({ type: 'heading', level: atx.level, text: atx.text }, false); continue; }
    const fen = parseFenceStart(content);
    if (fen) {
      const tp = tip();
      addBlock({
        type: 'codeblock', fenced: true, info: fen.info,
        fenceChar: fen.fenceChar, fenceLen: fen.fenceLen, fenceIndent: fen.fenceIndent,
        lines: [], open: true,
        inContainer: tp.type === 'blockquote' || tp.type === 'item'
      }, false);
      continue;
    }
    const hb = htmlBlockStart(content);
    if (hb) {
      const h = {
        type: 'htmlblock', htmlType: hb.htmlType, tag: hb.tag || null,
        lines: [content], ended: false, open: true, trailingNL: false
      };
      if (hb.htmlType !== 6 && htmlBlockEnds(h, content)) h.ended = true;
      addBlock(h, false);
      continue;
    }
    if (content.includes('|')) {
      const delimContent = peekDelimiterLine(li, containers.length - 1);
      if (delimContent !== null) {
        const t = tryTableStart(content, delimContent);
        if (t) {
          addBlock({ type: 'table', header: t.header, aligns: t.aligns, rows: [], open: true }, false);
          skipNext = li + 1;
          continue;
        }
      }
    }
    if (measureIndentStr(content, 0) >= 4) {
      addBlock({ type: 'codeblock', fenced: false, lines: [stripColumns(content, 0, 4)], open: true }, false);
      continue;
    }
    const para = { type: 'paragraph', lines: [], open: true };
    addBlock(para, false);
    appendParaLine(content);
  }

  if (leaf && leaf.type === 'htmlblock') leaf.trailingNL = endsWithNL;
  closeLeaf();
  closeContainersTo(0);
  return doc;
}

// ------------------------------------------------------------ block rendering

function renderBlock(node, refs, doc) {
  switch (node.type) {
    case 'document': {
      let out = '';
      for (const c of node.children) out += renderBlock(c, refs, doc);
      return out;
    }
    case 'blockquote': {
      let out = '<blockquote>\n';
      for (const c of node.children) out += renderBlock(c, refs, doc);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const startAttr = (node.ordered && node.start !== 1) ? ' start="' + node.start + '"' : '';
      const items = node.children.map(c => renderBlock(c, refs, doc));
      return '<' + tag + startAttr + '>\n' + items.join('\n') + '\n</' + tag + '>\n';
    }
    case 'item': {
      const list = node._parent;
      const loose = list && list.loose;
      let inner = '';
      for (let k = 0; k < node.children.length; k++) {
        const c = node.children[k];
        if (!loose && c.type === 'paragraph') {
          inner += renderParagraphInner(c, refs, doc);
        } else {
          inner += renderBlock(c, refs, doc);
        }
      }
      return '<li>' + inner + '</li>';
    }
    case 'paragraph':
      return '<p>' + renderParagraphInner(node, refs, doc) + '</p>\n';
    case 'heading':
      return '<h' + node.level + '>' + parseInline(node.text, refs, doc) + '</h' + node.level + '>\n';
    case 'codeblock': {
      const content = node.lines.length > 0 ? node.lines.join('\n') + '\n' : '';
      if (node.fenced && node.info) {
        const lang = node.info.split(/[ \t]/, 1)[0];
        return '<pre><code class="language-' + escapeAttr(lang) + '">' + escapeCode(content) + '</code></pre>\n';
      }
      return '<pre><code>' + escapeCode(content) + '</code></pre>\n';
    }
    case 'htmlblock':
      return node.text + (node.trailingNL ? '\n' : '');
    case 'hr':
      return '<hr>\n';
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      out += node.header.map((cell, k) => {
        const a = node.aligns[k];
        return '<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(cell, refs, doc) + '</th>';
      }).join('\n');
      out += '\n</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          const cells = [];
          for (let k = 0; k < node.header.length; k++) {
            const a = node.aligns[k];
            const cell = k < row.length ? row[k] : '';
            cells.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(cell, refs, doc) + '</td>');
          }
          out += '<tr>\n' + cells.join('\n') + '\n</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

// Paragraph inner HTML, with task-list checkbox handling for the first
// paragraph of a list item (checked via the paragraph's parent chain).
function renderParagraphInner(node, refs, doc) {
  const text = node.text;
  const parent = node._parent;
  if (parent && parent.type === 'item' && parent.children[0] === node) {
    const m = /^\[( |x|X)\] /.exec(text);
    if (m) {
      const checked = m[1] === 'x' || m[1] === 'X';
      const box = checked
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      return box + ' ' + parseInline(text.slice(4), refs, doc);
    }
  }
  return parseInline(text, refs, doc);
}

// ------------------------------------------------------------------ entry point

export function parse(markdown) {
  let src = String(markdown);
  src = src.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  const endsWithNL = src.endsWith('\n');
  const lines = src.split('\n');
  if (endsWithNL) lines.pop();
  const refs = new Map();
  const doc = parseBlocks(lines, endsWithNL, refs);
  const state = { suppress: false };
  return renderBlock(doc, refs, state);
}
