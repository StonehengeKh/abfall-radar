/**
 * Schedule rules and their presentation, shared by the web application and the extension.
 *
 * Framework-free: source-local calendar days, the total event order, what a collection day means for
 * the featured card and the countdown, drop-off window wording, locale-aware date formatting, and the
 * copy every schedule surface shares. No storage, no request, no React — each application keeps its own
 * controllers, navigation and persistence, and renders this through `@abfall-radar/ui`.
 */

export * from './collection-day';
export * from './collection-window';
export * from './event-order';
export * from './featured';
export * from './format';
export * from './household';
export * from './locale';
export * from './messages';
export * from './source-day';
export * from './timestamp';
