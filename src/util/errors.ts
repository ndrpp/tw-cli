/** A thrown value as text: the message of an Error, or the value itself. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
