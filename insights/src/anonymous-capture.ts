/**
 * AnonymousCapture: counterpart to Recorder for the anonymous tier.
 *
 * Lives in a parallel module instead of inside Recorder because almost none
 * of Recorder's machinery (rrweb mutation stream, snapshot capture, scroll
 * context, click descriptors, identify, replay-grade form-content masking)
 * is relevant here. A small parallel module is meaningfully smaller in the
 * bundle a declined visitor downloads and removes the risk of leaking
 * full-tier-only signals into anonymous payloads through inattention.
 *
 * What this module captures, and ONLY this:
 *  - pageview boundaries (first paint + pushState/replaceState/popstate)
 *  - goal_count rebroadcasts (no $ amount; anonymous tier cannot attribute)
 *  - aggregate_click (path + quantised xy bucket + deviceClass; no descriptor)
 *  - experience_tick (engaged / bounced / frustrated, one-shot per page)
 *  - form events (form_start, field_focus, field_blur, form_field_retry,
 *    form_submit, form_abandonment) — structural data only
 *  - error events (already PII-sanitized at the SDK)
 *
 * Storage touched by this module: zero. The propertyId-keyed privacy-config
 * cache in sessionStorage is read but managed by index.ts, not here.
 */

import {
  stripUrlQuery,
  redactString,
  classifyDevice,
  externalReferrerHost,
  sanitizeErrorText,
  globToRegex,
  matchesAnyPattern,
  patchHistoryMethods,
  ERROR_DEDUP_WINDOW_MS,
  type DeviceClass,
} from '@sessionsight/sdk-shared';
import type { PrivacyConfig } from './types.js';

// ── Wire shapes mirrored from apps/api/src/schemas/ingest-anonymous.schema ──

export interface AnonymousPageviewEvent {
  tag: 'pageview';
  path: string;
  referrerHost: string | null;
  deviceClass: DeviceClass;
  lang: string;
  isFirstPageview: boolean;
  ts: number;
}

export interface AnonymousGoalCountEvent {
  tag: 'goal_count';
  goalId: string;
  ts: number;
}

export interface AnonymousAggregateClickEvent {
  tag: 'aggregate_click';
  path: string;
  xBucket: number;
  yBucket: number;
  deviceClass: DeviceClass;
  ts: number;
}

export interface AnonymousExperienceTickEvent {
  tag: 'experience_tick';
  outcome: 'engaged' | 'bounced' | 'frustrated';
  ts: number;
}

export interface AnonymousFormStartEvent {
  tag: 'form_start';
  formId: string;
  formName: string;
  page: string;
  fieldCount: number;
  ts: number;
}

export interface AnonymousFieldFocusEvent {
  tag: 'field_focus';
  formId: string;
  formName: string;
  page: string;
  fieldId: string;
  fieldName: string;
  fieldType: string;
  fieldLabel: string;
  ts: number;
}

export interface AnonymousFieldBlurEvent {
  tag: 'field_blur';
  formId: string;
  formName: string;
  page: string;
  fieldId: string;
  fieldName: string;
  fieldType: string;
  fieldLabel: string;
  timeSpent: number;
  hasValue: boolean;
  ts: number;
}

export interface AnonymousFormFieldRetryEvent {
  tag: 'form_field_retry';
  formName: string;
  fieldName: string;
  page: string;
  retries: number;
  ts: number;
}

export interface AnonymousFormSubmitEvent {
  tag: 'form_submit';
  formId: string;
  formName: string;
  page: string;
  totalFields: number;
  filledFields: number;
  timeToComplete: number;
  ts: number;
}

export interface AnonymousFormAbandonmentEvent {
  tag: 'form_abandonment';
  page: string;
  ts: number;
}

export interface AnonymousErrorEvent {
  tag: 'error';
  message: string;
  stack: string;
  source: string;
  lineno: number;
  colno: number;
  type: 'uncaught' | 'unhandled_rejection';
  page: string;
  ts: number;
}

export type AnonymousEvent =
  | AnonymousPageviewEvent
  | AnonymousGoalCountEvent
  | AnonymousAggregateClickEvent
  | AnonymousExperienceTickEvent
  | AnonymousFormStartEvent
  | AnonymousFieldFocusEvent
  | AnonymousFieldBlurEvent
  | AnonymousFormFieldRetryEvent
  | AnonymousFormSubmitEvent
  | AnonymousFormAbandonmentEvent
  | AnonymousErrorEvent;

// ── Constants ───────────────────────────────────────────────────────

