import type { SelfSecurityApi } from '#/api';

export type ContactBindingKind = 'email' | 'phone';
export type LoginMethodGroupKind = 'email' | 'phone' | 'terminalPin';

export interface LoginMethodCapabilityItem {
  actionDisabled: boolean;
  disabledLabel: string;
  enabled: boolean;
  hasPassword: boolean;
  hint: string;
  label: string;
  methodId: string;
  type: string;
  verified: boolean;
}

export interface LoginMethodGroup {
  boundValue: string;
  capabilities: LoginMethodCapabilityItem[];
  emptyLabel: string;
  kind: LoginMethodGroupKind;
  statusColor: 'blue' | 'default' | 'orange';
  statusText: string;
  title: string;
}

export interface LoginHistoryTableRow extends SelfSecurityApi.LoginHistoryItem {
  rowKey: string;
}

export type MfaEnableFlow =
  | 'ENABLE_DIRECT'
  | 'OPEN_RECOVERY_CODE_SETUP'
  | 'OPEN_TOTP_SETUP'
  | 'REQUIRE_TOTP_FIRST';

interface LoginMethodGroupDefinition {
  contactLabel: string;
  supportedTypes: Set<string>;
  kind: LoginMethodGroupKind;
  passwordType: string;
  otpType: string;
  title: string;
}

const LOGIN_METHOD_GROUP_DEFINITIONS: LoginMethodGroupDefinition[] = [
  {
    contactLabel: '邮箱',
    supportedTypes: new Set(['EMAIL', 'EMAIL_OTP', 'EMAIL_PASSWORD']),
    kind: 'email',
    passwordType: 'EMAIL_PASSWORD',
    otpType: 'EMAIL_OTP',
    title: '邮箱登录',
  },
  {
    contactLabel: '手机号',
    supportedTypes: new Set(['PHONE', 'PHONE_OTP', 'PHONE_PASSWORD']),
    kind: 'phone',
    passwordType: 'PHONE_PASSWORD',
    otpType: 'PHONE_OTP',
    title: '手机登录',
  },
];

// Resolves the current bound email or phone label from verified login methods.
export function resolveBoundContact(
  loginMethods: SelfSecurityApi.LoginMethod[],
  kind: ContactBindingKind,
) {
  const method = resolveVerifiedContactMethod(loginMethods, kind);

  return method?.maskedIdentifier || method?.identifier || '';
}

// Resolves the exact verified identifier for comparison and mutation guards.
export function resolveBoundContactIdentifier(
  loginMethods: SelfSecurityApi.LoginMethod[],
  kind: ContactBindingKind,
) {
  return resolveVerifiedContactMethod(loginMethods, kind)?.identifier || '';
}

// Chooses the preferred current-user identifier from verified bindings for header-level display.
export function resolveCurrentUserDisplayIdentifier(
  loginMethods: SelfSecurityApi.LoginMethod[],
) {
  const verifiedEmail = resolveVerifiedContactIdentifier(loginMethods, 'email');
  if (verifiedEmail) {
    return verifiedEmail;
  }

  return resolveVerifiedContactIdentifier(loginMethods, 'phone');
}

// Returns the CTA label for the current binding state.
export function getContactBindingActionLabel(boundValue?: string) {
  return boundValue ? '更换绑定' : '立即绑定';
}

// Validates one email or phone value before the binding challenge is requested.
export function validateContactBindingValue(
  kind: ContactBindingKind,
  value: string,
) {
  const trimmedValue = normalizeContactBindingValue(kind, value);

  if (!trimmedValue) {
    return kind === 'email' ? '请输入邮箱地址' : '请输入手机号';
  }

  if (kind === 'email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedValue)
      ? ''
      : '请输入有效的邮箱地址';
  }

  return /^\+\d{6,20}$/.test(trimmedValue) ? '' : '请输入有效的手机号';
}

// Normalizes one contact binding candidate before local comparisons or API submission.
export function normalizeContactBindingValue(
  kind: ContactBindingKind,
  value: string,
) {
  const trimmedValue = value.trim();
  return kind === 'email' ? trimmedValue.toLowerCase() : trimmedValue;
}

// Validates one OTP value before the binding verification is submitted.
export function validateContactBindingOtp(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return '请输入验证码';
  }

  return /^\d{6}$/.test(trimmedValue) ? '' : '请输入 6 位验证码';
}

// Builds contact and terminal-PIN login-capability groups for the compact security-center card layout.
export function buildLoginMethodGroups(
  loginMethods: SelfSecurityApi.LoginMethod[],
): LoginMethodGroup[] {
  return [
    ...LOGIN_METHOD_GROUP_DEFINITIONS.map((definition) =>
      buildLoginMethodGroup(loginMethods, definition),
    ),
    buildTerminalPinLoginMethodGroup(loginMethods),
  ];
}

