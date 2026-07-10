// Configuration layer for chat-message markdown rendering.
//
// The rendering behaviour of `MessageMarkdown` is entirely described by a
// `MessageMarkdownConfig` value: which HTML elements survive, which remark
// plugins run, how URLs are sanitised, and how each element maps to a styled
// React component. `defaultMessageConfig` is the chat-bubble preset. Future
// variants (richer bot markdown, interactive bot controls, a read-only preview,
// …) can spread the default and override individual fields WITHOUT forking the
// component — see the module README for the extension story.

import type { ComponentProps } from 'react';
import type { Options, Components } from 'react-markdown';
import type { Element as HastElement } from 'hast';
import type { Plugin } from 'unified';
import type { Root, Text, Parent, Nodes } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { UserDTO } from '@messenger/shared';
import { splitByMentions, type MentionCandidate } from '../mentions';

/** react-markdown's plugin-list shape, derived without importing `unified`. */
export type RemarkPlugins = NonNullable<Options['remarkPlugins']>;

/**
 * Everything the renderer needs to know about the message being drawn. Passed
 * to the plugin- and component-builders so both mention parsing and per-side
 * link/code styling can react to whose bubble this is.
 */
export interface MarkdownRenderContext {
  /** The message's actual mention ids (server-authoritative). */
  mentions: number[];
  /** Chat members, used to resolve `@name` spans. */
  members: UserDTO[];
  /** The viewing user's id — drives the "mention of me" highlight. */
  meId: number;
  /** True when this is the viewer's own (blue) bubble. */
  isMine: boolean;
}

/**
 * The full description of how a class of messages renders. Swap or extend any
 * field to make a new variant.
 */
export interface MessageMarkdownConfig {
  /** Tag names that survive filtering; everything else is unwrapped to text. */
  allowedElements: string[];
  /** When true, a disallowed element is replaced by its children (its text)
   *  rather than dropped — this is what degrades tables/footnotes/headings. */
  unwrapDisallowed: boolean;
  /** URL sanitiser. Return the url to keep it, or `''` to drop it. The default
   *  is identity because the `a` component owns the scheme allow-list and
   *  renders unsafe links as plain text (see {@link isSafeHref}). */
  urlTransform: (url: string) => string;
  /** Build the remark plugin list for a given message. The default includes
   *  gfm, hard-break handling, and the @mention plugin. */
  buildRemarkPlugins: (ctx: MarkdownRenderContext) => RemarkPlugins;
  /** Build the element → React component map for a given message. */
  buildComponents: (ctx: MarkdownRenderContext) => Components;
}

// ---------------------------------------------------------------------------
// Link safety
// ---------------------------------------------------------------------------

/**
 * Only `http(s)` and `mailto` links are ever rendered as anchors. Anything else
 * (`javascript:`, `data:`, `vbscript:`, `file:`, relative paths, …) is treated
 * as untrusted and rendered as plain text by the `a` component.
 */
export function isSafeHref(href: string): boolean {
  const s = href.trim().toLowerCase();
  return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('mailto:');
}

// ---------------------------------------------------------------------------
// Mention styling — reproduces `MessageContent` in ChatPage.tsx exactly.
// ---------------------------------------------------------------------------

/**
 * The class string for one `@mention` span. Mirrors the app's existing bubble
 * styling: bold everywhere, white underline on your own (blue) bubble, the app
 * blue on other people's bubbles, plus a subtle highlight when the mention is
 * of the viewer in someone else's bubble.
 */
export function defaultMentionClassName(isMine: boolean, isMe: boolean): string {
  const base = isMine ? 'font-semibold underline decoration-white/60' : 'font-semibold text-[#0084ff]';
  const meHighlight = !isMine && isMe ? ' bg-[#0084ff]/10 rounded px-0.5' : '';
  return base + meHighlight;
}

/**
 * A remark (mdast) plugin that walks TEXT nodes, splits each with the shared
 * {@link splitByMentions}, and wraps every `@name` run in a `<span>` carrying
 * the mention classes. Because mdast keeps inline/fenced code as `inlineCode`
 * and `code` nodes (which have a `value`, never `text` children), mentions
 * inside code are never visited and therefore stay literal — the correct
 * semantic. Reuses the app's mention parser; it does not re-implement it.
 */
export function createMentionRemarkPlugin(
  ctx: MarkdownRenderContext,
  mentionClassName: (isMine: boolean, isMe: boolean) => string = defaultMentionClassName,
): Plugin<[], Root> {
  const { members, mentions, meId, isMine } = ctx;
  const candidates: MentionCandidate[] = members;

  function expandText(node: Text): Nodes[] | null {
    const segments = splitByMentions(node.value, candidates, mentions);
    if (!segments.some((s) => s.mention)) return null;
    return segments.map((seg) => {
      if (!seg.mention) return { type: 'text', value: seg.text } as Text;
      const className = mentionClassName(isMine, seg.mention.id === meId);
      // A text node with `data.hName` renders as `<span class="…">text</span>`
      // (mdast-util-to-hast wraps the text in the named element).
      return {
        type: 'text',
        value: seg.text,
        data: { hName: 'span', hProperties: { className: className.split(/\s+/) } },
      } as Text;
    });
  }

  function visit(node: Parent): void {
    const out: Nodes[] = [];
    for (const child of node.children) {
      if (child.type === 'text') {
        const expanded = expandText(child);
        if (expanded) out.push(...expanded);
        else out.push(child);
      } else {
        if ('children' in child && Array.isArray((child as Parent).children)) visit(child as Parent);
        out.push(child);
      }
    }
    // eslint-disable-next-line no-param-reassign
    node.children = out as Parent['children'];
  }

  return () => (tree: Root) => {
    if (mentions.length === 0) return;
    visit(tree);
  };
}

