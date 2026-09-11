# V2 exact-owner profile template

Render every placeholder before hashing:

- `OWNER_PATH`, `ARTIFACT_PATH`, and `TASK_TEMP_PATH`;
- `OWNER_TASK_ID` and exact `TRANSITION_ID` for the active DA, unique UD, DO, CO task, or visible RV subagent;
- read-only `REPOSITORY_ROOT` and `TRUSTED_AUTHORIZATION_ROOT`;
- owner-exclusive `OWNER_GIT_DIRECTORY`, exact read-only `USER_GIT_CONFIG`, and host-specific read-only `CREDENTIAL_STORE_PATH`;
- create-only shared remote-action recovery root; the legacy template name `SERIAL_ADMISSION_ROOT` is retained only for installed-profile compatibility, not for direct merge admission; and
- `PACKAGE_CACHE_PATH`.

Use `profile-render`; do not substitute approval fields directly. `APPROVAL_MODE` atomically selects the supported approval policy/reviewer pair and seals its expected permission-sandbox fingerprint in the installed profile and launch receipt. Repairs retain the same owner, increment generation monotonically, reference the preceding receipt, and use a new transition.

Every profile writes `RESOURCE_TOPOLOGY_VERSION=owner-exclusive-v2` and seals one `OES_OWNER_RESOURCE_BINDING`. The owner clone has a private Git/common directory, durable artifacts remain outside temporary storage, and the current DP/ADP package, evidence manifest, checkpoint bundle, and optional Git bundle rehash exactly.

`OWNER_GIT_DIRECTORY` is the owner-exclusive clone's `.git`, not a shared common directory. `TMPDIR` is the exact task scratch path. The authorization root is a real read-only descendant of the installed profile; only the issuing parent/decision transport writes immutable authorization and execution-native evidence. The recovery root contains idempotent CI/local-main receipts and grants no ref/worktree access; OES merge admission uses Merge Queue and no local merge lock.

Read back the installed profile SHA and complete both preflight phases before using it. The profile grants only the declared owner resources, credential dependencies, package cache, task scratch, and protocol roots; keep sensitive-path denies and domain allowlist unchanged.