// Explains why one MFA factor is currently unavailable in self-service security management.
export function getMfaAvailabilityHint(binding: SelfSecurityApi.MfaBinding) {
  if (binding.available) {
    return binding.enabled ? '当前可用于二次验证' : '满足启用条件，可按需开启';
  }

  switch (binding.type) {
    case 'BACKUP_CODE': {
      return '需要先启用认证器 App';
    }
    case 'EMAIL_OTP': {
      return '需要先绑定并验证邮箱';
    }
    case 'SMS_OTP': {
      return '需要先绑定并验证手机号';
    }
    default: {
      return '当前方式暂不可用';
    }
  }
}

// Returns a clearer fallback destination label for MFA rows whose target is implicit.
export function getMfaDisplayDestination(binding: SelfSecurityApi.MfaBinding) {
  if (binding.destination) {
    return binding.destination;
  }

  switch (binding.type) {
    case 'BACKUP_CODE': {
      return binding.enabled ? '已生成恢复码' : '尚未生成恢复码';
    }
    case 'TOTP': {
      return binding.enabled ? '已绑定认证器 App' : '尚未绑定认证器 App';
    }
    default: {
      return '未提供绑定目标';
    }
  }
}

// Routes disabled MFA factors to either direct enablement or their prerequisite setup flow.
export function resolveMfaEnableFlow(
  binding: SelfSecurityApi.MfaBinding,
  totpBinding?: null | SelfSecurityApi.MfaBinding,
): MfaEnableFlow {
  if (binding.type === 'TOTP') {
    return 'OPEN_TOTP_SETUP';
  }

  if (binding.type === 'BACKUP_CODE') {
    return totpBinding?.enabled
      ? 'OPEN_RECOVERY_CODE_SETUP'
      : 'REQUIRE_TOTP_FIRST';
  }

  return 'ENABLE_DIRECT';
}

// Keeps disabled setup actions aligned with factors that can explain their own prerequisites.
export function isMfaEnableActionDisabled(binding: SelfSecurityApi.MfaBinding) {
  return !binding.enabled && !binding.available && binding.type !== 'BACKUP_CODE';
}

// Maps one recorded auth-session terminal code to a compact user-facing label.
export function getSessionTerminalLabel(terminal?: string) {
  const normalizedTerminal = terminal?.trim().toUpperCase();

  switch (normalizedTerminal) {
    case 'WEB':
    case 'TENANT_WEB': {
      return 'Web';
    }
    case 'PDA': {
      return 'PDA';
    }
    case 'KIOSK': {
      return 'Kiosk';
    }
    case 'MOBILE': {
      return 'Mobile';
    }
    case 'API_CLIENT': {
      return 'API Client';
    }
    case 'INDUSTRIAL_TABLET': {
      return '工业平板';
    }
    case '':
    case undefined: {
      return '未知终端';
    }
    default: {
      return terminal?.trim() || '未知终端';
    }
  }
}

// Maps one recorded auth-session terminal code to a stable Ant Design tag color.
export function getSessionTerminalColor(terminal?: string) {
  const normalizedTerminal = terminal?.trim().toUpperCase();

  switch (normalizedTerminal) {
    case 'WEB':
    case 'TENANT_WEB': {
      return 'blue';
    }
    case 'PDA': {
      return 'green';
    }
    case 'KIOSK': {
      return 'orange';
    }
    case 'MOBILE': {
      return 'cyan';
    }
    case 'API_CLIENT': {
      return 'geekblue';
    }
    case 'INDUSTRIAL_TABLET': {
      return 'gold';
    }
    default: {
      return 'default';
    }
  }
}

// Merges login-history pages with deterministic record-derived keys and collision suffixes.
export function mergeLoginHistoryTableRows(
  currentRows: LoginHistoryTableRow[],
  incomingItems: SelfSecurityApi.LoginHistoryItem[],
  append: boolean,
): LoginHistoryTableRow[] {
  const rows = append ? [...currentRows] : [];
  const occurrences = new Map<string, number>();

  for (const row of rows) {
    const fingerprint = loginHistoryFingerprint(row);
    occurrences.set(fingerprint, (occurrences.get(fingerprint) ?? 0) + 1);
  }

  for (const item of incomingItems) {
    const fingerprint = loginHistoryFingerprint(item);
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    rows.push({
      ...item,
      rowKey: `${fingerprint}:${occurrence}`,
    });
  }

  return rows;
}

// Converts backend login-history failure codes into safe explanations for self-service display.
export function getLoginHistoryFailureExplanation(reason?: string) {
  const normalizedReason = reason?.trim().toUpperCase();

  switch (normalizedReason) {
    case undefined:
    case '': {
      return '-';
    }
    case 'INVALID_CREDENTIALS':
    case 'AUTH_INVALID_CREDENTIALS': {
      return '凭证验证失败';
    }
    case 'TERMINAL_ACCESS_DENIED':
    case 'AUTH_TERMINAL_ACCESS_DENIED': {
      return '终端准入策略拦截';
    }
    case 'AUTH_LOGIN_TEMPORARILY_LOCKED':
    case 'LOGIN_TEMPORARILY_LOCKED': {
      return '账号暂时锁定';
    }
    case 'AUTH_TERMINAL_LOGIN_FLOW_DISABLED':
    case 'TERMINAL_LOGIN_FLOW_DISABLED': {
      return '该终端暂不允许此登录方式';
    }
    case 'AUTH_MFA_REQUIRED':
    case 'MFA_REQUIRED': {
      return '需要完成二次验证';
    }
    default: {
      return '登录未完成';
    }
  }
}