// ---------------------------------------------------------------------------
// Per-side chrome classes (links / code / blockquote / lists / paragraphs).
// ---------------------------------------------------------------------------

/** Tight, chat-bubble block spacing: no top margin on the first block. */
const BLOCK_SPACING = 'mt-2 first:mt-0';

/**
 * Class strings for the non-mention markdown chrome, chosen per bubble side so
 * everything stays legible on a `#0084ff` blue bubble (white text, both themes)
 * and on the gray-200 / dark:gray-700 bubble (dark/light text). Exported so
 * custom configs can reuse or tweak them.
 */
export function sideChromeClasses(isMine: boolean) {
  return {
    paragraph: BLOCK_SPACING,
    strong: 'font-semibold',
    em: 'italic',
    del: 'line-through',
    ul: `${BLOCK_SPACING} list-disc list-inside space-y-0.5`,
    ol: `${BLOCK_SPACING} list-decimal list-inside space-y-0.5`,
    li: 'leading-snug',
    link: isMine
      ? 'font-medium underline decoration-white/60'
      : 'font-medium text-[#0084ff] underline decoration-[#0084ff]/50 dark:text-[#4aa8ff] dark:decoration-[#4aa8ff]/50',
    codeInline: isMine
      ? 'rounded bg-white/20 px-1 py-0.5 font-mono text-[0.85em]'
      : 'rounded bg-black/10 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/15',
    codeBlockPre: isMine
      ? `${BLOCK_SPACING} overflow-x-auto whitespace-pre rounded-lg bg-white/15 p-2`
      : `${BLOCK_SPACING} overflow-x-auto whitespace-pre rounded-lg bg-black/5 p-2 dark:bg-white/10`,
    codeBlockInner: 'font-mono text-[0.85em]',
    blockquote: isMine
      ? `${BLOCK_SPACING} border-l-2 border-white/40 pl-2`
      : `${BLOCK_SPACING} border-l-2 border-black/20 pl-2 text-black/70 dark:border-white/30 dark:text-white/70`,
  };
}

/** True when a `<code>` node is a block (fenced/indented) rather than inline. */
function isBlockCode(node: HastElement | undefined, className: string | undefined): boolean {
  if (className && /\blanguage-/.test(className)) return true;
  const pos = node?.position;
  return !!pos && pos.start.line !== pos.end.line;
}

/**
 * The default chat element → component map. Links get scheme-checked and open
 * safely in a new tab; images become their alt text or url (never an `<img>`);
 * headings render as ordinary paragraphs; code blocks scroll horizontally.
 */
export function buildDefaultComponents(ctx: MarkdownRenderContext): Components {
  const c = sideChromeClasses(ctx.isMine);

  const Heading = ({ children }: ComponentProps<'p'>) => <p className={c.paragraph}>{children}</p>;

  return {
    p: ({ children }) => <p className={c.paragraph}>{children}</p>,
    strong: ({ children }) => <strong className={c.strong}>{children}</strong>,
    em: ({ children }) => <em className={c.em}>{children}</em>,
    del: ({ children }) => <del className={c.del}>{children}</del>,
    ul: ({ children }) => <ul className={c.ul}>{children}</ul>,
    ol: ({ children }) => <ol className={c.ol}>{children}</ol>,
    li: ({ children }) => <li className={c.li}>{children}</li>,
    blockquote: ({ children }) => <blockquote className={c.blockquote}>{children}</blockquote>,
    a: ({ href, children }) => {
      if (!href || !isSafeHref(href)) return <>{children}</>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={c.link}>
          {children}
        </a>
      );
    },
    // Never emit an <img>: remote fetches would leak the viewer's IP. Show the
    // alt text, or fall back to the raw url, as plain text.
    img: ({ alt, src }) => <>{alt || (typeof src === 'string' ? src : '')}</>,
    pre: ({ children }) => <pre className={c.codeBlockPre}>{children}</pre>,
    code: ({ node, className, children }) =>
      isBlockCode(node, className) ? (
        <code className={c.codeBlockInner}>{children}</code>
      ) : (
        <code className={c.codeInline}>{children}</code>
      ),
    h1: Heading,
    h2: Heading,
    h3: Heading,
    h4: Heading,
    h5: Heading,
    h6: Heading,
  };
}

/**
 * The chat-bubble markdown preset: a deliberately small, safe subset.
 *
 * - Inline: bold, italic, strikethrough, code, links (http/https/mailto only).
 * - Blocks: paragraphs, tight lists, blockquotes, fenced/indented code.
 * - Single newlines are hard breaks (remark-breaks) — users press Enter for a
 *   newline in this app.
 * - No raw HTML (react-markdown drops it — we never add rehype-raw).
 * - No images (alt/url text only). Headings render as plain paragraphs.
 * - Tables/footnotes are parsed by gfm but not in `allowedElements`, so with
 *   `unwrapDisallowed` they degrade to their plain text content.
 */
export const defaultMessageConfig: MessageMarkdownConfig = {
  allowedElements: [
    'p',
    'br',
    'span',
    'strong',
    'em',
    'del',
    'a',
    'img',
    'code',
    'pre',
    'ul',
    'ol',
    'li',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
  ],
  unwrapDisallowed: true,
  urlTransform: (url) => url,
  buildRemarkPlugins: (ctx) => [remarkGfm, remarkBreaks, createMentionRemarkPlugin(ctx)],
  buildComponents: buildDefaultComponents,
};
