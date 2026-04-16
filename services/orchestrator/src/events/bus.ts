import type { EventEnvelope } from "@superman/shared-types";

type Subscriber = {
  id: string;
  write: (payload: string) => void;
};

export class EventBus {
  private subscribers = new Map<string, Subscriber>();

  subscribe(write: (payload: string) => void) {
    const id = crypto.randomUUID();
    this.subscribers.set(id, { id, write });
    return () => {
      this.subscribers.delete(id);
    };
  }

  broadcast<TPayload>(type: string, payload: TPayload) {
    const envelope: EventEnvelope<TPayload> = { type, payload };
    const message = `event: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const subscriber of this.subscribers.values()) {
      subscriber.write(message);
    }
  }
}
