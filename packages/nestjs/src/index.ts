// @paymastech/sk-login-nestjs: Secret Keeper sign-in module for NestJS.
export { SkLoginModule } from './sk-login.module.js';
export { SkLoginService, type TargetInfo } from './sk-login.service.js';
export {
  DEFAULT_ROUTE_PREFIX,
  SK_LOGIN_OPTIONS,
  type DataRequestOptions,
  type HttpPair,
  type OnAuthenticated,
  type SkLoginModuleAsyncOptions,
  type SkLoginModuleOptions,
} from './options.js';
export { ownerHash, ownerKey } from '@paymastech/sk-login-core';
export type { AccessDecider, AccessDecision, DataRequestStore, Kind, PendingStore, Lang } from '@paymastech/sk-login-core';
