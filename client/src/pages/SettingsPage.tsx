import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { disablePush, enablePush, getPushState, type PushState } from '../lib/push';

/** Human-readable status line for the current push state. */
function stateText(state: PushState): string {
  switch (state) {
    case 'enabled':
      return 'Notifications are on for this device.';
    case 'disabled':
      return 'Get notified about new messages even when the app is closed.';
    case 'denied':
      return 'Notifications are blocked in your browser settings. Re-enable them there to turn notifications on.';
    case 'unsupported':
      return "This browser can't show push notifications. On iPhone/iPad, add Messenger to your home screen first, then open it from there.";
  }
}

function NotificationsSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPushState().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const next = state === 'enabled' ? await disablePush() : await enablePush();
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update notifications');
      // Resync in case permission/subscription changed mid-flight.
      setState(await getPushState());
    } finally {
      setBusy(false);
    }
  }

  const canToggle = state === 'enabled' || state === 'disabled';

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Notifications
      </h2>
      <div className="rounded-xl bg-gray-50 p-4">
        {state === null ? (
          <p className="text-sm text-gray-400">Checking notification status…</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-600">{stateText(state)}</p>
            {canToggle && (
              <button
                type="button"
                onClick={toggle}
                disabled={busy}
                className="rounded-full bg-[#0084ff] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy
                  ? 'Working…'
                  : state === 'enabled'
                    ? 'Disable notifications'
                    : 'Enable notifications'}
              </button>
            )}
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          </>
        )}
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="p-4">
      <h1 className="mb-4 text-xl font-bold">Settings</h1>

      <div className="mb-6 rounded-xl bg-gray-50 p-4">
        <p className="font-semibold text-gray-900">{user?.displayName}</p>
        <p className="text-sm text-gray-500">{user?.email}</p>
      </div>

      <NotificationsSection />

      <button
        type="button"
        onClick={handleLogout}
        className="w-full rounded-full bg-red-600 py-2.5 font-semibold text-white"
      >
        Log out
      </button>
    </div>
  );
}
