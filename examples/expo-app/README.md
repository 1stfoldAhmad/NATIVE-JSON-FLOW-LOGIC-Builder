# Expo demo app (`examples/expo-app`)

A minimal but **real** Expo app proving the first vertical slice end to end:

```
@expo/ui form  --form.submit event-->  JSON hook (hook.form.before-submit)
  -->  JSON flow (flow.user.registration)  -->  JSON classes/functions
  -->  registered natives (fetch API adapter)  -->  ExecutionResult in the UI
```

All business logic lives in `specs/*.json` (copied from `examples/registration`).
The React code only wires the engine (`App.tsx`), implements the I/O natives
(`natives.ts`), and renders the screen (`RegistrationScreen.tsx`).

## Run it

```bash
cd examples/expo-app
npm install
# optional: point the API natives at a real backend
#   echo 'EXPO_PUBLIC_API_BASE=https://api.example.com' > .env
npx expo start        # then press i / a / w, or scan the QR with Expo Go
```

Fill the form and press **Register**. The screen dispatches `form.submit`;
the JSON hook runs `flow.user.registration` (validate → normalize → duplicate
check → create user → emit `user.registered` → send verification email).

## What to verify (on a device/emulator — not run in CI)

1. Metro bundles `vds-json-logic` and `vds-json-logic/expo` from the `file:../..`
   link without errors (see `metro.config.js` `watchFolders`).
2. The app loads with no `NOT_ALLOWED` load errors: `createExpoEngine` fixes
   `environment: "frontend"`, so backend-only specs would be rejected.
3. Pressing **Register** shows the spinner, then either the success message
   (backend reachable / stubbed) or a typed error (`error.code`/`message`),
   e.g. validation failure from the JSON flow.
4. `user.registered` fires `useFlowEvent` (visible via the verification-email
   line / console) — event contracts are validated at dispatch time.
5. Kill the app mid-flight / toggle airplane mode to see cancellation and
   error propagation through `useFlowState`.

## Notes

- `vds-json-logic` runtime code is plain ESM JS (`dist/`), React is an optional
  peer — the core never imports React; only `vds-json-logic/expo` does.
- JSON specs are loaded with `engine.loadJson([...])` from Metro-bundled JSON
  imports. Filesystem loading (`loadSpecFiles`) lives in the Node-only entry
  `vds-json-logic/node` and is not available in Expo.
- The actual form rendering in production belongs to the Expo JSON Form
  Builder; this screen dispatches the same `form.submit` contract.
