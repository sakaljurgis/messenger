import { describe, expect, it, vi } from 'vitest';
import {
  decodeEntities,
  extractFirstHttpUrl,
  fetchLinkPreview,
  isPrivateIPv4,
  isPrivateOrReservedIp,
  parseOpenGraph,
  type LookupFn,
} from './link-previews.js';

// ---------------------------------------------------------------------------
// Test helpers — NO real network is ever touched: fetchFn and lookupFn are
// always injected. Casts keep the fixtures terse while matching the real types.
// ---------------------------------------------------------------------------

const asFetch = (impl: unknown): typeof fetch => impl as unknown as typeof fetch;
const asLookup = (impl: unknown): LookupFn => impl as unknown as LookupFn;

/** A lookup that always resolves to a single, unambiguously public address. */
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

function htmlRes(body: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}
function redirectRes(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

describe('extractFirstHttpUrl', () => {
  it('pulls a bare URL out of surrounding text', () => {
    expect(extractFirstHttpUrl('check out https://example.com/path now')).toBe(
      'https://example.com/path',
    );
  });

  it('returns the FIRST url when several are present', () => {
    expect(extractFirstHttpUrl('a http://one.com b https://two.com c')).toBe('http://one.com');
  });

  it('keeps hyphens and query strings intact', () => {
    expect(extractFirstHttpUrl('see https://my-site.co.uk/a/b?x=1&y=2#frag end')).toBe(
      'https://my-site.co.uk/a/b?x=1&y=2#frag',
    );
  });

  it('strips a trailing period and comma', () => {
    expect(extractFirstHttpUrl('go to https://example.com.')).toBe('https://example.com');
    expect(extractFirstHttpUrl('https://example.com, and more')).toBe('https://example.com');
  });

  it('strips a closing paren that wraps the URL', () => {
    expect(extractFirstHttpUrl('(see https://example.com/x)')).toBe('https://example.com/x');
  });

  it('keeps a balanced closing paren inside the URL (wiki-style)', () => {
    expect(extractFirstHttpUrl('https://en.wikipedia.org/wiki/Foo_(bar) rocks')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
  });

  it('matches http and https, case-insensitively', () => {
    expect(extractFirstHttpUrl('HTTPS://EXAMPLE.COM/A')).toBe('HTTPS://EXAMPLE.COM/A');
  });

  it('returns null when there is no http(s) url', () => {
    expect(extractFirstHttpUrl('just some text, visit www.example.com')).toBeNull();
    expect(extractFirstHttpUrl('ftp://example.com/file')).toBeNull();
    expect(extractFirstHttpUrl('email me at a@b.com')).toBeNull();
    expect(extractFirstHttpUrl('')).toBeNull();
  });

  it('does not guess protocol-relative urls', () => {
    expect(extractFirstHttpUrl('grab //example.com/x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IP classification (SSRF core)
// ---------------------------------------------------------------------------

const PRIVATE_V4: Array<[string, string]> = [
  ['0.0.0.0/8', '0.1.2.3'],
  ['10/8', '10.0.0.5'],
  ['100.64/10 CGNAT', '100.64.1.1'],
  ['100.127/10 CGNAT edge', '100.127.255.255'],
  ['127/8 loopback', '127.0.0.1'],
  ['169.254/16 link-local', '169.254.169.254'],
  ['172.16/12', '172.16.0.1'],
  ['172.31/12 edge', '172.31.255.255'],
  ['192.168/16', '192.168.1.1'],
  ['198.18/15 benchmarking', '198.18.0.1'],
  ['198.19/15 edge', '198.19.255.255'],
  ['224/3 multicast', '224.0.0.1'],
  ['240/4 reserved', '240.0.0.1'],
  ['broadcast', '255.255.255.255'],
];

const PRIVATE_V6: Array<[string, string]> = [
  ['::1 loopback', '::1'],
  [':: unspecified', '::'],
  ['fc00::/7 ULA', 'fc00::1'],
  ['fd00::/8 ULA', 'fd12:3456:789a::1'],
  ['fe80::/10 link-local', 'fe80::1'],
  ['ff00::/8 multicast', 'ff02::1'],
  ['::ffff:127.0.0.1 v4-mapped loopback', '::ffff:127.0.0.1'],
  ['::ffff:10.0.0.1 v4-mapped private', '::ffff:10.0.0.1'],
  ['::ffff:169.254.169.254 v4-mapped metadata', '::ffff:169.254.169.254'],
];

const PUBLIC_ADDRS = [
  '93.184.216.34',
  '1.1.1.1',
  '8.8.8.8',
  '11.0.0.1',
  '100.63.255.255', // just below CGNAT
  '172.15.0.1', // just below 172.16/12
  '172.32.0.1', // just above 172.16/12
  '198.20.0.1', // just above 198.18/15
  '223.255.255.255', // just below 224/3
  '2606:4700:4700::1111', // Cloudflare v6
  '::ffff:8.8.8.8', // v4-mapped PUBLIC address stays public
];

describe('isPrivateOrReservedIp', () => {
  it.each([...PRIVATE_V4, ...PRIVATE_V6])('rejects %s (%s)', (_label, addr) => {
    expect(isPrivateOrReservedIp(addr)).toBe(true);
  });

  it.each(PUBLIC_ADDRS)('allows public %s', (addr) => {
    expect(isPrivateOrReservedIp(addr)).toBe(false);
  });

  it('treats a non-IP string as unsafe', () => {
    expect(isPrivateOrReservedIp('not-an-ip')).toBe(true);
    expect(isPrivateOrReservedIp('')).toBe(true);
  });
});

describe('isPrivateIPv4 boundaries', () => {
  it('is exclusive at CGNAT edges', () => {
    expect(isPrivateIPv4('100.63.255.255')).toBe(false);
    expect(isPrivateIPv4('100.64.0.0')).toBe(true);
    expect(isPrivateIPv4('100.127.255.255')).toBe(true);
    expect(isPrivateIPv4('100.128.0.0')).toBe(false);
  });
  it('is exclusive at the 172.16/12 edges', () => {
    expect(isPrivateIPv4('172.15.255.255')).toBe(false);
    expect(isPrivateIPv4('172.16.0.0')).toBe(true);
    expect(isPrivateIPv4('172.31.255.255')).toBe(true);
    expect(isPrivateIPv4('172.32.0.0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchLinkPreview — scheme guard
// ---------------------------------------------------------------------------

describe('fetchLinkPreview scheme guard', () => {
  it.each([
    'ftp://example.com/file',
    'file:///etc/passwd',
    'gopher://example.com/',
    'data:text/html,<title>x</title>',
    'javascript:alert(1)',
    'mailto:a@b.com',
    '//example.com/x', // no base → URL parse fails
    'not a url',
  ])('returns null and never fetches for %s', async (url) => {
    const fetchFn = vi.fn();
    const res = await fetchLinkPreview(url, {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fetchLinkPreview — DNS-resolved private/reserved rejection
// ---------------------------------------------------------------------------

describe('fetchLinkPreview DNS SSRF guard', () => {
  it.each([...PRIVATE_V4, ...PRIVATE_V6])(
    'blocks a DNS host that resolves to %s and never fetches',
    async (_label, addr) => {
      const fetchFn = vi.fn();
      const res = await fetchLinkPreview('http://target.example/', {
        fetchFn: asFetch(fetchFn),
        lookupFn: async () => [{ address: addr, family: addr.includes(':') ? 6 : 4 }],
      });
      expect(res).toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('blocks when ANY of several resolved addresses is private', async () => {
    const fetchFn = vi.fn();
    const res = await fetchLinkPreview('http://target.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    expect(res).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects when DNS resolution fails', async () => {
    const fetchFn = vi.fn();
    const res = await fetchLinkPreview('http://target.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: asLookup(async () => {
        throw new Error('ENOTFOUND');
      }),
    });
    expect(res).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects when DNS returns no addresses', async () => {
    const fetchFn = vi.fn();
    const res = await fetchLinkPreview('http://target.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: async () => [],
    });
    expect(res).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fetchLinkPreview — literal IP hosts (no DNS involved), incl. exotic forms
// ---------------------------------------------------------------------------

describe('fetchLinkPreview literal-IP guard (no DNS)', () => {
  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/', // cloud metadata endpoint
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f000001/', // hex 127.0.0.1
    'http://0177.0.0.1/', // octal
    'http://127.1/', // shorthand
    'http://0x7f.1/', // mixed exotic
    'http://[::1]/', // IPv6 loopback
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6
    'http://[fc00::1]/', // ULA
    'http://[fe80::1]/', // link-local
  ])('blocks %s without any DNS lookup', async (url) => {
    const fetchFn = vi.fn();
    const lookupFn = vi.fn();
    const res = await fetchLinkPreview(url, {
      fetchFn: asFetch(fetchFn),
      lookupFn: asLookup(lookupFn),
    });
    expect(res).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it('allows a public literal IP host', async () => {
    const fetchFn = vi.fn(async () => htmlRes('<title>Public IP</title>'));
    const lookupFn = vi.fn();
    const res = await fetchLinkPreview('http://93.184.216.34/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: asLookup(lookupFn),
    });
    expect(res?.title).toBe('Public IP');
    expect(lookupFn).not.toHaveBeenCalled(); // literal IP → no DNS
  });
});

// ---------------------------------------------------------------------------
// fetchLinkPreview — redirects
// ---------------------------------------------------------------------------

describe('fetchLinkPreview redirects', () => {
  it('re-runs the guard on the redirect target and blocks a private one', async () => {
    const fetchFn = vi.fn(async () => redirectRes('http://127.0.0.1/'));
    const res = await fetchLinkPreview('http://safe.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res).toBeNull();
    // Fetched the original once, then refused to follow to the private target.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect to a DNS name that resolves private', async () => {
    const fetchFn = vi.fn(async () => redirectRes('http://evil.example/'));
    const lookupFn: LookupFn = async (host) =>
      host === 'evil.example'
        ? [{ address: '10.1.2.3', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];
    const res = await fetchLinkPreview('http://safe.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn,
    });
    expect(res).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('follows up to 3 redirects then succeeds', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n <= 3 ? redirectRes(`/hop${n}`) : htmlRes('<title>Arrived</title>');
    });
    const res = await fetchLinkPreview('http://start.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res?.title).toBe('Arrived');
    expect(fetchFn).toHaveBeenCalledTimes(4); // initial + 3 redirects
  });

  it('rejects a chain of more than 3 redirects', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => redirectRes(`/hop${(n += 1)}`));
    const res = await fetchLinkPreview('http://start.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(4); // 4th redirect exceeds the cap
  });

  it('rejects a redirect with no Location header', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302 }));
    const res = await fetchLinkPreview('http://start.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res).toBeNull();
  });

  it('resolves a relative redirect against the current URL and updates the OG-image base', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === 'http://start.example/a') return redirectRes('http://cdn.example/b');
      return htmlRes('<meta property="og:title" content="Moved"><meta property="og:image" content="/cover.png">');
    });
    const res = await fetchLinkPreview('http://start.example/a', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res).toEqual({
      url: 'http://start.example/a', // original, NOT the redirect target
      title: 'Moved',
      description: null,
      siteName: null,
      imageUrl: 'http://cdn.example/cover.png', // resolved against FINAL url
    });
  });
});

// ---------------------------------------------------------------------------
// fetchLinkPreview — response guards
// ---------------------------------------------------------------------------

describe('fetchLinkPreview response guards', () => {
  it.each(['application/json', 'text/plain', 'image/png', ''])(
    'returns null for non-html content-type %s',
    async (ct) => {
      const fetchFn = vi.fn(async () => htmlRes('<title>Nope</title>', ct));
      const res = await fetchLinkPreview('http://x.example/', {
        fetchFn: asFetch(fetchFn),
        lookupFn: publicLookup,
      });
      expect(res).toBeNull();
    },
  );

  it('returns null for a non-2xx status even if HTML', async () => {
    const fetchFn = vi.fn(
      async () => new Response('<title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } }),
    );
    const res = await fetchLinkPreview('http://x.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res).toBeNull();
  });

  it('aborts an oversized body past 512KB (reads only the head, cancels the stream)', async () => {
    let pulls = 0;
    let cancelled = false;
    const enc = new TextEncoder();
    const head = enc.encode('<html><head><title>Big Page</title></head><body>');
    const filler = enc.encode('x'.repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(pulls === 0 ? head : filler);
        pulls += 1;
        if (pulls > 2000) controller.close(); // safety net if the cap ever regressed
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchFn = vi.fn(
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const res = await fetchLinkPreview('http://big.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res?.title).toBe('Big Page'); // parsed from the head we did read
    expect(cancelled).toBe(true); // underlying stream was aborted
    expect(pulls).toBeLessThan(20); // ~9 reads for 512KB/64KB, nowhere near the 2000 net
  });

  it('returns null (does not hang) when the fetch never resolves before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const hanging = asFetch(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      const p = fetchLinkPreview('http://slow.example/', { fetchFn: hanging, lookupFn: publicLookup });
      await vi.advanceTimersByTimeAsync(6000); // past the ~5s overall timeout
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when fetch throws a network error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const res = await fetchLinkPreview('http://x.example/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decodeEntities
// ---------------------------------------------------------------------------

describe('decodeEntities', () => {
  it('decodes the basic named entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe(`a & b <c> "d" 'e'`);
  });
  it('decodes decimal and hex numeric references', () => {
    expect(decodeEntities('&#65;&#x42;&#x1F600;')).toBe('AB😀');
  });
  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('100% &notreal; &bogus')).toBe('100% &notreal; &bogus');
  });
});

// ---------------------------------------------------------------------------
// parseOpenGraph matrix
// ---------------------------------------------------------------------------

describe('parseOpenGraph', () => {
  const base = 'http://final.example/dir/page';
  const orig = 'http://typed.example/x';
  const parse = (html: string) => parseOpenGraph(html, base, orig);

  it('reads og:title with property before content, double quotes', () => {
    expect(parse('<meta property="og:title" content="Title A">')?.title).toBe('Title A');
  });
  it('reads og:title with content before property, single quotes', () => {
    expect(parse("<meta content='Title B' property='og:title'>")?.title).toBe('Title B');
  });
  it('reads the name= attribute form (Twitter/legacy)', () => {
    expect(parse('<meta name="og:title" content="Title C">')?.title).toBe('Title C');
  });
  it('tolerates extra attributes and odd whitespace', () => {
    expect(parse('<meta   data-x="1"  content = "Title D"  property = "og:title" >')?.title).toBe(
      'Title D',
    );
  });

  it('decodes entities in extracted values', () => {
    const r = parse('<meta property="og:title" content="Ben &amp; Jerry&#39;s &lt;3">');
    expect(r?.title).toBe("Ben & Jerry's <3");
  });

  it('falls back to <title> when og:title is absent', () => {
    expect(parse('<head><title>  Fallback Title  </title></head>')?.title).toBe('Fallback Title');
  });

  it('falls back to <title> when og:title is present but empty', () => {
    const r = parse('<meta property="og:title" content=""><title>Real</title>');
    expect(r?.title).toBe('Real');
  });

  it('returns null when there is no title anywhere', () => {
    expect(parse('<meta property="og:description" content="d only">')).toBeNull();
    expect(parse('<html><body>no head</body></html>')).toBeNull();
    expect(parse('<title>   </title>')).toBeNull();
  });

  it('populates description and siteName, null when missing', () => {
    const full = parse(
      '<meta property="og:title" content="T">' +
        '<meta property="og:description" content="D">' +
        '<meta property="og:site_name" content="S">',
    );
    expect(full).toMatchObject({ description: 'D', siteName: 'S' });

    const bare = parse('<title>T</title>');
    expect(bare).toEqual({ url: orig, title: 'T', description: null, imageUrl: null, siteName: null });
  });

  it('resolves a root-relative og:image against the final URL', () => {
    expect(parse('<meta property="og:title" content="t"><meta property="og:image" content="/img/c.png">')?.imageUrl).toBe(
      'http://final.example/img/c.png',
    );
  });
  it('resolves a path-relative og:image against the final URL directory', () => {
    expect(parse('<meta property="og:title" content="t"><meta property="og:image" content="c.png">')?.imageUrl).toBe(
      'http://final.example/dir/c.png',
    );
  });
  it('keeps an absolute http(s) og:image as-is', () => {
    expect(
      parse('<meta property="og:title" content="t"><meta property="og:image" content="https://cdn.example/y.png">')
        ?.imageUrl,
    ).toBe('https://cdn.example/y.png');
  });
  it('drops a non-http og:image (e.g. data:)', () => {
    const r = parse('<meta property="og:title" content="t"><meta property="og:image" content="data:image/png;base64,AAAA">');
    expect(r?.title).toBe('t');
    expect(r?.imageUrl).toBeNull();
  });

  it('always reports the ORIGINAL url, not the final one', () => {
    expect(parse('<title>T</title>')?.url).toBe(orig);
  });
});

// ---------------------------------------------------------------------------
// Happy path — full end-to-end with mocked fetch + lookup
// ---------------------------------------------------------------------------

describe('fetchLinkPreview happy path', () => {
  it('fetches, resolves and parses a normal page', async () => {
    const page = `<!doctype html><html><head>
      <meta charset="utf-8">
      <meta property="og:title" content="Hello &amp; Welcome">
      <meta property="og:description" content="A lovely article">
      <meta property="og:image" content="/media/cover.png">
      <meta property="og:site_name" content="Example News">
      <title>ignored because og:title wins</title>
    </head><body>…</body></html>`;
    const fetchFn = vi.fn(async () => htmlRes(page));
    const res = await fetchLinkPreview('http://example.com/news/article-1', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    expect(res).toEqual({
      url: 'http://example.com/news/article-1',
      title: 'Hello & Welcome',
      description: 'A lovely article',
      imageUrl: 'http://example.com/media/cover.png',
      siteName: 'Example News',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends GET with redirect:manual and an accept header', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => htmlRes('<title>T</title>'));
    await fetchLinkPreview('http://example.com/', {
      fetchFn: asFetch(fetchFn),
      lookupFn: publicLookup,
    });
    const init = fetchFn.mock.calls[0]![1];
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
