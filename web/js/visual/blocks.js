/**
 * ATexVisualEditor — block builder.
 *
 * Turns the flat CST child list into a tree of *blocks* that a rich text view
 * can render: paragraphs, headings (with their sections nested underneath),
 * lists, display math, figure/table widgets, quotes, code.
 *
 * The one invariant that matters
 * -----------------------------
 * Nothing may be lost, ever.  A block therefore keeps *every* CST node it
 * covers, in source order, tagged as visible or hidden:
 *
 *     block.plan = [ {node, visible:true}, {node:'% comment', visible:false}, ... ]
 *
 * Hidden entries are comments and the whitespace that separates paragraphs.
 * The renderer skips them; the writer re-emits them in place.  Because hidden
 * entries remember how many visible nodes preceded them (`after`), an edit that
 * changes the visible nodes still reprints the file exactly — a comment stays
 * attached to the paragraph it was next to.
 */

import * as ast from '../core/ast.js';
import { Kind } from '../core/ast.js';
import { environmentInfo, MATH_ENVS, SECTION_LEVELS } from '../core/latex-knowledge.js';

export const BlockType = {
  Paragraph: 'paragraph',
  Heading: 'heading',
  List: 'list',
  Math: 'math',
  Figure: 'figure',
  Table: 'table',
  Quote: 'quote',
  Code: 'code',
  Raw: 'raw',
  Rule: 'rule',
  Macro: 'macro',
  Preamble: 'preamble',
  Empty: 'empty',
};

const LIST_ENVS = new Set([
  'itemize', 'enumerate', 'description', 'list', 'itemize*', 'enumerate*',
  'compactitem', 'compactenum',
]);
const QUOTE_ENVS = new Set([
  'quote', 'quotation', 'verse', 'displayquote', 'abstract', 'center', 'flushleft',
  'flushright',
]);
const RAW_BLOCK_ENVS = new Set([
  'tikzpicture', 'pgfpicture', 'axis', 'picture', 'picture*', 'forest',
  'algorithmic', 'algorithmicx', 'algorithm', 'algorithm*',
]);
const DOC_BLOCK_COMMANDS = new Set([
  'maketitle', 'tableofcontents', 'listoffigures', 'listoftables', 'newpage',
  'clearpage', 'cleardoublepage', 'appendix', 'printbibliography', 'bibliography',
  'printindex', 'frontmatter', 'mainmatter', 'backmatter',
]);
const MACRO_COMMANDS = new Set([
  'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand',
  'newenvironment', 'renewenvironment', 'def',
]);
const CAPTION_COMMANDS = new Set(['caption', 'captionof']);

// ---------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------

/**
 * Split a text value into content and blank-line chunks.
 * `{text, blank}` — a blank chunk contains a paragraph break.
 */