const CLICK_BUCKET_PX = 10;
const FORM_RETRY_WINDOW_MS = 30_000;
const FORM_RETRY_THRESHOLD = 3;
const INPUT_SELECTOR = 'input, textarea, select';
const FORM_CONTAINER_SELECTOR = 'form, [data-ss-form]';

/**
 * Bounce / engaged / frustrated heuristics. Mirrored from the recorder's
 * computeExperienceTier-style logic in spirit; the anonymous tier doesn't
 * see frustration signals beyond rage-click counts and short-stays, so the
 * classifier is intentionally simpler.
 */
const FRUSTRATED_RAGE_CLICK_COUNT = 3;
const BOUNCE_DURATION_MS = 10_000;

// ── Module state ────────────────────────────────────────────────────

type EventSink = (event: AnonymousEvent) => void;

export interface AnonymousCaptureConfig {
  /** Called with every emitted anonymous event. The bridge batches + sends. */
  sink: EventSink;
  /** Server-driven privacy config. Page exclusions are honoured. */
  privacyConfig: PrivacyConfig;
}

export class AnonymousCapture {
  private sink: EventSink;
  private privacyConfig: PrivacyConfig;
  private started = false;

  // Pageview tracking. SPA navigations within the same tab are subsequent;
  // the first emit per ephemeral session sets isFirstPageview=true so the
  // server can gate Class-B breakdown counters (byReferrer, byDevice).
  private hasEmittedFirstPageview = false;
  private currentPath = '';

  // Form tracking (mirrors recorder.ts).
  private formStarted = new Set<string>();
  private formStartTimestamps = new Map<string, number>();
  private focusTimestamps = new Map<string, number>();
  private fieldFocusCounts = new Map<string, number[]>();
  private formActiveOnPage = false;

  // Click rage-detection (for experience_tick).
  private rageClickTimestamps: number[] = [];
  private pageEnterTime = Date.now();

  // Bound DOM handlers we install/uninstall.
  private boundClick = (e: MouseEvent) => this.handleClick(e);
  private boundFocus = (e: FocusEvent) => this.handleFieldFocus(e);
  private boundBlur = (e: FocusEvent) => this.handleFieldBlur(e);
  private boundSubmit = (e: Event) => this.handleFormSubmit(e);
  private boundError = (e: ErrorEvent) => this.handleWindowError(e);
  private boundRejection = (e: PromiseRejectionEvent) => this.handleUnhandledRejection(e);
  private boundVisibility = () => this.handleVisibilityChange();
  private boundPopState = () => this.handleNavigation();

  // History API patches (popstate alone doesn't catch pushState).
  private unpatchHistoryFn: (() => void) | null = null;

  // Last error dedup (mirrors recorder).
  private lastErrorMessage = '';
  private lastErrorTime = 0;

  // Pre-compiled excludePages patterns. Compiled once at construction
  // and on every applyPrivacyConfig so the per-event hot path doesn't
  // re-parse the same strings on every gate check.
  private excludePagePatterns: RegExp[] = [];

  constructor(config: AnonymousCaptureConfig) {
    this.sink = config.sink;
    this.privacyConfig = config.privacyConfig;
    this.excludePagePatterns = (config.privacyConfig.excludePages ?? []).map(globToRegex).filter((r): r is RegExp => r !== null);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this.started = true;
    this.pageEnterTime = Date.now();
    this.currentPath = stripUrlQuery(window.location.pathname);

    document.addEventListener('click', this.boundClick, true);
    document.addEventListener('focus', this.boundFocus, true);
    document.addEventListener('blur', this.boundBlur, true);
    document.addEventListener('submit', this.boundSubmit, true);
    window.addEventListener('error', this.boundError);
    window.addEventListener('unhandledrejection', this.boundRejection);
    document.addEventListener('visibilitychange', this.boundVisibility);
    window.addEventListener('popstate', this.boundPopState);
    window.addEventListener('beforeunload', this.boundVisibility);

    // Mirror the recorder's idempotency guard even though `start()`'s
    // `if (this.started) return;` upstream is already a sufficient defense.
    // Keeping the shape identical to recorder so future cross-tier review
    // doesn't have to reason about the asymmetry.
    if (!this.unpatchHistoryFn) this.unpatchHistoryFn = patchHistoryMethods(() => this.handleNavigation());

    // Emit the first pageview synchronously so first-load traffic is counted
    // even on pages with very short visits.
    this.emitPageview();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    // Flush experience_tick on tear-down so an operator-driven Decline→Accept
    // transition mid-page doesn't drop the rollup signal.
    this.flushExperienceTick();
    // form_abandonment if a form was started but not submitted on this page.
    if (this.formActiveOnPage) {
      this.sink({
        tag: 'form_abandonment',
        page: this.currentPath,
        ts: Date.now(),
      });
      this.formActiveOnPage = false;
    }

    document.removeEventListener('click', this.boundClick, true);
    document.removeEventListener('focus', this.boundFocus, true);
    document.removeEventListener('blur', this.boundBlur, true);
    document.removeEventListener('submit', this.boundSubmit, true);
    window.removeEventListener('error', this.boundError);
    window.removeEventListener('unhandledrejection', this.boundRejection);
    document.removeEventListener('visibilitychange', this.boundVisibility);
    window.removeEventListener('popstate', this.boundPopState);
    window.removeEventListener('beforeunload', this.boundVisibility);

    if (this.unpatchHistoryFn) { this.unpatchHistoryFn(); this.unpatchHistoryFn = null; }
  }

