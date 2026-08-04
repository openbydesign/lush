import type { CodeSession, EventPage } from "@lush/code";

export function applyCodeSessionEventPage(
  current: CodeSession | undefined,
  sessionId: string,
  page: EventPage
) {
  if (!current || current.id !== sessionId) return current;
  if (
    !page.events.length &&
    page.status === current.status &&
    page.error === current.error
  ) {
    return current;
  }
  return {
    ...current,
    status: page.status,
    messages: page.messages,
    events: [...current.events, ...page.events],
    error: page.error
  };
}

export function createCodeSessionPoll(options: {
  initialCursor: number;
  request(cursor: number): Promise<EventPage>;
  update(page: EventPage): void;
  onError(reason: unknown): void;
}) {
  let cursor = options.initialCursor;
  let inFlight = false;
  let stopped = false;

  return {
    async tick() {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const page = await options.request(cursor);
        // Effect cleanup must win even if the same session is selected again.
        if (stopped) return;
        cursor = page.nextCursor;
        options.update(page);
      } catch (reason) {
        if (!stopped) options.onError(reason);
      } finally {
        inFlight = false;
      }
    },
    stop() {
      stopped = true;
    }
  };
}
