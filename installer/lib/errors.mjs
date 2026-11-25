/** A failure the customer can act on. Its message is shown as written; nothing else is printed for it. */
export class PackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackError';
  }
}