  applyPrivacyConfig(config: PrivacyConfig): void {
    this.privacyConfig = config;
    this.excludePagePatterns = (config.excludePages ?? []).map(globToRegex).filter((r): r is RegExp => r !== null);
  }

  /**
   * Public emitter used by SessionSight.goals.increment when the active tier
   * is anonymous. The tier-aware dispatcher in index.ts routes here instead
   * of POSTing to /v1/sdk/goals/increment.
   */
  emitGoalCount(goalId: string): void {
    if (!this.started) return;
    if (this.isExcludedPage()) return;
    this.sink({ tag: 'goal_count', goalId, ts: Date.now() });
  }

  // ── Page exclusion gate ───────────────────────────────────────────

  private isExcludedPage(): boolean {
    if (this.excludePagePatterns.length === 0) return false;
    const path = stripUrlQuery(window.location.pathname);
    return matchesAnyPattern(path, this.excludePagePatterns);
  }

  // ── Pageview ──────────────────────────────────────────────────────

  private emitPageview(): void {
    if (this.isExcludedPage()) return;
    const path = stripUrlQuery(window.location.pathname);
    const referrer = document.referrer || '';
    const referrerHost = externalReferrerHost(referrer);
    const deviceClass = classifyDevice(navigator.userAgent || '', window.innerWidth || 0);
    const lang = (navigator.language || '').slice(0, 16);

    const isFirstPageview = !this.hasEmittedFirstPageview;
    this.hasEmittedFirstPageview = true;
    this.currentPath = path;
    this.pageEnterTime = Date.now();

    this.sink({
      tag: 'pageview',
      path,
      referrerHost,
      deviceClass,
      lang,
      isFirstPageview,
      ts: Date.now(),
    });
  }

  private handleNavigation(): void {
    const next = stripUrlQuery(window.location.pathname);
    if (next === this.currentPath) return;
    // Page changed: experience_tick for the page we're leaving, then a new
    // pageview for the page we're landing on.
    this.flushExperienceTick();
    if (this.formActiveOnPage) {
      this.sink({
        tag: 'form_abandonment',
        page: this.currentPath,
        ts: Date.now(),
      });
      this.formActiveOnPage = false;
    }
    // Reset per-page state. formStarted is per-formId, not per-page, but the
    // page-keyed component of formId means we don't actively re-trigger.
    this.rageClickTimestamps = [];
    this.emitPageview();
  }

  // ── Click → aggregate_click + rage-click rollup ──────────────────

  private handleClick(e: MouseEvent): void {
    if (this.isExcludedPage()) return;
    const path = stripUrlQuery(window.location.pathname);
    const x = Math.max(0, Math.floor((e.clientX || 0) / CLICK_BUCKET_PX));
    const y = Math.max(0, Math.floor((e.clientY || 0) / CLICK_BUCKET_PX));
    const deviceClass = classifyDevice(navigator.userAgent || '', window.innerWidth || 0);
    this.sink({
      tag: 'aggregate_click',
      path,
      xBucket: x,
      yBucket: y,
      deviceClass,
      ts: Date.now(),
    });

    // Rage-click heuristic: 3+ clicks in 1s near each other. We don't have
    // descriptor here, so we use temporal density alone — false positives are
    // fine, the bucket is "frustrated", not "broken element X".
    const now = Date.now();
    this.rageClickTimestamps.push(now);
    this.rageClickTimestamps = this.rageClickTimestamps.filter(t => now - t < 1000);
  }

  // ── Form events (structural only) ─────────────────────────────────

  private getFormContainer(el: HTMLElement | null): HTMLElement | null {
    if (!el) return null;
    return el.closest(FORM_CONTAINER_SELECTOR) as HTMLElement | null;
  }

