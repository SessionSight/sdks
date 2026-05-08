export interface FeatureFlagConfig {
  secretApiKey: string;
  propertyId: string;
  environment: string;
  apiUrl?: string;
}

export interface FlagEvaluationContext {
  userId?: string;
  /** Set visitorId to enable segment-based targeting via segment_match rules */
  visitorId?: string;
  /** The active recording session ID (from ss_sid cookie). Forwarded for logging/analytics. */
  sessionId?: string;
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
