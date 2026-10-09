# @paymastech/sk-login-nestjs

NestJS module for sign-in through Secret Keeper. It mounts the `init`,
`login`, `status`, `code` and `target` routes under a prefix (`api/sk` by
default) and exports `SkLoginService`. With `dataRequest` configured it also
mounts `request/init`, `request/status` and `data` for filling forms from
the user's vault.

```bash
npm i @paymastech/sk-login-nestjs
```

```ts
import { SkLoginModule } from '@paymastech/sk-login-nestjs';

@Module({
  imports: [
    SkLoginModule.forRoot<User>({
      mnemonic: process.env.SK_SERVER_MNEMONIC!,
      target: { site: 'example.com' },   // the app posts to https://example.com/sk/login
      // Who to let in; the second argument is { sid, ctx } for a decision tied to the page's request
      access: async (address) => {
        const user = await users.findByAddress(address);
        return user ? { kind: 'granted', user } : { kind: 'denied', reason: 'unknown-address' };
      },
      onAuthenticated: async (user, { res }) => {
        res.header('set-cookie', await sessions.cookieFor(user));
        return { userId: user.id };
      },
      // Optional: data requests (§ 4.6). The owner is the page session; only it gets the values.
      dataRequest: {
        owner: ({ req }) => {
          const token = sessions.tokenFrom(req);
          return token ? ownerKey(token) : undefined;
        },
      },
    }),
  ],
})
export class AppModule {}
```

`ownerKey` is exported from this package too.

With ConfigService:

```ts
SkLoginModule.forRootAsync<User>({
  imports: [ConfigModule],
  inject: [ConfigService, UsersService],
  routePrefix: 'auth/sk',
  useFactory: (config: ConfigService, users: UsersService) => ({
    mnemonic: config.getOrThrow('SK_SERVER_MNEMONIC'),
    target: { id: 'my-service', publicUrl: config.get('PUBLIC_URL') },
    access: (address) => users.decide(address),
  }),
});
```

Full description of the options, the HTTP API, error codes, target
onboarding and running on several replicas: [repository README](https://github.com/Paymaster-Technologies/sk-login#readme).
Browser side: [`@paymastech/sk-login-widget`](https://www.npmjs.com/package/@paymastech/sk-login-widget).

Works on Express and Fastify (Nest 10 and 11). The module reads the
`POST login` body (`text/plain`) itself, no global body parsers are needed.
You do not need `reflect-metadata` or `emitDecoratorMetadata`: all module
dependencies are declared via `@Inject`.
