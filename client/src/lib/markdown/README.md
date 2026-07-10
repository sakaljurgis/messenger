# `lib/markdown` — chat-safe markdown for message bubbles

Renders a message's text as a small, safe markdown subset while reproducing the
app's existing `@mention` styling. Built on `react-markdown` + `remark-gfm` +
`remark-breaks` (all already installed). Self-contained: nothing outside this
folder is imported except the shared mention parser (`../mentions`) and the
`UserDTO` type.

## Usage

```tsx
import { MessageMarkdown } from '@/lib/markdown';

<div className="… bubble …">
  <MessageMarkdown
    content={message.content}
    mentions={message.mentions}
    members={members}
    meId={meId}
    isMine={isMine}
  />
</div>;
```

`MessageMarkdown` is a drop-in replacement for the old inline `MessageContent`
renderer: same props semantics plus markdown. It renders block elements
(`<p>`, lists, `<pre>`, …), so place it inside the bubble container.

### Props

| prop       | type              | meaning                                             |
| ---------- | ----------------- | --------------------------------------------------- |
| `content`  | `string`          | raw markdown source (the message text)              |
| `mentions` | `number[]`        | the message's actual mention ids                    |
| `members`  | `UserDTO[]`       | chat members, used to resolve `@name`               |
| `meId`     | `number`          | viewer's id — drives the "mention of me" highlight  |
| `isMine`   | `boolean`         | true = own (blue) bubble; drives per-side styling   |
| `config`   | `MessageMarkdownConfig?` | rendering preset, defaults to `defaultMessageConfig` |

## What the default preset renders

- **Inline:** bold, italic, strikethrough (gfm), inline code, links.
- **Blocks:** paragraphs (tight spacing), unordered/ordered lists (compact),
  blockquotes, fenced/indented code blocks (scroll horizontally, never wrap).
- **Hard breaks:** a single newline becomes `<br>` (`remark-breaks`) — users
  press Enter for a newline in this app.

### Deliberate exclusions (safety / chat ergonomics)

- **Raw HTML** is never rendered as elements. `react-markdown` escapes it to
  inert literal text (e.g. `<script>…</script>` shows as characters, not a
  script tag). We never add `rehype-raw`.
- **Images** never become `<img>` (a remote fetch would leak the viewer's IP).
  A markdown image degrades to its alt text, or the raw URL if it has none.
- **Links** are scheme-checked: only `http`, `https`, `mailto` survive as
  anchors (opened with `target="_blank" rel="noopener noreferrer"`); anything
  else (`javascript:`, `data:`, relative, …) renders as plain text. Link colors
  differ per bubble side so they stay legible on both blue and gray, light/dark.
- **Headings** render as ordinary paragraphs (no `h1`–`h6` shouting in a
  bubble).
- **Tables / footnotes / task-list checkboxes** are parsed by gfm but are not in
  `allowedElements`; with `unwrapDisallowed` they degrade to their plain text
  content rather than rendering as tables/checkboxes.

## How @mentions integrate

Mentions are handled by a **remark (mdast) plugin**, not string surgery on the
output. `createMentionRemarkPlugin(ctx)` walks mdast `text` nodes and runs the
shared `splitByMentions` on each, wrapping every `@name` run in a `<span>` whose
class is computed by `defaultMentionClassName(isMine, isMeMentioned)` — the exact
classes the app already uses.

The key property: in mdast, inline code and code blocks are `inlineCode` / `code`
nodes that carry a `value` string and have **no `text` children**, so the walk
never visits them. Mentions inside code therefore stay literal and unstyled,
which is the correct semantic. (The span is produced by setting `data.hName`
on the text node, which `mdast-util-to-hast` turns into a real element.)

## Configuration & extension

All behaviour lives in a `MessageMarkdownConfig` value:

```ts
interface MessageMarkdownConfig {
  allowedElements: string[];                                   // tag allow-list
  unwrapDisallowed: boolean;                                   // degrade vs drop
  urlTransform: (url: string) => string;                       // url sanitiser
  buildRemarkPlugins: (ctx: MarkdownRenderContext) => RemarkPlugins;
  buildComponents: (ctx: MarkdownRenderContext) => Components; // element → component/class map
}
```

`defaultMessageConfig` is the chat preset. To make a variant, spread it and
override only what you need — no forking of the component:

```ts
// A richer preset for bot replies that also allows tables.
const botConfig: MessageMarkdownConfig = {
  ...defaultMessageConfig,
  allowedElements: [...defaultMessageConfig.allowedElements, 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  buildComponents: (ctx) => ({
    ...defaultMessageConfig.buildComponents(ctx),
    table: ({ children }) => <table className="…">{children}</table>,
    // …thead/tbody/tr/th/td…
  }),
};

<MessageMarkdown {...props} config={botConfig} />;
```

Other examples the seams are designed for:

- **Restrict** the subset (e.g. a link-free preview): drop `'a'` from
  `allowedElements` — links fall back to plain text automatically.
- **Interactive bot controls:** add a remark plugin in `buildRemarkPlugins`
  that turns a custom syntax into nodes, plus a component in `buildComponents`
  that renders a button/quick-reply.
- **Restyle mentions:** pass your own class function to
  `createMentionRemarkPlugin(ctx, myMentionClassName)` inside a custom
  `buildRemarkPlugins`.

### Public exports

- `MessageMarkdown` (+ `MessageMarkdownProps`) — the component.
- `defaultMessageConfig` — the chat preset.
- `MessageMarkdownConfig`, `MarkdownRenderContext`, `RemarkPlugins` — config types.
- `buildDefaultComponents`, `sideChromeClasses` — the default component/class map.
- `createMentionRemarkPlugin`, `defaultMentionClassName` — mention plumbing.
- `isSafeHref` — the link scheme allow-list predicate.
