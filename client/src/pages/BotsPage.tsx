import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BotDTO, UserDTO } from '@messenger/shared';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import Avatar from '../components/Avatar';

/**
 * Bot management screen (/bots): list every bot, edit or clear each one's
 * outbound webhook URL, and create new bots. The apiToken minted at creation is
 * shown exactly once (the server never re-exposes it), with a copy button and a
 * warning. Navigated to from Settings; a back link returns there.
 */
export default function BotsPage() {
  const [bots, setBots] = useState<BotDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const res = await apiGet<{ bots: BotDTO[] }>('/api/bots');
      setBots(res.bots);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bots');
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiGet<{ bots: BotDTO[] }>('/api/bots')
      .then((res) => {
        if (!cancelled) setBots(res.bots);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load bots');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="p-4">
      <Link to="/settings" className="mb-3 inline-block text-sm font-medium text-[#0084ff]">
        ‹ Settings
      </Link>
      <h1 className="mb-4 text-xl font-bold text-gray-900">Bots</h1>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <CreateBotSection onCreated={reload} />

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Your bots
        </h2>
        {bots === null ? (
          <div className="flex justify-center py-10" role="status" aria-label="Loading bots">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-[#0084ff]" />
          </div>
        ) : bots.length === 0 ? (
          <p className="py-8 text-center text-gray-500">No bots yet</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {bots.map((bot) => (
              <BotRow key={bot.id} bot={bot} onSaved={reload} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One bot: name + current webhook, with an inline editor to change or clear it. */
function BotRow({ bot, onSaved }: { bot: BotDTO; onSaved: () => void }) {
  const [value, setValue] = useState(bot.webhookUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the field in sync if the list is reloaded with a new URL for this bot.
  useEffect(() => {
    setValue(bot.webhookUrl ?? '');
  }, [bot.webhookUrl]);

  const dirty = value.trim() !== (bot.webhookUrl ?? '');

  async function save(nextValue: string) {
    setBusy(true);
    setError(null);
    try {
      // Empty string clears the webhook (server normalizes '' -> null).
      await apiPatch<{ bot: BotDTO }>(`/api/bots/${bot.id}`, {
        webhookUrl: nextValue.trim() === '' ? null : nextValue.trim(),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save webhook');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl bg-gray-50 p-3">
      <div className="mb-2 flex items-center gap-3">
        <Avatar name={bot.displayName} id={bot.id} size="sm" />
        <div className="min-w-0">
          <p className="truncate font-medium text-gray-900">{bot.displayName}</p>
          <p className="truncate text-xs text-gray-500">{bot.webhookUrl ?? 'No webhook'}</p>
        </div>
      </div>

      <label className="sr-only" htmlFor={`webhook-${bot.id}`}>
        Webhook URL for {bot.displayName}
      </label>
      <input
        id={`webhook-${bot.id}`}
        type="url"
        inputMode="url"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="https://example.com/webhook"
        className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => save(value)}
          disabled={busy || !dirty}
          className="rounded-full bg-[#0084ff] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {bot.webhookUrl && (
          <button
            type="button"
            onClick={() => {
              setValue('');
              save('');
            }}
            disabled={busy}
            className="rounded-full bg-gray-200 px-4 py-1.5 text-sm font-semibold text-gray-700 disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </li>
  );
}

/** Create-bot form + the one-time apiToken reveal shown after a successful create. */
function CreateBotSection({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<{ name: string; apiToken: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: { name: string; webhookUrl?: string } = { name: name.trim() };
      if (webhookUrl.trim() !== '') body.webhookUrl = webhookUrl.trim();
      const res = await apiPost<{ bot: UserDTO; apiToken: string }>('/api/bots', body);
      setToken({ name: res.bot.displayName, apiToken: res.apiToken });
      setName('');
      setWebhookUrl('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create bot');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Create a bot
      </h2>

      {token && <TokenReveal name={token.name} apiToken={token.apiToken} onDismiss={() => setToken(null)} />}

      <form onSubmit={submit} className="rounded-xl bg-gray-50 p-4">
        <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="bot-name">
          Display name
        </label>
        <input
          id="bot-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Echo Bot"
          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />

        <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="bot-webhook">
          Webhook URL <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="bot-webhook"
          type="url"
          inputMode="url"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://example.com/webhook"
          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />

        <button
          type="submit"
          disabled={busy || name.trim() === ''}
          className="rounded-full bg-[#0084ff] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create bot'}
        </button>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </form>
    </section>
  );
}

/** One-time reveal of a freshly minted apiToken, with copy-to-clipboard. */
function TokenReveal({
  name,
  apiToken,
  onDismiss,
}: {
  name: string;
  apiToken: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(apiToken);
      setCopied(true);
    } catch {
      // Clipboard may be blocked; the token is still visible to copy manually.
      setCopied(false);
    }
  }

  return (
    <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <p className="mb-1 text-sm font-semibold text-amber-900">API token for {name}</p>
      <p className="mb-2 text-xs text-amber-800">
        Copy this now — it will not be shown again.
      </p>
      <code className="mb-3 block w-full break-all rounded-lg bg-white px-3 py-2 font-mono text-xs text-gray-900">
        {apiToken}
      </code>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={copy}
          className="rounded-full bg-[#0084ff] px-4 py-1.5 text-sm font-semibold text-white"
        >
          {copied ? 'Copied!' : 'Copy token'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-full bg-gray-200 px-4 py-1.5 text-sm font-semibold text-gray-700"
        >
          Done
        </button>
      </div>
    </div>
  );
}
