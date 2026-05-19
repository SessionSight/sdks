import { test, expect, describe } from 'bun:test';
import {
  validateGoalId,
  validateGoalAmount,
  buildGoalPayload,
} from '../src/index.js';

describe('validateGoalId', () => {
  test('accepts non-empty string', () => {
    expect(validateGoalId('purchase')).toBeNull();
  });

  test('rejects empty string', () => {
    expect(validateGoalId('')).toBe('goalId must be a non-empty string');
  });

  test('rejects whitespace-only string', () => {
    expect(validateGoalId('   ')).toBe('goalId must be a non-empty string');
  });

  test('rejects non-string values', () => {
    expect(validateGoalId(null)).toBe('goalId must be a non-empty string');
    expect(validateGoalId(undefined)).toBe('goalId must be a non-empty string');
    expect(validateGoalId(123)).toBe('goalId must be a non-empty string');
    expect(validateGoalId({})).toBe('goalId must be a non-empty string');
  });
});

describe('validateGoalAmount', () => {
  test('accepts positive finite numbers', () => {
    expect(validateGoalAmount(1)).toBeNull();
    expect(validateGoalAmount(0.5)).toBeNull();
    expect(validateGoalAmount(1_000_000)).toBeNull();
  });

  test('rejects zero', () => {
    expect(validateGoalAmount(0)).toBe('amount must be a positive finite number');
  });

  test('rejects negatives', () => {
    expect(validateGoalAmount(-1)).toBe('amount must be a positive finite number');
  });

  test('rejects NaN and Infinity', () => {
    expect(validateGoalAmount(NaN)).toBe('amount must be a positive finite number');
    expect(validateGoalAmount(Infinity)).toBe('amount must be a positive finite number');
    expect(validateGoalAmount(-Infinity)).toBe('amount must be a positive finite number');
  });

  test('rejects non-numeric values (parity with validateGoalId)', () => {
    expect(validateGoalAmount('5' as unknown as number)).toBe('amount must be a positive finite number');
    expect(validateGoalAmount(null as unknown as number)).toBe('amount must be a positive finite number');
    expect(validateGoalAmount(undefined as unknown as number)).toBe('amount must be a positive finite number');
    expect(validateGoalAmount({} as unknown as number)).toBe('amount must be a positive finite number');
    expect(validateGoalAmount([1] as unknown as number)).toBe('amount must be a positive finite number');
    expect(validateGoalAmount(true as unknown as number)).toBe('amount must be a positive finite number');
  });
});

describe('buildGoalPayload', () => {
  test('includes goalId, propertyId, default amount=1', () => {
    const { body } = buildGoalPayload('purchase', 'prop-1');
    expect(body).toEqual({ goalId: 'purchase', propertyId: 'prop-1', amount: 1 });
  });

  test('overrides amount when provided', () => {
    const { body } = buildGoalPayload('purchase', 'prop-1', { amount: 5 });
    expect(body.amount).toBe(5);
  });

  test('includes optional fields only when provided', () => {
    const { body } = buildGoalPayload('purchase', 'prop-1', {
      apiKey: 'pk_123',
      sessionId: 'sid',
      metadata: { foo: 'bar' },
    });
    expect(body).toEqual({
      goalId: 'purchase',
      propertyId: 'prop-1',
      amount: 1,
      apiKey: 'pk_123',
      sessionId: 'sid',
      metadata: { foo: 'bar' },
    });
  });

  test('omits empty optional fields', () => {
    const { body } = buildGoalPayload('purchase', 'prop-1', {});
    expect(body).toEqual({ goalId: 'purchase', propertyId: 'prop-1', amount: 1 });
    expect('apiKey' in body).toBe(false);
    expect('visitorId' in body).toBe(false);
    expect('sessionId' in body).toBe(false);
    expect('metadata' in body).toBe(false);
  });

  test('drops metadata values that contain prohibited PII (SSN, phone, credentials)', () => {
    const { body } = buildGoalPayload('purchase', 'prop-1', {
      metadata: {
        plan: 'pro',
        ssn: '123-45-6789',
        phone: '+1 555 123 4567',
        apiKey: 'sk-ant-abcdefghijklmnopqrstuvwxyz01',
        country: 'US',
      },
    });
    expect(body.metadata).toEqual({ plan: 'pro', country: 'US' });
  });

  test('clean metadata strings pass through unchanged', () => {
    const { body } = buildGoalPayload('purchase', 'prop-1', {
      metadata: { plan: 'pro', orderId: 'ord_12345', status: 'paid' },
    });
    expect(body.metadata).toEqual({ plan: 'pro', orderId: 'ord_12345', status: 'paid' });
  });

  test('email passes through metadata (canonical identifier, matches identify())', () => {
    const { body } = buildGoalPayload('purchase', 'prop-1', {
      metadata: { contact: 'alice@acme.com' },
    });
    expect(body.metadata).toEqual({ contact: 'alice@acme.com' });
  });

  test('omits metadata field entirely when every value was dropped', () => {
    const { body } = buildGoalPayload('purchase', 'prop-1', {
      metadata: { ssn: '123-45-6789', phone: '+1 555 123 4567' },
    });
    expect('metadata' in body).toBe(false);
  });
});
