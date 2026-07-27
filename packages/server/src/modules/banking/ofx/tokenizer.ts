/**
 * A tolerant SGML/XML tokeniser for OFX, and the one reason OB-077 hand-writes it
 * (ROADMAP D-41).
 *
 * OFX is two dialects wearing one schema. 1.x is SGML: a leaf tag is left open —
 * `<TRNAMT>-4.50` ends at the next `<`, never at a `</TRNAMT>` — and the document is
 * fronted by a block of `KEY:VALUE` header lines. 2.x is well-formed XML with a
 * `<?OFX?>` processing instruction and every tag closed. A strict XML parser rejects
 * valid 1.x outright, so pulling one in (there is none in the tree anyway) would trade
 * a small tokeniser for a dependency that cannot read half the format.
 *
 * The trick that lets one scanner read both: an element's scalar value is the text
 * between its open tag and the next `<`, and a leaf implicitly closes the moment
 * another tag opens. In 2.x that text is immediately followed by `</TAG>`, which pops
 * the same element explicitly; in 1.x the next `<TAG>` pops it by the implicit rule.
 * Either way the tree is identical, so nothing downstream has to know which dialect it
 * read — the dialect distinction lives only in `detectDialect`, for a precise error.
 *
 * This is a tokeniser, not a validator: it builds the tree the parser reads and makes
 * no judgement about whether the fields it contains are a statement. That judgement,
 * and every `ValidationError`, belongs to `parser.ts`.
 */

/**
 * One element of an OFX document.
 *
 * `value` is the leaf text (entity-decoded, trimmed) or `null` for an aggregate. Tags
 * are uppercased on the way in because OFX writes them uppercase but the format does
 * not promise it, and every lookup downstream is by a known uppercase name.
 */
export interface OfxNode {
  readonly tag: string;
  value: string | null;
  readonly children: OfxNode[];
}

/** Which dialect a document is, used only to name the format precisely on failure. */
export type OfxDialect = 'ofx1-sgml' | 'ofx2-xml';

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decodes the handful of entities OFX text carries. Both dialects escape `&` as
 * `&amp;` and either may carry a numeric character reference; anything unrecognised is
 * left verbatim rather than dropped, because a statement narrative is evidence (D-42)
 * and mangling it silently is worse than passing it through.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return XML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * SGML with a `KEY:VALUE` header is 1.x; a `<?xml?>`/`<?OFX?>` processing instruction
 * is 2.x. Read from the region before `<OFX>`, because that is the only place the two
 * differ — the body tokenises identically.
 */
export function detectDialect(source: string): OfxDialect | null {
  const rootAt = source.search(/<OFX(?:\s|>)/i);
  if (rootAt < 0) return null;
  const header = source.slice(0, rootAt);
  if (/<\?\s*(?:xml|OFX)\b/i.test(header)) return 'ofx2-xml';
  return 'ofx1-sgml';
}

interface Tag {
  readonly kind: 'open' | 'close' | 'self' | 'skip';
  readonly name: string;
  readonly end: number;
}

/** Reads the tag starting at `lt` (the `<`). `skip` covers PIs, comments, and DTD. */
function readTag(source: string, lt: number): Tag {
  if (source.startsWith('<!--', lt)) {
    const close = source.indexOf('-->', lt + 4);
    return { kind: 'skip', name: '', end: close < 0 ? source.length : close + 3 };
  }
  if (source[lt + 1] === '?' || source[lt + 1] === '!') {
    const gt = source.indexOf('>', lt);
    return { kind: 'skip', name: '', end: gt < 0 ? source.length : gt + 1 };
  }
  const gt = source.indexOf('>', lt);
  const end = gt < 0 ? source.length : gt + 1;
  const inner = source.slice(lt + 1, gt < 0 ? source.length : gt).trim();
  if (inner.startsWith('/')) {
    return { kind: 'close', name: nameOf(inner.slice(1)), end };
  }
  if (inner.endsWith('/')) {
    return { kind: 'self', name: nameOf(inner.slice(0, -1)), end };
  }
  return { kind: 'open', name: nameOf(inner), end };
}

/** The tag name is everything up to the first whitespace — attributes are ignored. */
function nameOf(inner: string): string {
  const match = /^[^\s]*/.exec(inner.trim());
  return (match?.[0] ?? '').toUpperCase();
}

/**
 * Builds the OFX tree, or returns `null` when the source carries no `<OFX>` root.
 *
 * The stack is the whole mechanism. Text is assigned to the element on top; an open
 * tag first pops any leaf that already holds text (the SGML implicit close), then
 * nests under whatever aggregate remains; a close tag unwinds to its matching element,
 * which pops any unclosed leaves inside it for free. A close with no match on the stack
 * is ignored rather than trusted to be meaningful.
 */
export function parseOfxTree(source: string): OfxNode | null {
  const rootAt = source.search(/<OFX(?:\s|>)/i);
  if (rootAt < 0) return null;

  const stack: OfxNode[] = [];
  let root: OfxNode | null = null;
  let i = rootAt;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    const text = source.slice(i, lt < 0 ? source.length : lt);
    if (text.trim() !== '' && stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined) top.value = decodeEntities(text.trim());
    }
    if (lt < 0) break;

    const tag = readTag(source, lt);
    i = tag.end;
    if (tag.kind === 'skip') continue;

    if (tag.kind === 'close') {
      const at = lastIndexOfTag(stack, tag.name);
      if (at >= 0) stack.length = at;
      continue;
    }

    // An open (or self-closing) tag ends any leaf that has already taken its text.
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.value !== null && top.children.length === 0) stack.pop();
      else break;
    }

    const node: OfxNode = { tag: tag.name, value: null, children: [] };
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.children.push(node);
    else if (root === null) root = node;
    if (tag.kind === 'open') stack.push(node);
  }

  return root;
}

function lastIndexOfTag(stack: readonly OfxNode[], name: string): number {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]?.tag === name) return i;
  }
  return -1;
}

/** The first descendant (or self) with this tag, depth-first. */
export function findFirst(node: OfxNode, tag: string): OfxNode | undefined {
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const hit = findFirst(child, tag);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Every descendant with this tag, depth-first. OFX never nests these, so no self. */
export function findAll(node: OfxNode, tag: string): OfxNode[] {
  const out: OfxNode[] = [];
  const visit = (current: OfxNode): void => {
    for (const child of current.children) {
      if (child.tag === tag) out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}

/** A direct child by tag. Preferred over `findFirst` where scope matters. */
export function childOf(node: OfxNode, tag: string): OfxNode | undefined {
  return node.children.find((child) => child.tag === tag);
}

/** The scalar value of a direct child, or `null` when it is absent or an aggregate. */
export function childText(node: OfxNode, tag: string): string | null {
  const child = childOf(node, tag);
  if (child === undefined) return null;
  return child.value !== null && child.value !== '' ? child.value : null;
}
