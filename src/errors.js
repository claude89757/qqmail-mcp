/** An error whose message is safe to return to the MCP client. */
export class MailError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "MailError";
  }
}