  private getFormInfo(container: HTMLElement | null): { formId: string; formName: string } {
    const page = stripUrlQuery(window.location.pathname);
    if (!container) return { formId: `${page}:_page`, formName: page };
    const containerId = (container.id || '').slice(0, 100);
    if (container.tagName === 'FORM') {
      const allForms = Array.from(document.querySelectorAll('form'));
      const index = allForms.indexOf(container as HTMLFormElement);
      const indexStr = index >= 0 ? String(index) : '0';
      const formId = `${page}:${containerId || indexStr}`;
      const dataName = container.getAttribute('data-ss-form')?.slice(0, 100);
      const formName = dataName || containerId || `Form ${index + 1}`;
      return { formId, formName };
    }
    const dataName = container.getAttribute('data-ss-form')!.slice(0, 100);
    const formId = `${page}:${containerId || dataName}`;
    return { formId, formName: dataName };
  }

  private getFieldInfo(
    el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    container: HTMLElement | null,
  ): { fieldId: string; fieldName: string; fieldType: string; fieldLabel: string } {
    const scope = container || document;
    const inputs = Array.from(scope.querySelectorAll(INPUT_SELECTOR));
    const index = inputs.indexOf(el);
    const elId = (el.id || '').slice(0, 100);
    const elName = (el.name || '').slice(0, 100);
    const fieldId = elId || elName || `field-${index}`;
    const fieldName = elName || elId || `field-${index}`;
    const fieldType = el.tagName === 'SELECT'
      ? 'select'
      : el.tagName === 'TEXTAREA'
        ? 'textarea'
        : (el as HTMLInputElement).type || 'text';

    // fieldLabel: prefer the associated <label>, then closest wrapping <label>,
    // then placeholder. All routed through the SDK's redactString PII screen
    // before send.
    let fieldLabel = '';
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) fieldLabel = redactString((label.textContent?.trim() || '').slice(0, 50));
    }
    if (!fieldLabel) {
      const parent = el.closest('label');
      if (parent) {
        const clone = parent.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('input, textarea, select').forEach(c => c.remove());
        fieldLabel = redactString((clone.textContent?.trim() || '').slice(0, 50));
      }
    }
    if (!fieldLabel) {
      const rawPlaceholder = el.getAttribute('placeholder')?.slice(0, 50) || fieldName;
      fieldLabel = redactString(rawPlaceholder);
    }

    return { fieldId, fieldName, fieldType, fieldLabel };
  }

  private handleFieldFocus(e: FocusEvent): void {
    if (this.isExcludedPage()) return;
    try {
      const target = e.target as HTMLElement | null;
      if (!target || !target.matches?.(INPUT_SELECTOR)) return;
      if (isPasswordField(target as HTMLInputElement)) return; // never capture pwd fields, even structurally

      const container = this.getFormContainer(target);
      const { formId, formName } = this.getFormInfo(container);
      const field = this.getFieldInfo(target as HTMLInputElement, container);
      const page = stripUrlQuery(window.location.pathname);
      const now = Date.now();

      if (!this.formStarted.has(formId)) {
        this.formStarted.add(formId);
        this.formStartTimestamps.set(formId, now);
        const scope = container || document;
        const inputs = scope.querySelectorAll(INPUT_SELECTOR);
        this.sink({ tag: 'form_start', formId, formName, page, fieldCount: inputs.length, ts: now });
        this.formActiveOnPage = true;
      }

      const focusKey = `${formId}:${field.fieldId}`;
      this.focusTimestamps.set(focusKey, now);
      this.sink({ tag: 'field_focus', formId, formName, page, ...field, ts: now });

      // Retry frustration signal.
      const focusTimes = this.fieldFocusCounts.get(focusKey) || [];
      focusTimes.push(now);
      const cutoff = now - FORM_RETRY_WINDOW_MS;
      const recent = focusTimes.filter(t => t >= cutoff);
      this.fieldFocusCounts.set(focusKey, recent);
      if (recent.length >= FORM_RETRY_THRESHOLD) {
        this.sink({ tag: 'form_field_retry', formName, fieldName: field.fieldName, page, retries: recent.length, ts: now });
        this.fieldFocusCounts.set(focusKey, []);
      }
    } catch {
      // never throw out of a DOM handler
    }
  }

  private handleFieldBlur(e: FocusEvent): void {
    if (this.isExcludedPage()) return;
    try {
      const target = e.target as HTMLElement | null;
      if (!target || !target.matches?.(INPUT_SELECTOR)) return;
      if (isPasswordField(target as HTMLInputElement)) return;

      const container = this.getFormContainer(target);
      const { formId, formName } = this.getFormInfo(container);
      const field = this.getFieldInfo(target as HTMLInputElement, container);
      const page = stripUrlQuery(window.location.pathname);

      const focusKey = `${formId}:${field.fieldId}`;
      const focusTime = this.focusTimestamps.get(focusKey);
      const timeSpent = focusTime ? Date.now() - focusTime : 0;
      this.focusTimestamps.delete(focusKey);

      const el = target as HTMLInputElement;
      let hasValue: boolean;
      if (el.type === 'checkbox' || el.type === 'radio') hasValue = el.checked;
      else hasValue = (el.value || '').trim().length > 0;

      this.sink({ tag: 'field_blur', formId, formName, page, ...field, timeSpent, hasValue, ts: Date.now() });
    } catch {
      // never throw out of a DOM handler
    }
  }

  private handleFormSubmit(e: Event): void {
    if (this.isExcludedPage()) return;
    try {
      const form = e.target as HTMLFormElement | null;
      if (!form || form.tagName !== 'FORM') return;
      const { formId, formName } = this.getFormInfo(form);
      const page = stripUrlQuery(window.location.pathname);
      const inputs = form.querySelectorAll(INPUT_SELECTOR);
      let filledFields = 0;
      for (const input of Array.from(inputs)) {
        const el = input as HTMLInputElement;
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) filledFields++;
        } else if (el.value.trim().length > 0) {
          filledFields++;
        }
      }
      const startTime = this.formStartTimestamps.get(formId);
      const timeToComplete = startTime ? Date.now() - startTime : 0;
      this.sink({
        tag: 'form_submit',
        formId,
        formName,
        page,
        totalFields: inputs.length,
        filledFields,
        timeToComplete,
        ts: Date.now(),
      });
      this.formActiveOnPage = false;
    } catch {
      // never throw out of a DOM handler
    }
  }

  // ── Error capture (already sanitized at the SDK) ─────────────────

  private emitErrorEvent(data: {
    message: string;
    stack: string;
    source: string;
    lineno: number;
    colno: number;
    type: 'uncaught' | 'unhandled_rejection';
  }): void {
    if (this.isExcludedPage()) return;
    const now = Date.now();
    const sanitizedMessage = sanitizeErrorText(data.message);
    if (sanitizedMessage === this.lastErrorMessage && now - this.lastErrorTime < ERROR_DEDUP_WINDOW_MS) {
      return;
    }
    this.lastErrorMessage = sanitizedMessage;
    this.lastErrorTime = now;
    this.sink({
      tag: 'error',
      message: sanitizedMessage,
      stack: sanitizeErrorText(data.stack),
      source: stripUrlQuery(data.source || ''),
      lineno: data.lineno || 0,
      colno: data.colno || 0,
      type: data.type,
      page: stripUrlQuery(window.location.pathname),
      ts: now,
    });
  }

  private handleWindowError(e: ErrorEvent): void {
    this.emitErrorEvent({
      message: e.message || 'Unknown error',
      stack: (e.error?.stack || '').slice(0, 4000),
      source: e.filename || '',
      lineno: e.lineno || 0,
      colno: e.colno || 0,
      type: 'uncaught',
    });
  }

  private handleUnhandledRejection(e: PromiseRejectionEvent): void {
    const reason = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason || 'Unhandled rejection');
    const stack = reason instanceof Error ? (reason.stack || '').slice(0, 4000) : '';
    this.emitErrorEvent({
      message,
      stack,
      source: '',
      lineno: 0,
      colno: 0,
      type: 'unhandled_rejection',
    });
  }

  // ── Experience tick (engaged / bounced / frustrated) ─────────────

  private flushExperienceTick(): void {
    if (this.isExcludedPage()) return;
    const dwell = Date.now() - this.pageEnterTime;
    let outcome: 'engaged' | 'bounced' | 'frustrated';
    if (this.rageClickTimestamps.length >= FRUSTRATED_RAGE_CLICK_COUNT) outcome = 'frustrated';
    else if (dwell < BOUNCE_DURATION_MS) outcome = 'bounced';
    else outcome = 'engaged';
    this.sink({ tag: 'experience_tick', outcome, ts: Date.now() });
  }

  private handleVisibilityChange(): void {
    if (document.visibilityState === 'hidden') this.flushExperienceTick();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function isPasswordField(el: HTMLInputElement): boolean {
  if (!el) return false;
  if (el.tagName !== 'INPUT') return false;
  return (el.type || '').toLowerCase() === 'password';
}

