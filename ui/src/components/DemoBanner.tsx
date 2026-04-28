import type { IdleReason } from '../hooks/useAuctionFeed';

/**
 * Top-of-page strip shown when the server has paused the demo. Covers three
 * states from the long-dwell protection layer:
 *
 *   session-cap  (per-session 100-auction limit)        → "refresh to resume"
 *   budget       (requester wallet below floor)         → "wallet refilling"
 *   settle-error (3+ consecutive settle failures)       → "settlement issue, retrying"
 */
export function DemoBanner({ reason }: { reason: IdleReason }) {
  if (!reason) return null;
  const text =
    reason === 'session-cap'
      ? 'Demo paused — refresh to resume.'
      : reason === 'budget'
        ? 'Demo paused — wallet refilling.'
        : reason === 'settle-error'
          ? 'Demo paused — settlement issue, retrying shortly.'
          : 'Demo paused — bidder issue, retrying shortly.';
  const tone =
    reason === 'session-cap'
      ? 'border-amber-400 text-amber-200 bg-amber-500/10'
      : reason === 'budget'
        ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10'
        : reason === 'settle-error'
          ? 'border-rose-400 text-rose-200 bg-rose-500/10'
          : 'border-orange-400 text-orange-200 bg-orange-500/10';
  return (
    <div
      className={`px-4 py-2 text-center text-xs tracking-wide border-b-2 ${tone}`}
      role="status"
    >
      {text}
    </div>
  );
}
