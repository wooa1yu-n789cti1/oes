import { describe, expect, it } from 'vitest';

import {
  buildLoginMethodGroups,
  getContactBindingActionLabel,
  getLoginHistoryFailureExplanation,
  getMfaAvailabilityHint,
  getMfaDisplayDestination,
  getSessionTerminalColor,
  getSessionTerminalLabel,
  isMfaEnableActionDisabled,
  mergeLoginHistoryTableRows,
  resolveMfaEnableFlow,
  resolveBoundContact,
  resolveCurrentUserDisplayIdentifier,
  validateContactBindingOtp,
  validateContactBindingValue,
} from './security-center.helpers';

describe('security center contact binding helpers', () => {
  it('resolves the current bound contact from verified login methods', () => {
    expect(
      resolveBoundContact(
        [
          {
            enabled: true,
            hasPassword: false,
            identifier: 'user@example.com',
            maskedIdentifier: 'u***@example.com',
            methodId: 'method-email',
            type: 'EMAIL_PASSWORD',
            userId: 'user-1',
            verified: true,
          },
          {
            enabled: true,
            hasPassword: false,
            identifier: '+8613811112222',
            maskedIdentifier: '+86 138****2222',
            methodId: 'method-phone',
            type: 'PHONE_OTP',
            userId: 'user-1',
            verified: true,
          },
        ],
        'email',
      ),
    ).toBe('u***@example.com');

    expect(
      resolveBoundContact(
        [
          {
            enabled: true,
            hasPassword: false,
            identifier: 'user@example.com',
            maskedIdentifier: 'u***@example.com',
            methodId: 'method-email',
            type: 'EMAIL_PASSWORD',
            userId: 'user-1',
            verified: true,
          },
          {
            enabled: true,
            hasPassword: false,
            identifier: '+8613811112222',
            maskedIdentifier: '+86 138****2222',
            methodId: 'method-phone',
            type: 'PHONE_OTP',
            userId: 'user-1',
            verified: true,
          },
        ],
        'phone',
      ),
    ).toBe('+86 138****2222');
  });

  it('returns context-aware action labels for first binding and replacement binding', () => {
    expect(getContactBindingActionLabel(undefined)).toBe('立即绑定');
    expect(getContactBindingActionLabel('u***@example.com')).toBe('更换绑定');
  });

  it('prefers verified email and then phone for the current user display identifier', () => {
    expect(
      resolveCurrentUserDisplayIdentifier([
        {
          enabled: true,
          hasPassword: false,
          identifier: '+8613811112222',
          maskedIdentifier: '+86 138****2222',
          methodId: 'method-phone',
          type: 'PHONE_OTP',
          userId: 'user-1',
          verified: true,
        },
        {
          enabled: true,
          hasPassword: false,
          identifier: 'user@example.com',
          maskedIdentifier: 'u***@example.com',
          methodId: 'method-email',
          type: 'EMAIL_PASSWORD',
          userId: 'user-1',
          verified: true,
        },
      ]),
    ).toBe('user@example.com');

    expect(
      resolveCurrentUserDisplayIdentifier([
        {
          enabled: true,
          hasPassword: false,
          identifier: '+8613811112222',
          maskedIdentifier: '+86 138****2222',
          methodId: 'method-phone',
          type: 'PHONE_OTP',
          userId: 'user-1',
          verified: true,
        },
      ]),
    ).toBe('+8613811112222');
  });

  it('validates email and phone values before requesting a challenge', () => {
    expect(validateContactBindingValue('email', '')).toBe('请输入邮箱地址');
    expect(validateContactBindingValue('email', 'invalid')).toBe('请输入有效的邮箱地址');
    expect(validateContactBindingValue('email', 'user@example.com')).toBe('');

    expect(validateContactBindingValue('phone', '')).toBe('请输入手机号');
    expect(validateContactBindingValue('phone', '1234')).toBe('请输入有效的手机号');
    expect(validateContactBindingValue('phone', '+8613811112222')).toBe('');
  });

  it('validates OTP format', () => {
    expect(validateContactBindingOtp('')).toBe('请输入验证码');
    expect(validateContactBindingOtp('123')).toBe('请输入 6 位验证码');
    expect(validateContactBindingOtp('123456')).toBe('');
  });

  it('groups login capabilities by channel for card-based rendering', () => {
    const groups = buildLoginMethodGroups([
      {
        enabled: true,
        hasPassword: true,
        identifier: 'user@example.com',
        maskedIdentifier: 'u***@example.com',
        methodId: 'email-method:PASSWORD',
        type: 'EMAIL_PASSWORD',
        userId: 'user-1',
        verified: true,
      },
      {
        enabled: false,
        hasPassword: false,
        identifier: 'user@example.com',
        maskedIdentifier: 'u***@example.com',
        methodId: 'email-method:OTP',
        type: 'EMAIL_OTP',
        userId: 'user-1',
        verified: true,
      },
      {
        enabled: false,
        hasPassword: false,
        identifier: '+8613811112222',
        maskedIdentifier: '+86 138****2222',
        methodId: 'phone-method:PASSWORD',
        type: 'PHONE_PASSWORD',
        userId: 'user-1',
        verified: false,
      },
      {
        enabled: true,
        hasPassword: false,
        identifier: '+8613811112222',
        maskedIdentifier: '+86 138****2222',
        methodId: 'phone-method:OTP',
        type: 'PHONE_OTP',
        userId: 'user-1',
        verified: false,
      },
      {
        enabled: true,
        hasPassword: false,
        identifier: 'terminal-pin',
        maskedIdentifier: '已设置',
        methodId: 'terminal-pin-method',
        type: 'TERMINAL_PIN',
        userId: 'user-1',
        verified: true,
      },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        boundValue: 'u***@example.com',
        kind: 'email',
        statusColor: 'blue',
        statusText: '已验证',
        title: '邮箱登录',
      }),
      expect.objectContaining({
        boundValue: '+86 138****2222',
        kind: 'phone',
        statusColor: 'orange',
        statusText: '待验证',
        title: '手机登录',
      }),
      expect.objectContaining({
        boundValue: '已设置',
        kind: 'terminalPin',
        statusColor: 'blue',
        statusText: '已启用',
        title: '现场终端 PIN',
      }),
    ]);

    expect(groups[0]?.capabilities).toEqual([
      expect.objectContaining({
        actionDisabled: false,
        enabled: true,
        hint: '',
        label: '密码登录',
      }),
      expect.objectContaining({
        actionDisabled: false,
        enabled: false,
        hint: '',
        label: '验证码登录',
      }),
    ]);
  });

  it('shows terminal pin as a first-class login method even when no pin has been set', () => {
    const groups = buildLoginMethodGroups([]);
    const terminalPinGroup = groups.find((group) => group.kind === 'terminalPin');

    expect(terminalPinGroup).toEqual(
      expect.objectContaining({
        boundValue: '',
        statusColor: 'default',
        statusText: '未设置',
        title: '现场终端 PIN',
      }),
    );
    expect(terminalPinGroup?.capabilities).toEqual([
      expect.objectContaining({
        actionDisabled: true,
        disabledLabel: '先设置 PIN',
        enabled: false,
        hint: '需要先在右侧设置终端 PIN',
        label: 'PIN 登录',
        methodId: '',
        type: 'TERMINAL_PIN',
        verified: false,
      }),
    ]);
  });

  it('disables uncreated login capabilities until the contact channel is bound', () => {
    const groups = buildLoginMethodGroups([
      {
        enabled: true,
        hasPassword: false,
        identifier: '+8613811112222',
        maskedIdentifier: '+86 138****2222',
        methodId: 'phone-method:OTP',
        type: 'PHONE_OTP',
        userId: 'user-1',
        verified: true,
      },
    ]);

    const emailGroup = groups.find((group) => group.kind === 'email');
    const emailOtpCapability = emailGroup?.capabilities.find(
      (capability) => capability.type === 'EMAIL_OTP',
    );

    expect(emailGroup).toEqual(
      expect.objectContaining({
        boundValue: '',
        statusText: '未绑定',
      }),
    );
    expect(emailOtpCapability).toEqual(
      expect.objectContaining({
        actionDisabled: true,
        hint: '需要先绑定并验证邮箱',
        methodId: '',
      }),
    );
  });

  it('explains why some mfa methods are currently unavailable', () => {
    expect(
      getMfaAvailabilityHint({
        available: false,
        bindingId: '',
        enabled: false,
        type: 'EMAIL_OTP',
      }),
    ).toBe('需要先绑定并验证邮箱');

    expect(
      getMfaAvailabilityHint({
        available: false,
        bindingId: '',
        enabled: false,
        type: 'SMS_OTP',
      }),
    ).toBe('需要先绑定并验证手机号');

    expect(
      getMfaAvailabilityHint({
        available: false,
        bindingId: '',
        enabled: false,
        type: 'BACKUP_CODE',
      }),
    ).toBe('需要先启用认证器 App');
  });

  it('returns clearer mfa destination labels for totp and recovery-code rows', () => {
    expect(
      getMfaDisplayDestination({
        available: true,
        bindingId: 'totp-1',
        enabled: true,
        type: 'TOTP',
      }),
    ).toBe('已绑定认证器 App');

    expect(
      getMfaDisplayDestination({
        available: true,
        bindingId: 'backup-1',
        enabled: false,
        type: 'BACKUP_CODE',
      }),
    ).toBe('尚未生成恢复码');
  });

  it('routes mfa enable actions through the correct setup flow', () => {
    expect(
      resolveMfaEnableFlow({
        available: true,
        bindingId: 'totp-1',
        enabled: false,
        type: 'TOTP',
      }),
    ).toBe('OPEN_TOTP_SETUP');

    expect(
      resolveMfaEnableFlow(
        {
          available: false,
          bindingId: 'backup-1',
          enabled: false,
          type: 'BACKUP_CODE',
        },
        {
          available: true,
          bindingId: 'totp-1',
          enabled: false,
          type: 'TOTP',
        },
      ),
    ).toBe('REQUIRE_TOTP_FIRST');

    expect(
      resolveMfaEnableFlow(
        {
          available: true,
          bindingId: 'backup-1',
          enabled: false,
          type: 'BACKUP_CODE',
        },
        {
          available: true,
          bindingId: 'totp-1',
          enabled: true,
          type: 'TOTP',
        },
      ),
    ).toBe('OPEN_RECOVERY_CODE_SETUP');

    expect(
      resolveMfaEnableFlow({
        available: true,
        bindingId: 'email-1',
        enabled: false,
        type: 'EMAIL_OTP',
      }),
    ).toBe('ENABLE_DIRECT');
  });

  it('keeps unavailable recovery-code enable actions clickable for prerequisite prompts', () => {
    expect(
      isMfaEnableActionDisabled({
        available: false,
        bindingId: 'backup-1',
        enabled: false,
        type: 'BACKUP_CODE',
      }),
    ).toBe(false);

    expect(
      isMfaEnableActionDisabled({
        available: false,
        bindingId: 'email-1',
        enabled: false,
        type: 'EMAIL_OTP',
      }),
    ).toBe(true);

    expect(
      isMfaEnableActionDisabled({
        available: false,
        bindingId: 'totp-1',
        enabled: true,
        type: 'TOTP',
      }),
    ).toBe(false);
  });

  it('maps session terminal codes to compact account-security labels', () => {
    expect(getSessionTerminalLabel('WEB')).toBe('Web');
    expect(getSessionTerminalLabel('PDA')).toBe('PDA');
    expect(getSessionTerminalLabel('KIOSK')).toBe('Kiosk');
    expect(getSessionTerminalLabel('INDUSTRIAL_TABLET')).toBe('工业平板');
    expect(getSessionTerminalLabel('future-terminal')).toBe('future-terminal');
    expect(getSessionTerminalLabel('')).toBe('未知终端');
  });

  it('maps session terminal codes to stable tag colors', () => {
    expect(getSessionTerminalColor('WEB')).toBe('blue');
    expect(getSessionTerminalColor('PDA')).toBe('green');
    expect(getSessionTerminalColor('KIOSK')).toBe('orange');
    expect(getSessionTerminalColor('MOBILE')).toBe('cyan');
    expect(getSessionTerminalColor('API_CLIENT')).toBe('geekblue');
    expect(getSessionTerminalColor('unknown-terminal')).toBe('default');
  });

  it('maps login-history failure reasons to user-facing explanations', () => {
    expect(getLoginHistoryFailureExplanation('INVALID_CREDENTIALS')).toBe(
      '凭证验证失败',
    );
    expect(getLoginHistoryFailureExplanation('TERMINAL_ACCESS_DENIED')).toBe(
      '终端准入策略拦截',
    );
    expect(getLoginHistoryFailureExplanation('AUTH_TERMINAL_ACCESS_DENIED')).toBe(
      '终端准入策略拦截',
    );
    expect(getLoginHistoryFailureExplanation('unexpected_internal_code')).toBe(
      '登录未完成',
    );
    expect(getLoginHistoryFailureExplanation()).toBe('-');
  });

  it('builds stable unique login-history row keys without Ant Design index arguments', () => {
    const duplicate = {
      occurredAt: '2026-09-15T08:00:00.000Z',
      outcome: 'FAILED' as const,
      loginMethod: 'PASSWORD',
      terminal: 'WEB',
    };
    const firstPage = mergeLoginHistoryTableRows([], [duplicate, duplicate], false);
    const repeatedFirstPage = mergeLoginHistoryTableRows([], [duplicate, duplicate], false);
    const appended = mergeLoginHistoryTableRows(firstPage, [duplicate], true);

    expect(firstPage.map(({ rowKey }) => rowKey)).toEqual(
      repeatedFirstPage.map(({ rowKey }) => rowKey),
    );
    expect(new Set(firstPage.map(({ rowKey }) => rowKey)).size).toBe(2);
    expect(appended.slice(0, 2).map(({ rowKey }) => rowKey)).toEqual(
      firstPage.map(({ rowKey }) => rowKey),
    );
    expect(new Set(appended.map(({ rowKey }) => rowKey)).size).toBe(3);
  });
});
