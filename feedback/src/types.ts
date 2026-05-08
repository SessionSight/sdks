export interface FeedbackConfig {
  secretApiKey: string;
  propertyId: string;
  apiUrl?: string;
}

export interface FeedbackOptions {
  /**
   * Session-scoped feedback attribution. Required on every submit; visitor
   * and user identity are resolved from the session by the backend. Server
   * callers must thread sessionId through from the originating request.
   */
  sessionId?: string;
  option?: string;
  message?: string;
  metadata?: Record<string, string>;
}

export interface FeedbackResult {
  success: boolean;
  error?: string;
}
