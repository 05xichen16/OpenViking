/**
 * Tracks "resume / rebind" links between the live OpenClaw session and a past
 * OpenViking session that the user restored via `/conversations restore`.
 *
 * When a rebind is set for the current session (keyed by its natural
 * ovSessionId), the context engine substitutes the target session id wherever
 * it derives ovSessionId, so that:
 *   - assemble reads the restored session's context every turn (the model sees
 *     the old history continuously), and
 *   - afterTurn writes new turns into the restored session (the conversation
 *     continues as an extension of it).
 *
 * State is in-memory and per gateway process; a restart drops rebinds, which is
 * the intended lifetime (a rebind belongs to a running conversation).
 */
export type SessionRebindStore = {
  /** Bind the current session's ovSessionId to a target (restored) session id. */
  setRebind(currentOvSessionId: string, targetOvSessionId: string): void;
  /** Target session id to read/write for the current session, if rebound. */
  getTarget(currentOvSessionId: string): string | undefined;
  /** Drop the rebind entirely (detach from the restored session). */
  clearRebind(currentOvSessionId: string): void;
};

export function createSessionRebindStore(): SessionRebindStore {
  const targets = new Map<string, string>();
  return {
    setRebind(currentOvSessionId, targetOvSessionId) {
      if (!currentOvSessionId || !targetOvSessionId) {
        return;
      }
      targets.set(currentOvSessionId, targetOvSessionId);
    },
    getTarget(currentOvSessionId) {
      return targets.get(currentOvSessionId);
    },
    clearRebind(currentOvSessionId) {
      targets.delete(currentOvSessionId);
    },
  };
}
