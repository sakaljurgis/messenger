// App icon badge (Badging API) — shows the total unread count on the
// installed PWA's home-screen/taskbar icon. Support is spotty (no Firefox, no
// iOS Safari as of writing), and even where present the returned promise can
// reject for platform reasons outside our control, so every call here is
// best-effort: feature-detected up front and any rejection is swallowed. A
// badge failure must never surface to the user or throw from a render effect.

/** Set the app badge to `count`; a non-positive count clears it instead. */
export function setAppBadge(count: number): void {
  if (!('setAppBadge' in navigator)) return;
  if (count <= 0) {
    clearAppBadge();
    return;
  }
  navigator.setAppBadge(count).catch(() => {
    // Ignore — badging is a best-effort visual affordance.
  });
}

/** Clear the app badge. */
export function clearAppBadge(): void {
  if (!('setAppBadge' in navigator)) return;
  navigator.clearAppBadge().catch(() => {
    // Ignore — badging is a best-effort visual affordance.
  });
}
