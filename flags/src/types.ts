/**
 * Optional logger interface. The SDK warns on transport failures and
 * misuse (init-not-called, etc.). Hosts that route logs through their own
 * structured logger can supply a sink here; defaults to `console`.
 */
export interface FlagLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface FeatureFlagConfig {
  secretApiKey: string;
  propertyId: string;
  environment: string;
  apiUrl?: string;
  /** Override the default fetch timeout (10_000ms). */
  timeoutMs?: number;
  /** Sink for SDK warnings. Defaults to `console`. */
  logger?: FlagLogger;
}

export interface FlagEvaluationContext {
  userId?: string;
  /**
   * Email is a documented hash seed for percentage rollouts. Precedence
   * for the rollout hash is: `userId > email > visitorId`. Set this when
   * a user is logged-out-but-known (newsletter, magic-link flow) so
   * rollouts stay stable across sessions.
   */
  email?: string;
  /** Set visitorId to enable segment-based targeting via segment_match rules */
  visitorId?: string;
  /** The active recording session ID (from ss_sid cookie). Forwarded for logging/analytics. */
  sessionId?: string;
  // Index signature exists to allow custom segment attributes (e.g. plan,
  // country). Loosens the type contract; that's intentional.
  [key: string]: string | number | boolean | undefined;
}

export interface EvaluatedFlag {
  value: string | boolean;
  type: 'boolean' | 'string';
}

export interface EvaluatedFlags {
  [flagKey: string]: EvaluatedFlag;
}

export interface FlagDefinition {
  id: string;
  key: string;
  name: string;
  description?: string;
  type: 'boolean' | 'string';
  defaultValue: string | boolean;
  createdAt: number;
}

export interface FlagListResult {
  flags: FlagDefinition[];
}
