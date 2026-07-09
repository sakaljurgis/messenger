import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { UserDTO } from '@messenger/shared';
import { apiPatch, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { disablePush, enablePush, getPushState, type PushState } from '../lib/push';

const inputClass =
  'w-full rounded-full border border-gray-300 px-4 py-2 text-gray-900 focus:border-[#0084ff] focus:outline-none';
const saveButtonClass =
  'rounded-full bg-[#0084ff] px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-40';

/** Editable profile: display name (email is fixed — it's the login). */
function ProfileSection() {
  const { user, updateUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync the field to the loaded/saved profile (it only changes on load or save,
  // never mid-edit, so this can't clobber typing).
  useEffect(() => {
    setDisplayName(user?.displayName ?? '');
  }, [user?.displayName]);

  const trimmed = displayName.trim();
  const canSave = trimmed.length > 0 && trimmed !== user?.displayName && !busy;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiPatch<{ user: UserDTO }>('/api/users/me', { displayName: trimmed });
      updateUser(res.user);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update profile');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Profile</h2>
      <form onSubmit={save} className="space-y-3 rounded-xl bg-gray-50 p-4">
        <div>
          <label htmlFor="display-name" className="mb-1 block text-sm font-medium text-gray-700">
            Display name
          </label>
          <input
            id="display-name"
            type="text"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setSaved(false);
            }}
            className={inputClass}
          />
        </div>
        <p className="text-sm text-gray-500">{user?.email}</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {saved && <p className="text-sm text-green-600">Name updated</p>}
        <button type="submit" disabled={!canSave} className={saveButtonClass}>
          {busy ? 'Saving…' : 'Save name'}
        </button>
      </form>
    </section>
  );
}

/** Change password: verifies the current one server-side. */
function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = currentPassword.length > 0 && newPassword.length >= 8 && !busy;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await apiPut<void>('/api/users/me/password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Password</h2>
      <form onSubmit={save} className="space-y-3 rounded-xl bg-gray-50 p-4">
        <div>
          <label htmlFor="current-password" className="mb-1 block text-sm font-medium text-gray-700">
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="new-password" className="mb-1 block text-sm font-medium text-gray-700">
            New password
          </label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-gray-400">At least 8 characters.</p>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {saved && <p className="text-sm text-green-600">Password changed</p>}
        <button type="submit" disabled={!canSave} className={saveButtonClass}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}

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
  const { logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="p-4">
      <h1 className="mb-4 text-xl font-bold">Settings</h1>

      <ProfileSection />

      <PasswordSection />

      <NotificationsSection />

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Bots</h2>
        <Link
          to="/bots"
          className="block rounded-xl bg-gray-50 p-4 transition-colors hover:bg-gray-100"
        >
          <p className="font-semibold text-gray-900">Manage bots</p>
          <p className="text-sm text-gray-500">Create bots and edit their webhooks.</p>
        </Link>
      </section>

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
