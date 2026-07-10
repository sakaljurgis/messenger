import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { UserDTO } from '@messenger/shared';
import { MessageMarkdown } from './MessageMarkdown';
import { defaultMessageConfig, isSafeHref, defaultMentionClassName } from './config';

const me: UserDTO = { id: 1, email: 'me@x.com', displayName: 'Me', isBot: false };
const alice: UserDTO = { id: 2, email: 'alice@x.com', displayName: 'Alice', isBot: false };
const members = [me, alice];

/** Render a message with sensible defaults; override per-test. */
function renderMessage(
  content: string,
  opts: Partial<{
    mentions: number[];
    members: UserDTO[];
    meId: number;
    isMine: boolean;
    config: typeof defaultMessageConfig;
  }> = {},
) {
  const { container } = render(
    <MessageMarkdown
      content={content}
      mentions={opts.mentions ?? []}
      members={opts.members ?? members}
      meId={opts.meId ?? me.id}
      isMine={opts.isMine ?? false}
      config={opts.config ?? defaultMessageConfig}
    />,
  );
  return container;
}

describe('MessageMarkdown — subset rendering', () => {
  it('renders bold, italic and strikethrough', () => {
    const c = renderMessage('**bold** and *italic* and ~~struck~~');
    expect(c.querySelector('strong')?.textContent).toBe('bold');
    expect(c.querySelector('em')?.textContent).toBe('italic');
    expect(c.querySelector('del')?.textContent).toBe('struck');
  });

  it('renders inline code with a contrasting background class', () => {
    const c = renderMessage('use `npm test` now');
    const code = c.querySelector('code');
    expect(code?.textContent).toBe('npm test');
    // inline code carries the subtle-background class, not the block treatment
    expect(code?.getAttribute('class')).toContain('bg-');
    expect(c.querySelector('pre')).toBeNull();
  });

  it('renders a fenced code block that scrolls horizontally', () => {
    const c = renderMessage('```\nline one\nline two\n```');
    const pre = c.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.getAttribute('class')).toContain('overflow-x-auto');
    expect(pre?.querySelector('code')?.textContent).toContain('line one');
  });

  it('renders unordered and ordered lists', () => {
    const ul = renderMessage('- one\n- two');
    expect(ul.querySelectorAll('ul li')).toHaveLength(2);
    const ol = renderMessage('1. first\n2. second');
    expect(ol.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('renders blockquotes', () => {
    const c = renderMessage('> quoted line');
    expect(c.querySelector('blockquote')?.textContent).toContain('quoted line');
  });

  it('renders http(s) links with safe target/rel', () => {
    const c = renderMessage('see [site](https://example.com)');
    const a = c.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.textContent).toBe('site');
  });
});

describe('MessageMarkdown — hard breaks', () => {
  it('turns a single newline into a <br> (remark-breaks)', () => {
    const c = renderMessage('line one\nline two');
    expect(c.querySelector('br')).not.toBeNull();
    expect(c.textContent).toContain('line one');
    expect(c.textContent).toContain('line two');
  });
});

describe('MessageMarkdown — raw HTML is neutralized', () => {
  it('never renders a <script> element', () => {
    const c = renderMessage('hello <script>alert(1)</script> world');
    expect(c.querySelector('script')).toBeNull();
    expect(c.textContent).toContain('hello');
    expect(c.textContent).toContain('world');
  });

  it('never renders an <img> from raw HTML (onerror payload)', () => {
    const c = renderMessage('<img src=x onerror="alert(1)">');
    expect(c.querySelector('img')).toBeNull();
  });

  it('renders inline HTML tags as inert literal text, not elements', () => {
    const c = renderMessage('a <b>bold</b> c');
    // No live element is created; the tags survive only as escaped text.
    expect(c.querySelector('b')).toBeNull();
    expect(c.textContent).toContain('<b>bold</b>');
  });
});

describe('MessageMarkdown — link safety', () => {
  it('renders a javascript: link as plain text (no anchor)', () => {
    const c = renderMessage('[click](javascript:void)');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('click');
  });

  it('renders a data: link as plain text (no anchor)', () => {
    const c = renderMessage('[x](data:text/html,<script>alert(1)</script>)');
    expect(c.querySelector('a')).toBeNull();
    expect(c.querySelector('script')).toBeNull();
  });

  it('isSafeHref only accepts http/https/mailto', () => {
    expect(isSafeHref('https://a.com')).toBe(true);
    expect(isSafeHref('http://a.com')).toBe(true);
    expect(isSafeHref('mailto:a@b.com')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,x')).toBe(false);
    expect(isSafeHref('/relative/path')).toBe(false);
  });
});

describe('MessageMarkdown — images never produce <img>', () => {
  it('renders markdown image alt text instead of an <img>', () => {
    const c = renderMessage('![alt words](https://example.com/pic.png)');
    expect(c.querySelector('img')).toBeNull();
    expect(c.textContent).toContain('alt words');
  });

  it('falls back to the url when there is no alt text', () => {
    const c = renderMessage('![](https://example.com/pic.png)');
    expect(c.querySelector('img')).toBeNull();
    expect(c.textContent).toContain('https://example.com/pic.png');
  });
});

describe('MessageMarkdown — @mention parity', () => {
  it('styles a mention in your own (blue) bubble with white underline', () => {
    const c = renderMessage('@Alice hi', { mentions: [alice.id], isMine: true });
    const span = c.querySelector('span');
    expect(span?.textContent).toBe('@Alice');
    const cls = span?.getAttribute('class') ?? '';
    expect(cls).toContain('font-semibold');
    expect(cls).toContain('underline');
    expect(cls).toContain('decoration-white/60');
    expect(cls).not.toContain('text-[#0084ff]');
  });

  it("styles a mention of someone else in another's bubble with the app blue", () => {
    const c = renderMessage('@Alice hi', { mentions: [alice.id], isMine: false, meId: me.id });
    const span = c.querySelector('span');
    expect(span?.textContent).toBe('@Alice');
    const cls = span?.getAttribute('class') ?? '';
    expect(cls).toContain('font-semibold');
    expect(cls).toContain('text-[#0084ff]');
    expect(cls).not.toContain('bg-[#0084ff]/10');
  });

  it('adds the highlight when the mention is of me in another bubble', () => {
    const c = renderMessage('@Me hey', {
      members: [me, alice],
      mentions: [me.id],
      isMine: false,
      meId: me.id,
    });
    const span = c.querySelector('span');
    expect(span?.textContent).toBe('@Me');
    const cls = span?.getAttribute('class') ?? '';
    expect(cls).toContain('bg-[#0084ff]/10');
    expect(cls).toContain('rounded');
    expect(cls).toContain('px-0.5');
  });

  it('leaves a mention inside inline code literal and unstyled', () => {
    const c = renderMessage('`@Alice`', { mentions: [alice.id] });
    expect(c.querySelector('code')?.textContent).toBe('@Alice');
    // no mention span was created inside the code
    expect(c.querySelector('span')).toBeNull();
  });

  it('leaves a mention inside a code block literal and unstyled', () => {
    const c = renderMessage('```\n@Alice\n```', { mentions: [alice.id] });
    expect(c.querySelector('pre')?.textContent).toContain('@Alice');
    expect(c.querySelector('span')).toBeNull();
  });

  it('defaultMentionClassName reproduces the three style cases', () => {
    expect(defaultMentionClassName(true, false)).toBe('font-semibold underline decoration-white/60');
    expect(defaultMentionClassName(false, false)).toBe('font-semibold text-[#0084ff]');
    expect(defaultMentionClassName(false, true)).toBe(
      'font-semibold text-[#0084ff] bg-[#0084ff]/10 rounded px-0.5',
    );
  });
});

describe('MessageMarkdown — plain text', () => {
  it('renders plain text without any surprise structure', () => {
    const c = renderMessage('just plain text no formatting');
    expect(c.querySelector('p')?.textContent).toBe('just plain text no formatting');
    expect(c.querySelector('strong')).toBeNull();
    expect(c.querySelector('em')).toBeNull();
    expect(c.querySelector('code')).toBeNull();
    expect(c.querySelector('span')).toBeNull();
    expect(c.querySelector('a')).toBeNull();
  });
});

describe('MessageMarkdown — configurable extension point', () => {
  it('a config that disallows links renders them as plain text', () => {
    const noLinks = {
      ...defaultMessageConfig,
      allowedElements: defaultMessageConfig.allowedElements.filter((e) => e !== 'a'),
    };
    const c = renderMessage('see [site](https://example.com)', { config: noLinks });
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('site');
  });

  it('still styles mentions under a custom (link-free) config', () => {
    const noLinks = {
      ...defaultMessageConfig,
      allowedElements: defaultMessageConfig.allowedElements.filter((e) => e !== 'a'),
    };
    const c = renderMessage('@Alice hi', { mentions: [alice.id], isMine: true, config: noLinks });
    expect(c.querySelector('span')?.getAttribute('class')).toContain('font-semibold');
  });
});
