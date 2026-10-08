// @paymastech/sk-login-nestjs: Secret Keeper sign-in module for NestJS.
export { SkLoginModule } from './sk-login.module.js';
export { SkLoginService, type TargetInfo } from './sk-login.service.js';
export {
  DEFAULT_ROUTE_PREFIX,
  SK_LOGIN_ENDPOINT,
  SK_LOGIN_OPTIONS,
  SK_REQUEST_ENDPOINT,
  type DataRequestOptions,
  type HttpPair,
  type OnAuthenticated,
  type SkLoginModuleAsyncOptions,
  type SkLoginModuleOptions,
} from './options.js';
export { ownerKey } from '@paymastech/sk-login-core';
export type { AccessDecider, AccessDecision, DataRequestStore, Kind, PendingStore, Lang } from '@paymastech/sk-login-core';
