// @paymastech/sk-login-widget: the Secret Keeper popups without a framework.
// The look and behavior are those of the lashin.su sheets (the reference
// consumer): a bottom sheet on a narrow screen, a centered card on a wide one.
//
//   mountSkLogin    "Sign in with Secret Keeper" (protocol § 4.5)
//   mountSkRequest  "Fill from Secret Keeper", a vault record for a form (§ 4.6)
//
//   const login = mountSkLogin({ apiBase: '/api/sk', onSuccess: () => location.reload() });
//   button.addEventListener('click', () => login.open());

export {
  mountSkLogin,
  texts,
  type InitResponse,
  type SkLoginWidget,
  type SkLoginWidgetOptions,
  type Texts,
} from './login.js';
export {
  mountSkRequest,
  requestTexts,
  type RequestInitResponse,
  type RequestTexts,
  type SkFilled,
  type SkRequestWidget,
  type SkRequestWidgetOptions,
} from './request.js';
export { type Lang, type SheetOptions, type SheetTexts, sheetTexts } from './sheet.js';
export { SK_LOGO } from './logo.js';
