export interface SplitTestConfig {
  publicApiKey: string;
  propertyId: string;
  apiUrl?: string;
  visitorId?: string;
  attributes?: Record<string, string | number | boolean>;
  bootstrap?: Record<string, number>;
  antiFlicker?: boolean;
  staleTTL?: number;
  maxAge?: number;
  onAssignment?: (testKey: string, variation: AssignedVariation) => void;
}

export interface AssignedVariation {
  key: string;
  value: string;
}

export interface SplitTestConfigEntry {
  key: string;
  id: string;
  type: 'id' | 'text' | 'json';
  status: string;
  hashSeed: string;
  trafficAllocation: number;
  variations: Array<{
    key: string;
    weight: number;
    value: string;
  }>;
}

export interface SplitTestConfigResponse {
  tests: SplitTestConfigEntry[];
}

export interface Assignment {
  testKey: string;
  variationIndex: number;
  variationKey: string;
  value: string;
  type: 'id' | 'text' | 'json';
  inTest: boolean;
}