export function splitTextOnBlankLines(value) {
  if (!/\n[ \t\r]*\n/.test(value)) return [{ text: value, blank: false }];
  const out = [];
  let cursor = 0;
  const re = /\n[ \t\r]*\n[ \t\r\n]*/g;
  let match;
  while ((match = re.exec(value))) {
    if (match.index > cursor) out.push({ text: value.slice(cursor, match.index), blank: false });
    out.push({ text: match[0], blank: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) out.push({ text: value.slice(cursor), blank: false });
  return out;
}

/** Monotonic ordinal used to keep an original's pieces in source order. */
function nextOrder(original) {
  original._order = (original._order || 0) + 1;
  return original._order;
}

/**
 * A copy of a text node covering a sub-range, with consistent offsets.
 *
 * `order` records the piece's position inside its original.  `rebuildPieces`
 * sorts by it, which is what lets the *untouched* pieces of a paragraph be
 * reproduced verbatim (including their line breaks) when one word changes.
 */
function sliceTextNode(node, text, offset, order = null) {
  const original = node.sliceOf || node;
  return {
    kind: Kind.Text,
    id: node.id,
    value: text,
    escaped: node.escaped,
    raw: text,
    start: offset,
    end: offset + text.length,
    _dirty: false,
    parent: node.parent,
    sliceOf: original,
    order: order === null ? nextOrder(original) : order,
  };
}

// ---------------------------------------------------------------------------
// Paragraph assembly
// ---------------------------------------------------------------------------

/**
 * Build paragraph blocks from a run of "prose" nodes.
 *
 * Handles the leading/trailing whitespace of every paragraph, blank-line
 * separators and comments, producing blocks whose `plan` reproduces the input
 * when concatenated.
 */
function paragraphsFromRun(nodes) {
  // -- step 1: flatten into an event stream, in source order ----------------
  const events = [];
  for (const node of nodes) {
    if (node.kind === Kind.Text) {
      const chunks = splitTextOnBlankLines(node.value);
      if (chunks.length === 1) {
        events.push({ kind: 'text', node });
        continue;
      }
      // The node spans a paragraph break: cut it into pieces that each keep
      // consistent offsets.
      let offset = node.start;
      for (const chunk of chunks) {
        const piece = sliceTextNode(node, chunk.text, offset);
        events.push({ kind: chunk.blank ? 'blank' : 'text', node: piece, text: chunk.text });
        offset += chunk.text.length;
      }
      continue;
    }
    if (node.kind === Kind.Comment) {
      events.push({ kind: 'comment', node });
      continue;
    }
    events.push({ kind: 'node', node });
  }

  // -- step 2: cut into groups at blank lines -------------------------------
  const groups = [];
  let current = null;
  /** Separator slices between paragraphs, in source order. */
  let separator = [];
  for (const event of events) {
    if (event.kind === 'blank') {
      if (current) {
        groups.push(current);
        current = null;
      }
      separator.push(event.node);
      continue;
    }
    if (!current) {
      current = { events: [], lead: separator };
      separator = [];
    }
    current.events.push(event);
  }
  if (current) groups.push(current);
  const tail = separator;

  // -- step 3: turn each group into a visible/hidden plan -------------------
  const blocks = [];
  const build = (group) => {
    const visible = [];
    const hidden = [];
    const emitHidden = (node, after) => hidden.push({ node, after });

    for (const event of group.events) {
      if (event.kind === 'comment') {
        emitHidden(event.node, visible.length);
        continue;
      }
      if (event.kind === 'node') {
        visible.push(event.node);
        continue;
      }
      const node = event.node;
      if (node.escaped) {
        if (!node.value) emitHidden(node, visible.length);
        else visible.push(node);
        continue;
      }
      if (!node.value.trim()) {
        // Whitespace between inline content (for example the space in
        // `the \emph{Source} tab`) is part of the flow and must be shown;
        // only genuinely empty nodes are hidden.
        emitHidden(node, visible.length);
        continue;
      }
      visible.push(node);
    }

    // Only the paragraph's own outer edges are moved out of the visible flow.
    // Stripping the whitespace of *every* text node would silently glue words
    // to the commands that follow them.
    if (visible.length) {
      // The first/last *text* node, not the first/last node: a paragraph often
      // begins with an invisible command (`\label`, `\index`) or a chip, and
      // giving up there leaves the paragraph's leading whitespace inside the
      // rendered text — which then throws every later offset mapping off by one.
      const findText = (fromStart) => {
        for (let i = fromStart ? 0 : visible.length - 1; i >= 0 && i < visible.length; i += fromStart ? 1 : -1) {
          const node = visible[i];
          if (node && !node.escaped && node.kind === Kind.Text) return i;
        }
        return -1;
      };
      const trimEdge = (index, side) => {
        if (index < 0) return;
        const node = visible[index];
        const pattern = side === 'lead' ? /^(\s+)/ : /(\s+)$/;
        const match = pattern.exec(node.value);
        if (!match) return;
        const text = match[1];
        const base = Number.isFinite(node.order) ? node.order : 0;
        const at = side === 'lead' ? node.start : node.end - text.length;
        emitHidden(
          sliceTextNode(node, text, at, side === 'lead' ? base - 0.5 : base + 0.5),
          side === 'lead' ? index : index + 1
        );
        const kept = side === 'lead' ? node.value.slice(text.length) : node.value.slice(0, node.value.length - text.length);
        visible[index] = sliceTextNode(node, kept, side === 'lead' ? node.start + text.length : node.start, base);
      };
      trimEdge(findText(true), 'lead');
      trimEdge(findText(false), 'trail');
    }

    for (const node of group.lead || []) emitHidden(node, 0);

    const plan = [];
    const buckets = new Map();
    for (const entry of hidden) {
      const key = Math.max(0, Math.min(entry.after, visible.length));
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(entry.node);
    }
    for (let i = 0; i <= visible.length; i++) {
      for (const node of buckets.get(i) || []) plan.push({ node, visible: false, after: i });
      if (i < visible.length) plan.push({ node: visible[i], visible: true, after: i });
    }
    const hasVisible = visible.some((node) => node.kind !== Kind.Text || node.value.trim().length > 0);
    return {
      // A run of nothing but whitespace and comments is not a paragraph: it is
      // hidden structure that must survive but must not show a placeholder.
      type: hasVisible ? BlockType.Paragraph : BlockType.Empty,
      plan,
      visible: hasVisible ? visible : [],
      nodes: plan.map((entry) => entry.node),
    };
  };

  groups.forEach((group) => blocks.push(build(group)));

  if (!blocks.length && events.length) {
    blocks.push({
      type: BlockType.Empty,
      plan: events.map((event, i) => ({ node: event.node, visible: false, after: i })),
      visible: [],
      nodes: events.map((event) => event.node),
    });
  } else if (tail.length && blocks.length) {
    // Trailing whitespace at the end of the run is carried by the last block
    // as hidden content so the source still round-trips.
    const last = blocks[blocks.length - 1];
    for (const node of tail) last.plan.push({ node, visible: false, after: last.visible.length });
    last.nodes.push(...tail);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Block building
// ---------------------------------------------------------------------------

/**
 * Build the block tree for a list of CST nodes.
 * @returns {{blocks: object[]}}
 */
export function buildBlocks(nodes, list = null) {
  const blocks = [];
  let i = 0;

  // A document is `preamble ... \begin{document} body \end{document}`.
  // The preamble must not be rendered as prose (it is not part of the
  // document's text), and the body must be lifted out of the environment so it
  // reads as the document itself rather than as a boxed container.
  if (!list) {
    const docIndex = nodes.findIndex((node) => node.kind === Kind.Environment && node.name === 'document');
    if (docIndex >= 0) {
      const docEnv = nodes[docIndex];
      const preambleNodes = nodes.slice(0, docIndex);
      const afterNodes = nodes.slice(docIndex + 1);
      if (preambleNodes.length) {
        const inner = buildBlocks(preambleNodes, nodes);
        const macros = inner.blocks.filter((block) => block.type === BlockType.Macro);
        const rest = inner.blocks.filter((block) => block.type !== BlockType.Macro);
        blocks.push({
          type: BlockType.Preamble,
          nodes: preambleNodes,
          list: nodes,
          blocks: rest,
          macros,
        });
      }
      for (const block of buildBlocks(docEnv.children, docEnv.children).blocks) blocks.push(block);
      if (afterNodes.length) {
        for (const block of buildBlocks(afterNodes, nodes).blocks) blocks.push(block);
      }
      for (const block of blocks) if (!block.list) block.list = docEnv.children;
      return { blocks };
    }
  }

  while (i < nodes.length) {
    const node = nodes[i];

    // -- sectioning: heading block with nested content ----------------------
    if (node.kind === Kind.Command && SECTION_LEVELS[node.name] !== undefined) {
      const level = SECTION_LEVELS[node.name];
      const titleArg = node.args[node.args.length - 1];
      const bodyNodes = [];
      let j = i + 1;
      while (j < nodes.length) {
        const candidate = nodes[j];
        if (
          candidate.kind === Kind.Command &&
          SECTION_LEVELS[candidate.name] !== undefined &&
          SECTION_LEVELS[candidate.name] <= level
        ) {
          break;
        }
        bodyNodes.push(candidate);
        j++;
      }
      const inner = buildBlocks(bodyNodes);
      blocks.push({
        type: BlockType.Heading,
        level,
        command: node.name,
        starred: !!node.star,
        node,
        arg: titleArg || null,
        titleNodes: titleArg ? titleArg.children : [],
        blocks: inner.blocks,
      });
      i = j;
      continue;
    }

    // -- environments -------------------------------------------------------
    if (node.kind === Kind.Environment) {
      const info = environmentInfo(node.name);
      if (LIST_ENVS.has(node.name)) {
        blocks.push(buildListBlock(node, list));
        i++;
        continue;
      }
      if (MATH_ENVS.has(node.name) && !info?.inline) {
        blocks.push({ type: BlockType.Math, node, mode: 'display', env: node.name, list });
        i++;
        continue;
      }
      if (info?.verbatim) {
        blocks.push({ type: BlockType.Code, node, env: node.name, list });
        i++;
        continue;
      }
      if (RAW_BLOCK_ENVS.has(node.name)) {
        blocks.push({ type: BlockType.Raw, node, env: node.name, list });
        i++;
        continue;
      }
      if (info?.kind === 'tabular') {
        blocks.push({ type: BlockType.Table, node, env: node.name, float: false, list });
        i++;
        continue;
      }
      if (info?.kind === 'tablefloat') {
        blocks.push({
          type: BlockType.Table,
          node,
          env: node.name,
          float: true,
          placement: node.args[0] ? ast.plainText(node.args[0].children).trim() : '',
          list,
        });
        i++;
        continue;
      }
      if (info?.kind === 'figure') {
        blocks.push({
          type: BlockType.Figure,
          node,
          env: node.name,
          placement: node.args[0] ? ast.plainText(node.args[0].children).trim() : '',
          list,
        });
        i++;
        continue;
      }
      const inner = buildBlocks(node.children, node.children);
      blocks.push({
        type: BlockType.Quote,
        node,
        env: node.name,
        known: !!info,
        variant: info?.kind || 'generic',
        blocks: inner.blocks,
        list,
      });
      i++;
      continue;
    }

    // -- display math -------------------------------------------------------
    if (node.kind === Kind.Math) {
      blocks.push({
        type: node.mode === 'display' ? BlockType.Math : BlockType.Paragraph,
        node,
        list,
        mode: node.mode,
        delim: node.delim,
        plan: node.mode === 'display' ? [] : [{ node, visible: true, after: 0 }],
        visible: node.mode === 'display' ? [] : [node],
        nodes: [node],
      });
      i++;
      continue;
    }

    // -- document-level commands -------------------------------------------
    if (node.kind === Kind.Command && DOC_BLOCK_COMMANDS.has(node.name)) {
      blocks.push({ type: BlockType.Rule, node, list });
      i++;
      continue;
    }
    if (node.kind === Kind.Command && MACRO_COMMANDS.has(node.name)) {
      blocks.push({ type: BlockType.Macro, node, list });
      i++;
      continue;
    }

    // -- gather a run of prose and cut it into paragraphs -------------------
    const run = [];
    let j = i;
    while (j < nodes.length) {
      const candidate = nodes[j];
      if (candidate.kind === Kind.Environment) break;
      if (candidate.kind === Kind.Math && candidate.mode === 'display') break;
      if (candidate.kind === Kind.Command) {
        if (SECTION_LEVELS[candidate.name] !== undefined) break;
        if (DOC_BLOCK_COMMANDS.has(candidate.name) || MACRO_COMMANDS.has(candidate.name)) break;
      }
      run.push(candidate);
      j++;
    }
    if (!run.length) {
      blocks.push({
        type: BlockType.Empty,
        plan: [{ node, visible: false, after: 0 }],
        visible: [],
        nodes: [node],
        list,
      });
      i++;
      continue;
    }
    for (const block of paragraphsFromRun(run)) {
      block.list = list;
      blocks.push(block);
    }
    i = j;
  }

  return { blocks };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Split a list environment's children into items.
 * Anything before the first `\item` or after the last one is preserved.
 */
export function splitListItems(envNode) {
  const items = [];
  const preamble = [];
  const trailing = [];
  let current = null;
  for (const node of envNode.children) {
    if (node.kind === Kind.Command && node.name === 'item') {
      current = {
        node,
        label: node.args[0] ? ast.plainText(node.args[0].children).trim() : '',
        optionalArg: node.args[0] || null,
        nodes: [],
      };
      items.push(current);
      continue;
    }
    if (current) current.nodes.push(node);
    else if (items.length) trailing.push(node);
    else preamble.push(node);
  }
  return { items, preamble, trailing };
}

function buildListBlock(node, list = null) {
  const info = environmentInfo(node.name);
  const listType =
    info?.list === 'enumerate' ? 'enumerate' : info?.list === 'description' ? 'description' : 'itemize';
  const { items, preamble, trailing } = splitListItems(node);
  return {
    type: BlockType.List,
    node,
    env: node.name,
    list,
    listType,
    args: node.args,
    preamble,
    trailing,
    items: items.map((item) => ({
      node: item.node,
      label: item.label,
      optionalArg: item.optionalArg,
      nodes: item.nodes,
      // The item's content lives in the *environment's* child list, which is
      // also where separators (`&`, `\\`, `\item`) live: one list, so the
      // reconciler sees a contiguous range.
      blocks: buildBlocks(item.nodes, node.children).blocks,
    })),
  };
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/** What lives inside a figure environment. */
export function analyseFigure(envNode) {
  let graphics = null;
  let caption = null;
  let label = null;
  const rest = [];
  for (const child of walkInner(envNode)) {
    if (child.kind === Kind.Command && child.name === 'includegraphics' && !graphics) {
      graphics = child;
      continue;
    }
    if (child.kind === Kind.Command && CAPTION_COMMANDS.has(child.name) && !caption) {
      caption = child;
      continue;
    }
    if (child.kind === Kind.Command && child.name === 'label' && !label) {
      label = child;
      continue;
    }
    rest.push(child);
  }
  return { graphics, caption, label, rest };
}

/** Every node inside an environment, in document order. */
function walkInner(envNode) {
  const out = [];
  const visit = (nodes) => {
    for (const node of nodes) {
      out.push(node);
      const kids = ast.childrenOf(node);
      if (kids && node.kind !== Kind.Command) visit(kids);
    }
  };
  visit(envNode.children);
  return out;
}

/**
 * A `table` float holds a caption, a label and (usually) a `tabular` grid.
 * Returns the grid environment plus everything else, in document order.
 */
export function analyseTableFloat(envNode) {
  let tabular = null;
  let caption = null;
  let label = null;
  const rest = [];
  for (const child of walkInner(envNode)) {
    if (child.kind === Kind.Environment && environmentInfo(child.name)?.kind === 'tabular' && !tabular) {
      tabular = child;
      continue;
    }
    if (child.kind === Kind.Command && CAPTION_COMMANDS.has(child.name) && !caption) {
      caption = child;
      continue;
    }
    if (child.kind === Kind.Command && child.name === 'label' && !label) {
      label = child;
      continue;
    }
    rest.push(child);
  }
  return { tabular, caption, label, rest };
}

/** Interpret `width=0.5\textwidth,angle=90` and friends. */
export function parseGraphicsOptions(cmd) {
  const opts = cmd?.args?.find((a) => a.optional);
  const text = opts ? ast.plainText(opts.children).trim() : '';
  const out = { raw: text, width: null, height: null, angle: null, scale: null, widthFraction: null };
  if (!text) return out;
  for (const part of text.split(',')) {
    const [key, value = ''] = part.split('=').map((s) => s.trim());
    if (key === 'width') {
      out.width = value;
      const m = /^([\d.]+)\s*\\textwidth$/.exec(value);
      if (m) out.widthFraction = parseFloat(m[1]);
    } else if (key === 'height') out.height = value;
    else if (key === 'angle') out.angle = value;
    else if (key === 'scale') out.scale = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const RULE_COMMANDS = new Set([
  'hline', 'toprule', 'midrule', 'bottomrule', 'cline', 'cmidrule', 'hdashline',
]);

const isRowBreak = (node) => node.kind === Kind.Command && node.name === '\\';
const isCellSep = (node) => node.kind === Kind.Raw && node.value === '&';
const isRule = (node) => node.kind === Kind.Command && RULE_COMMANDS.has(node.name);
const isBlankTextNode = (node) => node.kind === Kind.Text && !node.value.trim();

/**
 * Read a tabular body as a grid.
 *
 * @returns {{rows: Array, width: number, preamble: any[], trailing: any[], alignArg: any}}
 *   each row: `{ cells: [{nodes}], sep, topRule, bottomRule }`
 */
export function readTable(envNode) {
  const rows = [];
  const preamble = [];
  const trailing = [];
  let cells = [];
  let rowNodes = [];
  let pendingTopRule = null;
  let lastRow = null;
  let open = false;
  let afterLastRow = false;
  /**
   * Nodes that sit between rows (whitespace around rules).  They stay in the
   * CST and are reprinted by the document printer; this list only keeps them
   * out of the cell model, and `_writeTableBody` re-emits them.
   */
  const orphans = [];

  const closeRow = (sepNode, bottomRule = null) => {
    cells.push({ nodes: rowNodes });
    const row = { cells, sep: sepNode, topRule: pendingTopRule, bottomRule };
    pendingTopRule = null;
    rows.push(row);
    lastRow = row;
    cells = [];
    rowNodes = [];
    open = false;
  };

  for (const node of envNode.children) {
    if (isCellSep(node)) {
      cells.push({ nodes: rowNodes });
      rowNodes = [];
      open = true;
      continue;
    }
    if (isRowBreak(node)) {
      closeRow(node);
      afterLastRow = true;
      continue;
    }
    if (isRule(node)) {
      // Whitespace that precedes a rule must not be absorbed into the next
      // cell.  Doing so would make a cell's nodes non-contiguous in the source
      // (cell text would be separated from its own leading space by the rule),
      // and rewriting the cell would then emit its text on the wrong side of
      // the rule.
      const lead = rowNodes.length && !open ? rowNodes.slice() : null;
      const dropLead = () => {
        if (lead) {
          orphans.push(...lead);
          rowNodes = [];
        }
      };
      if (open) {
        closeRow(null, node);
      } else if (lastRow && !lastRow.bottomRule) {
        dropLead();
        lastRow.bottomRule = node;
      } else if (rows.length === 0 && !rowNodes.length) {
        pendingTopRule = node;
      } else if (!open && lastRow) {
        dropLead();
        lastRow.bottomRule = lastRow.bottomRule || node;
      } else {
        dropLead();
        pendingTopRule = node;
      }
      afterLastRow = false;
      continue;
    }
    if (isBlankTextNode(node)) {
      rowNodes.push(node);
      continue;
    }
    if (afterLastRow && rows.length) {
      trailing.push(node);
      afterLastRow = false;
    }
    rowNodes.push(node);
    open = true;
  }

  if (open || rowNodes.length || cells.length) closeRow(null);

  // Whitespace between the last \\. and \end{tabular} is kept as trailing.
  if (lastRow && !trailing.length) {
    const lastCell = lastRow.cells[lastRow.cells.length - 1];
    const lastNodes = lastCell?.nodes || [];
    if (lastNodes.length && lastNodes.every(isBlankTextNode)) {
      trailing.push(...lastNodes);
      lastCell.nodes = [];
    }
  }

  const width = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  for (const row of rows) {
    while (row.cells.length < width) row.cells.push({ nodes: [], empty: true });
  }
  if (preamble.length === 0) {
    // Keep any leading whitespace that did not attach to a row.
    const first = rows[0];
    if (first) {
      const nodes = first.cells[0]?.nodes || [];
      if (nodes.length && nodes.every(isBlankTextNode)) {
        // stays inside the cell: harmless either way
      }
    }
  }
  return {
    rows,
    width,
    preamble,
    trailing,
    orphans,
    alignArg: envNode.args.find((a) => !a.optional) || null,
  };
}

/** Column letters from the tabular argument: `{@{}lrr@{}}` -> ['l','r','r'] */
export function readColumnSpec(envNode) {
  const arg = envNode.args.find((a) => !a.optional);
  const text = arg ? ast.plainText(arg.children) : '';
  const spec = [];
  let depth = 0;
  let skipNext = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (c === '@' || c === '!' || c === '>' || c === '<') {
      skipNext = 1;
      continue;
    }
    if (skipNext) {
      // `@{...}` and `!{...}` were handled by the brace counter; a bare
      // character after @ is skipped too.
      skipNext = 0;
      if (c !== '{') continue;
    }
    if ('lcrpmbXS'.includes(c)) spec.push(c);
  }
  return { spec, raw: text };
}
