# OES PDA

This directory contains the OES PDA device terminal.

PDA is an independent Android device product, not a `tenant-web` variant. The Android Shell owns the controlled WebView container and device capabilities. The Vue3 PDA Web app owns the acceptance workbench and consumes only the stable PDA BFF and JS Bridge contracts.

## Architecture References

- PDA terminal truth source: [docs/architecture/terminals/pda.md](../../docs/architecture/terminals/pda.md)
- PDA device BFF contract: [docs/contracts/api-gateway/pda-device-bff.md](../../docs/contracts/api-gateway/pda-device-bff.md)
- PDA JS Bridge contract: [docs/contracts/pda/js-bridge.md](../../docs/contracts/pda/js-bridge.md)

## Directory Layout

```text
app/pda/
  web/      Vue3 + Vite + TypeScript + Vant PDA Web app
  android/  Kotlin Android Shell and WebView container
```

## Phase 1 Scope

Phase 1 builds the system foundation:

- PDA login and session bootstrap through `/pda/*` BFF contracts
- Android Shell secure refresh-token storage
- Vue3 acceptance workbench
- JS Bridge for device information, scanner events, camera capture, network status, vibration, beep, and local diagnostics
- device heartbeat
- manual diagnostic log upload
- version policy handling

Phase 1 does not implement WMS / MES business workflows, offline business submission, device management UI, Bluetooth printing, NFC, photo upload, or MDM integration.

## Web Commands

Run from `app/pda` after `web/` is scaffolded:

```bash
pnpm install
pnpm --filter @oes/pda-web dev
pnpm --filter @oes/pda-web test
pnpm --filter @oes/pda-web build
```

## Android Commands

Run from `app/pda`:

```bash
pnpm doctor:android
pnpm test:android
pnpm build:android
pnpm build:apk
```

The debug APK is generated at:

```text
app/pda/android/app/build/outputs/apk/debug/app-debug.apk
```

`pnpm build:apk` first builds `app/pda/web/dist`, then packages that static output into the Android APK assets. The Android Shell loads it from:

```text
https://oes-pda.local/
```

The virtual HTTPS URL is served by the Android Shell from APK assets. This avoids old Android 9 WebView issues where `file:///android_asset` can block module scripts because of CORS or missing JavaScript MIME types.

The PDA Web build target is pinned to `chrome66` because the current Cruise Ge device reports Android WebView `66.0.3359.158`.

## Local Android Environment

The PDA scripts configure the local Android CLI environment explicitly instead of relying on global shell state:

- `JAVA_HOME` defaults to Android Studio JBR when available.
- `ANDROID_HOME` defaults to `$HOME/Library/Android/sdk`.
- `PATH` includes Android platform tools for `adb`.
- Gradle runs through the project wrapper under `app/pda/android`.
- `HTTPS_PROXY` / `HTTP_PROXY` are converted into Java proxy arguments for Gradle dependency resolution.

Current local baseline verified on this machine:

- Android Studio JBR 21.0.10
- Android SDK platform tools with `adb` 37.0.0
- Android SDK platforms `android-35` and `android-36.1`
- Android build tools `34.0.0`, `36.1.0`, and `37.0.0`
- Gradle Wrapper 8.10.2

Known non-blocking gap:

- `sdkmanager` is not currently installed because Android SDK `cmdline-tools` is missing. Android Studio and the existing SDK can build the Phase 1 APK, but CLI SDK installation/updates should be added later.

Do not rely on `tenant-web` layout, Vben components, Web routes, or management-table interaction patterns for PDA.