// Serializes all available login-history identity facts without relying on a table row index.
function loginHistoryFingerprint(item: SelfSecurityApi.LoginHistoryItem) {
  return [
    item.traceId,
    item.occurredAt,
    item.outcome,
    item.loginMethod,
    item.terminal,
    item.loginFlow,
    item.ipAddress,
    item.deviceName,
    item.platform,
    item.browser,
    item.failureReason,
  ]
    .map((value) => encodeURIComponent(value?.trim() ?? ''))
    .join('|');
}

function buildLoginMethodGroup(
  loginMethods: SelfSecurityApi.LoginMethod[],
  definition: LoginMethodGroupDefinition,
): LoginMethodGroup {
  const passwordMethod = loginMethods.find(
    (item) => item.type === definition.passwordType,
  );
  const otpMethod = loginMethods.find((item) => item.type === definition.otpType);
  const representativeMethod = passwordMethod ?? otpMethod ?? null;
  const verified = Boolean(passwordMethod?.verified || otpMethod?.verified);
  const missingBindingHint = `需要先绑定并验证${definition.contactLabel}`;

  return {
    boundValue:
      representativeMethod?.maskedIdentifier ||
      representativeMethod?.identifier ||
      '',
    capabilities: [
      {
        actionDisabled: !passwordMethod?.methodId || !passwordMethod.hasPassword,
        disabledLabel: passwordMethod?.methodId ? '先设置密码' : `先绑定${definition.contactLabel}`,
        enabled: Boolean(passwordMethod?.enabled),
        hasPassword: Boolean(passwordMethod?.hasPassword),
        hint: !passwordMethod?.methodId
          ? missingBindingHint
          : passwordMethod.hasPassword
            ? ''
            : '需要先设置密码',
        label: '密码登录',
        methodId: passwordMethod?.methodId ?? '',
        type: definition.passwordType,
        verified: Boolean(passwordMethod?.verified),
      },
      {
        actionDisabled: !otpMethod?.methodId,
        disabledLabel: `先绑定${definition.contactLabel}`,
        enabled: Boolean(otpMethod?.enabled),
        hasPassword: false,
        hint: otpMethod?.methodId ? '' : missingBindingHint,
        label: '验证码登录',
        methodId: otpMethod?.methodId ?? '',
        type: definition.otpType,
        verified: Boolean(otpMethod?.verified),
      },
    ],
    emptyLabel: `暂未绑定${definition.contactLabel}`,
    kind: definition.kind,
    statusColor: representativeMethod ? (verified ? 'blue' : 'orange') : 'default',
    statusText: representativeMethod ? (verified ? '已验证' : '待验证') : '未绑定',
    title: definition.title,
  };
}

function buildTerminalPinLoginMethodGroup(
  loginMethods: SelfSecurityApi.LoginMethod[],
): LoginMethodGroup {
  const method = loginMethods.find((item) => item.type === 'TERMINAL_PIN') ?? null;

  return {
    boundValue: method ? (method.maskedIdentifier || method.identifier || '已设置') : '',
    capabilities: [
      {
        actionDisabled: !method?.methodId,
        disabledLabel: '先设置 PIN',
        enabled: Boolean(method?.enabled),
        hasPassword: false,
        hint: method?.methodId ? '' : '需要先在右侧设置终端 PIN',
        label: 'PIN 登录',
        methodId: method?.methodId ?? '',
        type: 'TERMINAL_PIN',
        verified: Boolean(method?.verified),
      },
    ],
    emptyLabel: '尚未设置 PIN',
    kind: 'terminalPin',
    statusColor: method ? (method.enabled ? 'blue' : 'orange') : 'default',
    statusText: method ? (method.enabled ? '已启用' : '已停用') : '未设置',
    title: '现场终端 PIN',
  };
}

function resolveGroupDefinition(kind: LoginMethodGroupKind): LoginMethodGroupDefinition {
  return LOGIN_METHOD_GROUP_DEFINITIONS.find((definition) => definition.kind === kind)!;
}

function resolveVerifiedContactIdentifier(
  loginMethods: SelfSecurityApi.LoginMethod[],
  kind: ContactBindingKind,
) {
  return resolveVerifiedContactMethod(loginMethods, kind)?.identifier || '';
}

function resolveVerifiedContactMethod(
  loginMethods: SelfSecurityApi.LoginMethod[],
  kind: ContactBindingKind,
) {
  const supportedTypes = resolveGroupDefinition(kind).supportedTypes;

  return loginMethods.find(
    (item) => item.verified && supportedTypes.has(item.type),
  );
}
