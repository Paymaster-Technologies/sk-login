import { type DynamicModule, Module } from '@nestjs/common';

import {
  DEFAULT_ROUTE_PREFIX,
  SK_LOGIN_OPTIONS,
  type SkLoginModuleAsyncOptions,
  type SkLoginModuleOptions,
} from './options.js';
import { createSkLoginController } from './sk-login.controller.js';
import { SkLoginService } from './sk-login.service.js';

/**
 * Sign-in through Secret Keeper for NestJS.
 *
 *   SkLoginModule.forRoot({
 *     mnemonic: process.env.SK_SERVER_MNEMONIC!,
 *     target: { id: 'myservice', publicUrl: 'https://api.example.com' },
 *     access: async (address) => ({ kind: 'granted', user: { address } }),
 *     onAuthenticated: (user, { res }) => { res.cookie('session', issue(user)); },
 *   })
 *
 * Routes under `routePrefix` (`api/sk` by default): init, login, status, code,
 * target. `SkLoginService` is exported for your own providers.
 */
@Module({})
export class SkLoginModule {
  static forRoot<User = unknown>(options: SkLoginModuleOptions<User> & { routePrefix?: string }): DynamicModule {
    const { routePrefix, ...rest } = options;
    return SkLoginModule.build(routePrefix, [], [], { provide: SK_LOGIN_OPTIONS, useValue: rest });
  }

  static forRootAsync<User = unknown>(options: SkLoginModuleAsyncOptions<User>): DynamicModule {
    return SkLoginModule.build(options.routePrefix, options.imports ?? [], [], {
      provide: SK_LOGIN_OPTIONS,
      inject: options.inject ?? [],
      useFactory: options.useFactory,
    });
  }

  private static build(prefix: string | undefined, imports: any[], extra: any[], optionsProvider: any): DynamicModule {
    return {
      module: SkLoginModule,
      imports,
      controllers: [createSkLoginController(prefix ?? DEFAULT_ROUTE_PREFIX)],
      providers: [optionsProvider, SkLoginService, ...extra],
      exports: [SkLoginService, SK_LOGIN_OPTIONS],
    };
  }
}
