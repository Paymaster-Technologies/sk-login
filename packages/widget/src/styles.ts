// Widget styles: everything under the skl- prefix, colors via CSS variables
// with defaults (light and dark theme by prefers-color-scheme). The service
// can override the variables on :root or on dialog.skl itself.
export const STYLES = `
.skl {
  --skl-bg: #f1f1f3;
  --skl-item: #fcfcff;
  --skl-separator: #e4e4e7;
  --skl-secondary: #636369;
  --skl-text: #010102;
  --skl-primary: #326afb;
  --skl-primary-soft: rgba(50, 106, 251, 0.12);
  --skl-danger: #de3b3b;
  --skl-surface-high: #dfe3e7;
  --skl-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .skl:not([data-theme="light"]) {
    --skl-bg: #010102;
    --skl-item: #17171a;
    --skl-separator: #3a3a3d;
    --skl-secondary: #99999e;
    --skl-text: #fafaff;
    --skl-surface-high: #2c2c30;
  }
}
.skl[data-theme="dark"] {
  --skl-bg: #010102;
  --skl-item: #17171a;
  --skl-separator: #3a3a3d;
  --skl-secondary: #99999e;
  --skl-text: #fafaff;
  --skl-surface-high: #2c2c30;
}
dialog.skl {
  padding: 0;
  border: 0;
  background: var(--skl-item);
  color: var(--skl-text);
  font: 16px/1.5 var(--skl-font);
  text-align: center;
  width: min(480px, calc(100% - 32px));
  max-height: 85vh;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  overflow: auto;
  box-sizing: border-box;
}
dialog.skl * { box-sizing: border-box; }
dialog.skl[open] { animation: skl-in 220ms cubic-bezier(0.215, 0.61, 0.355, 1); }
dialog.skl::backdrop { background: rgba(0, 0, 0, 0.54); }
@keyframes skl-in { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: none; } }
.skl-inner { padding: 12px 16px 16px; position: relative; }
.skl-bar { display: grid; grid-template-columns: 44px 1fr 44px; align-items: center; gap: 8px; min-height: 44px; }
.skl.info .skl-bar { display: none; }
.skl-close {
  width: 44px; height: 44px; border-radius: 50%; border: 0; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--skl-surface-high); color: var(--skl-text); cursor: pointer;
}
.skl-close svg { width: 22px; height: 22px; }
.skl-title { margin: 0; font-size: 1.25rem; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skl-spacer { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; }
.skl-ttl { font-size: 0.9rem; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--skl-secondary); }
.skl-ttl.soon { color: var(--skl-danger); }
.skl-body { padding-top: 12px; }
.skl-secondary { color: var(--skl-secondary); }
.skl-hint { margin: 4px 0 0; font-size: 0.9rem; line-height: 1.45; text-wrap: balance; }
.skl-hint a { color: var(--skl-primary); text-decoration: none; white-space: nowrap; }
.skl-hint-icon { display: inline-block; width: 18px; height: 18px; margin: 0 0.15em; vertical-align: -0.25em; color: var(--skl-text); }
.skl-qr {
  position: relative; display: block; width: 232px; height: 232px; margin: 18px auto 0;
  border-radius: 12px; background: #fff; padding: 10px; text-decoration: none;
}
.skl-qr svg { width: 100%; height: 100%; display: block; }
.skl-qr-logo {
  position: absolute; top: 50%; left: 50%; width: 44px; height: 44px; padding: 5px; box-sizing: content-box;
  transform: translate(-50%, -50%); background: #fff; border-radius: 50%;
}
.skl-qr.loading { background: var(--skl-surface-high); }
.skl-qr.loading > span:first-child, .skl-qr.loading .skl-qr-logo { visibility: hidden; }
.skl-qr-spinner { display: none; position: absolute; top: 50%; left: 50%; translate: -50% -50%; }
.skl-qr.loading .skl-qr-spinner {
  display: block; width: 32px; height: 32px; border-radius: 50%;
  border: 3px solid color-mix(in srgb, var(--skl-secondary) 35%, transparent); border-top-color: var(--skl-primary);
  animation: skl-spin 0.8s linear infinite;
}
@keyframes skl-spin { to { transform: rotate(360deg); } }
.skl-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 11px 20px; border-radius: 12px; border: 0; font: inherit; font-weight: 600; cursor: pointer;
  text-decoration: none; background: var(--skl-primary); color: #fff; min-width: 232px;
}
.skl-btn:hover { filter: brightness(1.06); }
.skl-qr + .skl-btn { margin-top: 20px; }
.skl-noapp { margin: 12px 0 0; font-size: 0.9rem; }
.skl-noapp a { color: var(--skl-primary); }
.skl-logo { display: block; position: relative; width: 56px; height: 56px; margin: 16px auto 20px; border-radius: 50%; }
.skl-logo img { display: block; width: 100%; height: 100%; border-radius: 50%; }
.skl-logo::after {
  content: ''; position: absolute; inset: -6px; border-radius: 50%;
  border: 2px solid var(--skl-separator); border-top-color: var(--skl-primary); animation: skl-spin 1s linear infinite;
}
.skl-lead { margin: 4px 0 18px; }
.skl-lead:has(+ .skl-lead:not(.skl-hidden)) { margin-bottom: 8px; }
.skl-link-btn { font: inherit; padding: 0; border: 0; background: none; color: var(--skl-primary); cursor: pointer; }
.skl-code-form { width: 100%; max-width: 360px; margin: 0 auto 4px; display: flex; flex-direction: column; align-items: stretch; gap: 12px; }
.skl-code-label { margin: 0 0 -4px; font-size: 0.9rem; }
.skl-field {
  font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--skl-separator);
  background: var(--skl-bg); color: var(--skl-text); width: 100%; letter-spacing: 0.15em; text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.skl-field::placeholder { letter-spacing: normal; font-family: var(--skl-font); }
.skl-field.error { border-color: var(--skl-danger); }
.skl-field.error::placeholder { color: var(--skl-danger); }
.skl-info { display: flex; flex-direction: column; align-items: stretch; padding-top: 8px; }
.skl-info-icon { display: block; width: 40px; height: 40px; margin: 0 auto; color: var(--skl-primary); }
.skl-info-icon.danger { color: var(--skl-danger); }
.skl-info-text { margin: 16px 0 24px; font-size: 1rem; line-height: 1.45; }
.skl-btn.outline { width: 100%; min-height: 48px; border-radius: 999px; border: 1px solid var(--skl-primary); background: transparent; color: var(--skl-primary); min-width: 0; }
.skl-expired { position: absolute; inset: 0; z-index: 2; display: flex; align-items: flex-end; background: rgba(0, 0, 0, 0.45); }
.skl-expired-card {
  width: 100%; padding: 18px 16px 16px; background: var(--skl-item); border-radius: 16px 16px 0 0;
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.25); display: flex; flex-direction: column; align-items: center;
  animation: skl-up 0.25s ease-out;
}
.skl-expired-icon { display: block; width: 44px; height: 44px; margin: 10px auto 6px; color: var(--skl-primary); }
.skl-expired-title { margin: 8px 0 18px; font-weight: 600; font-size: 1.1rem; }
@keyframes skl-up { from { transform: translateY(100%); } to { transform: none; } }
.skl-hidden { display: none !important; }
@media (max-width: 520px) {
  dialog.skl { width: 100%; max-width: none; margin: auto 0 0; border-radius: 16px 16px 0 0; max-height: 92vh; }
  .skl-inner { padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
}
`;

let injected = false;
export function ensureStyles(doc: Document): void {
  if (injected || doc.getElementById('skl-styles')) return;
  const style = doc.createElement('style');
  style.id = 'skl-styles';
  style.textContent = STYLES;
  doc.head.appendChild(style);
  injected = true;
}
