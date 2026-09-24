<script setup lang="ts">
import type { TableColumnsType } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';

import type { SelfSecurityApi } from '#/api';

import { computed, h, onActivated, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import { IconifyIcon } from '@vben/icons';
import { useUserStore } from '@vben/stores';

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Dropdown,
  Empty,
  Form,
  Input,
  Menu,
  message,
  Modal,
  QRCode,
  Select,
  Space,
  Statistic,
  Table,
  TabPane,
  Tabs,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  activateTotpBindingApi,
  changeOwnPasswordApi,
  disableMfaBindingApi,
  disableSelfLoginMethodApi,
  enableMfaBindingApi,
  enableSelfLoginMethodApi,
  initializeRecoveryCodesApi,
  initializeTotpBindingApi,
  listMfaBindingsApi,
  listSelfLoginHistoryApi,
  listSelfLoginMethodsApi,
  listSelfSessionsApi,
  listTrustedDevicesApi,
  logoutAllDevicesApi,
  logoutOtherDevicesApi,
  logoutSelfSessionApi,
  regenerateRecoveryCodesApi,
  resetOwnTerminalPinApi,
  revokeOtherTrustedDevicesApi,
  revokeTrustedDeviceApi,
  setOwnTerminalPinApi,
  setOwnTerminalPinEnabledApi,
} from '#/api';
import { useAuthStore } from '#/store';
import { useAuthContextStore } from '#/store/auth-context';
import { resolveAuthDeviceHints } from '#/utils/auth-device';

import SecurityContactBindingCard from './components/security-contact-binding-card.vue';
import SecurityStepUpMfaDialog from './components/security-step-up-mfa-dialog.vue';
import {
  buildLoginMethodGroups,
  getLoginHistoryFailureExplanation,
  getMfaAvailabilityHint,
  getMfaDisplayDestination,
  getSessionTerminalColor,
  getSessionTerminalLabel,
  isMfaEnableActionDisabled,
  type LoginHistoryTableRow,
  mergeLoginHistoryTableRows,
  resolveCurrentUserDisplayIdentifier,
  resolveMfaEnableFlow,
} from './security-center.helpers';

const authStore = useAuthStore();
const authContextStore = useAuthContextStore();
const operationColumnTitle = '操作';
type MfaActionKey = 'toggle';
type SessionActionKey = 'logout';
type SecurityTableKey = 'loginHistory' | 'mfa' | 'sessions';
type SessionColumnKey =
  | 'action'
  | 'device'
  | 'lastActiveAt'
  | 'loginMethod'
  | 'remaining'
  | 'status'
  | 'terminal';
type LoginHistoryColumnKey =
  | 'device'
  | 'failureReason'
  | 'ipAddress'
  | 'loginMethod'
  | 'occurredAt'
  | 'outcome'
  | 'terminal';
type MfaColumnKey = 'action' | 'destination' | 'status' | 'type' | 'updatedAt';

interface TableActionMenuItem<ActionKey extends string> {
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  key: ActionKey;
  label: string;
  testId?: string;
}

const userStore = useUserStore();
const { RangePicker } = DatePicker;

const activeTab = ref('login-methods');
const loading = ref(false);
const sessionMutationLoading = ref(false);
const loginMethodMutationLoading = ref(false);
const passwordMutationLoading = ref(false);
const terminalPinMutationLoading = ref(false);
const mfaMutationLoading = ref(false);
const totpMutationLoading = ref(false);
const recoveryCodeLoading = ref(false);
const loginHistoryLoading = ref(false);
const loginHistoryLoadingMore = ref(false);
const mfaBindingsLoading = ref(false);
const trustedDevicesLoading = ref(false);
const trustedDeviceMutationLoading = ref(false);
const sessions = ref<SelfSecurityApi.Session[]>([]);
const trustedDevices = ref<SelfSecurityApi.TrustedDevice[]>([]);
const loginHistoryItems = ref<LoginHistoryTableRow[]>([]);
const loginHistoryNextCursor = ref<null | string>(null);
const loginMethods = ref<SelfSecurityApi.LoginMethod[]>([]);
const passwordSetupRequired = ref(false);
const mfaBindings = ref<SelfSecurityApi.MfaBinding[]>([]);
const totpSetup = ref<null | SelfSecurityApi.InitializeTotpResult>(null);
const totpCode = ref('');
const totpSetupModalOpen = ref(false);
const recoveryCodes = ref<string[]>([]);
const recoveryCodeModalOpen = ref(false);
const stepUpMfaDialogRef = ref<null | {
  beginChallenge: (
    scenario: SelfSecurityApi.StepUpMfaScenario,
  ) => Promise<null | string>;
}>(null);
const sessionFilters = reactive({
  deviceQuery: '',
  status: '',
});

type LoginHistoryRangeValue = [string, string] | undefined;

const loginHistoryFilters = reactive<{
  occurredRange: LoginHistoryRangeValue;
  pageSize: number;
  result: '' | SelfSecurityApi.LoginHistoryOutcome;
}>({
  occurredRange: undefined,
  pageSize: 10,
  result: '',
});
const loginHistoryRangeValue = ref<LoginHistoryRangeValue>(undefined);
const passwordForm = reactive({
  confirmPassword: '',
  currentPassword: '',
  newPassword: '',
});
const terminalPinForm = reactive({
  confirmPin: '',
  currentPassword: '',
  enabled: true,
  newPin: '',
});
const terminalPinFormErrors = reactive({
  confirmPin: '',
  currentPassword: '',
  newPin: '',
});
const passwordFormErrors = reactive({
  confirmPassword: '',
  currentPassword: '',
  newPassword: '',
});
const sessionColumnMinWidths: Record<SessionColumnKey, number> = {
  action: 96,
  device: 220,
  lastActiveAt: 160,
  loginMethod: 130,
  remaining: 150,
  status: 140,
  terminal: 120,
};
const sessionColumnWidths = reactive<Record<SessionColumnKey, number>>({
  action: 120,
  device: 290,
  lastActiveAt: 200,
  loginMethod: 160,
  remaining: 180,
  status: 170,
  terminal: 140,
});
const loginHistoryColumnMinWidths: Record<LoginHistoryColumnKey, number> = {
  device: 220,
  failureReason: 220,
  ipAddress: 120,
  loginMethod: 130,
  occurredAt: 160,
  outcome: 100,
  terminal: 110,
};
const loginHistoryColumnWidths = reactive<Record<LoginHistoryColumnKey, number>>({
  device: 260,
  failureReason: 320,
  ipAddress: 150,
  loginMethod: 150,
  occurredAt: 180,
  outcome: 120,
  terminal: 130,
});
const mfaColumnMinWidths: Record<MfaColumnKey, number> = {
  action: 96,
  destination: 220,
  status: 160,
  type: 150,
  updatedAt: 160,
};
const mfaColumnWidths = reactive<Record<MfaColumnKey, number>>({
  action: 120,
  destination: 280,
  status: 200,
  type: 180,
  updatedAt: 180,
});
let activeSecurityColumnCleanup: null | (() => void) = null;

const currentSession = computed(() =>
  sessions.value.find((session) => session.isCurrent),
);

const enabledLoginMethodCount = computed(
  () => loginMethods.value.filter((method) => method.enabled).length,
);

const groupedLoginMethods = computed(() => buildLoginMethodGroups(loginMethods.value));

const activeSessions = computed(() =>
  sessions.value.filter((session) => !session.isRevoked),
);

const hasOtherSessions = computed(() =>
  sessions.value.some((session) => !session.isCurrent && !session.isRevoked),
);

const failedLoginHistoryCount = computed(
  () => loginHistoryItems.value.filter((item) => item.outcome === 'FAILED').length,
);
const sessionTableScrollX = computed(() =>
  Object.values(sessionColumnWidths).reduce((total, width) => total + width, 0),
);
const loginHistoryTableScrollX = computed(() =>
  Object.values(loginHistoryColumnWidths).reduce((total, width) => total + width, 0),
);
const mfaTableScrollX = computed(() =>
  Object.values(mfaColumnWidths).reduce((total, width) => total + width, 0),
);

const totpBinding = computed(
  () => mfaBindings.value.find((binding) => binding.type === 'TOTP') ?? null,
);

const recoveryCodeBinding = computed(
  () => mfaBindings.value.find((binding) => binding.type === 'BACKUP_CODE') ?? null,
);
const terminalPinLoginMethod = computed(
  () => loginMethods.value.find((method) => method.type === 'TERMINAL_PIN') ?? null,
);
const currentAuthDeviceId = resolveAuthDeviceHints()?.deviceId ?? '';
const normalizedTrustedDevices = computed(() =>
  trustedDevices.value.map((device) => ({
    ...device,
    isCurrentDevice: device.isCurrentDevice || device.deviceId === currentAuthDeviceId,
  })),
);
const hasOtherTrustedDevices = computed(() =>
  normalizedTrustedDevices.value.some((device) => !device.isCurrentDevice),
);

// Applies lightweight local filters so users can quickly narrow their own session list.
const filteredSessions = computed(() => {
  const deviceQuery = sessionFilters.deviceQuery.trim().toLowerCase();
  const status = sessionFilters.status.trim().toUpperCase();

  return sessions.value.filter((session) => {
    const sessionStatus = getSessionStatus(session);

    if (status && sessionStatus !== status) {
      return false;
    }

    if (!deviceQuery) {
      return true;
    }

    return [
      session.deviceName,
      session.platform,
      session.browser,
      session.userAgent,
      session.ipAddress,
      session.sessionId,
      session.terminal,
      session.terminalDeviceId,
    ]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(deviceQuery));
  });
});

const mfaTypeLabel: Record<SelfSecurityApi.MfaBindingType, string> = {
  BACKUP_CODE: '恢复码',
  EMAIL_OTP: '邮箱验证码',
  SMS_OTP: '手机验证码',
  TOTP: '认证器 App',
};

const loginMethodLabel: Record<string, string> = {
  'context-switch': '账号切换',
  EMAIL: '邮箱',
  EMAIL_OTP: '邮箱验证码',
  EMAIL_PASSWORD: '邮箱密码',
  PHONE: '手机',
  PHONE_OTP: '手机验证码',
  PHONE_PASSWORD: '手机密码',
  TERMINAL_PIN: '现场终端 PIN',
};

// Returns the mutable width state that owns one security-center Ant Table.
function getSecurityColumnWidths(tableKey: SecurityTableKey): Record<string, number> {
  switch (tableKey) {
    case 'loginHistory': {
      return loginHistoryColumnWidths;
    }
    case 'mfa': {
      return mfaColumnWidths;
    }
    case 'sessions':
    default: {
      return sessionColumnWidths;
    }
  }
}

// Returns the minimum width guardrails for one security-center Ant Table.
function getSecurityColumnMinWidths(tableKey: SecurityTableKey): Record<string, number> {
  switch (tableKey) {
    case 'loginHistory': {
      return loginHistoryColumnMinWidths;
    }
    case 'mfa': {
      return mfaColumnMinWidths;
    }
    case 'sessions':
    default: {
      return sessionColumnMinWidths;
    }
  }
}

// stopSecurityColumnResize clears drag listeners for all security-center local table resizers.
function stopSecurityColumnResize() {
  activeSecurityColumnCleanup?.();
  activeSecurityColumnCleanup = null;
  document.body.classList.remove('security-center--resizing-column');
}

// startSecurityColumnResize updates one table-owned column width from pointer movement.
function startSecurityColumnResize(
  event: MouseEvent,
  tableKey: SecurityTableKey,
  columnKey: string,
) {
  event.preventDefault();
  event.stopPropagation();

  stopSecurityColumnResize();

  const widths = getSecurityColumnWidths(tableKey);
  const minWidths = getSecurityColumnMinWidths(tableKey);
  const startX = event.clientX;
  const startWidth = widths[columnKey] ?? minWidths[columnKey] ?? 120;
  const minWidth = minWidths[columnKey] ?? 72;

  const handleMouseMove = (moveEvent: MouseEvent) => {
    widths[columnKey] = Math.max(
      minWidth,
      Math.round(startWidth + moveEvent.clientX - startX),
    );
  };

  const handleMouseUp = () => {
    stopSecurityColumnResize();
  };

  document.body.classList.add('security-center--resizing-column');
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp, { once: true });
  activeSecurityColumnCleanup = () => {
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
}

// renderResizableSecurityHeader exposes a local resize handle so global DOM resizing is bypassed.
function renderResizableSecurityHeader(
  tableKey: SecurityTableKey,
  columnKey: string,
  label: string,
) {
  return h('div', { class: 'security-center__resizable-title' }, [
    h('span', { class: 'security-center__resizable-title-text' }, label),
    h('span', {
      'aria-label': `调整${label}列宽`,
      class: 'security-center__column-resizer',
      onMousedown: (event: MouseEvent) =>
        startSecurityColumnResize(event, tableKey, columnKey),
      role: 'separator',
    }),
  ]);
}

const sessionColumns = computed<TableColumnsType<SelfSecurityApi.Session>>(() => [
  {
    key: 'device',
    title: renderResizableSecurityHeader('sessions', 'device', '设备'),
    width: sessionColumnWidths.device,
    ellipsis: true,
  },
  {
    key: 'loginMethod',
    title: renderResizableSecurityHeader('sessions', 'loginMethod', '登录方式'),
    width: sessionColumnWidths.loginMethod,
  },
  {
    key: 'terminal',
    title: renderResizableSecurityHeader('sessions', 'terminal', '终端'),
    width: sessionColumnWidths.terminal,
  },
  {
    key: 'status',
    title: renderResizableSecurityHeader('sessions', 'status', '状态'),
    width: sessionColumnWidths.status,
  },
  {
    key: 'lastActiveAt',
    title: renderResizableSecurityHeader('sessions', 'lastActiveAt', '最近活跃'),
    width: sessionColumnWidths.lastActiveAt,
  },
  {
    key: 'remaining',
    title: renderResizableSecurityHeader('sessions', 'remaining', '会话剩余'),
    width: sessionColumnWidths.remaining,
  },
  {
    fixed: 'right',
    key: 'action',
    title: renderResizableSecurityHeader('sessions', 'action', operationColumnTitle),
    width: sessionColumnWidths.action,
    align: 'center',
  },
]);

const loginHistoryColumns = computed<TableColumnsType<SelfSecurityApi.LoginHistoryItem>>(() => [
  {
    dataIndex: 'occurredAt',
    key: 'occurredAt',
    title: renderResizableSecurityHeader('loginHistory', 'occurredAt', '时间'),
    width: loginHistoryColumnWidths.occurredAt,
  },
  {
    key: 'outcome',
    title: renderResizableSecurityHeader('loginHistory', 'outcome', '结果'),
    width: loginHistoryColumnWidths.outcome,
  },
  {
    key: 'loginMethod',
    title: renderResizableSecurityHeader('loginHistory', 'loginMethod', '登录方式'),
    width: loginHistoryColumnWidths.loginMethod,
  },
  {
    key: 'terminal',
    title: renderResizableSecurityHeader('loginHistory', 'terminal', '终端'),
    width: loginHistoryColumnWidths.terminal,
  },
  {
    key: 'device',
    title: renderResizableSecurityHeader('loginHistory', 'device', '设备'),
    width: loginHistoryColumnWidths.device,
    ellipsis: true,
  },
  {
    dataIndex: 'ipAddress',
    key: 'ipAddress',
    title: renderResizableSecurityHeader('loginHistory', 'ipAddress', 'IP'),
    width: loginHistoryColumnWidths.ipAddress,
  },
  {
    key: 'failureReason',
    title: renderResizableSecurityHeader('loginHistory', 'failureReason', '说明'),
    width: loginHistoryColumnWidths.failureReason,
    ellipsis: true,
  },
]);

const mfaColumns = computed<TableColumnsType<SelfSecurityApi.MfaBinding>>(() => [
  {
    dataIndex: 'type',
    key: 'type',
    title: renderResizableSecurityHeader('mfa', 'type', 'MFA 方式'),
    width: mfaColumnWidths.type,
  },
  {
    dataIndex: 'destination',
    key: 'destination',
    title: renderResizableSecurityHeader('mfa', 'destination', '绑定目标'),
    width: mfaColumnWidths.destination,
    ellipsis: true,
  },
  {
    key: 'status',
    title: renderResizableSecurityHeader('mfa', 'status', '状态'),
    width: mfaColumnWidths.status,
  },
  {
    dataIndex: 'updatedAt',
    key: 'updatedAt',
    title: renderResizableSecurityHeader('mfa', 'updatedAt', '最近更新'),
    width: mfaColumnWidths.updatedAt,
  },
  {
    fixed: 'right',
    key: 'action',
    title: renderResizableSecurityHeader('mfa', 'action', operationColumnTitle),
    width: mfaColumnWidths.action,
    align: 'center',
  },
]);

// Exposes self-session row operations for the native Ant Design dropdown.
function getSessionActionItems(session: SelfSecurityApi.Session): TableActionMenuItem<SessionActionKey>[] {
  return [
    {
      danger: true,
      hidden: session.isCurrent || session.isRevoked,
      key: 'logout',
      label: '退出',
      testId: `security-session-logout-${session.sessionId}`,
    },
  ];
}

// Exposes MFA binding row operations for the native Ant Design dropdown.
function getMfaActionItems(binding: SelfSecurityApi.MfaBinding): TableActionMenuItem<MfaActionKey>[] {
  return [
    {
      disabled: isMfaEnableActionDisabled(binding),
      key: 'toggle',
      label: binding.enabled ? '停用' : '启用',
      testId: `security-mfa-toggle-${binding.type}`,
    },
  ];
}

// Filters hidden table actions before handing them to Ant Design Menu.
function getVisibleTableActionItems<ActionKey extends string>(items: TableActionMenuItem<ActionKey>[]) {
  return items.filter((item) => !item.hidden);
}

// Loads the signed-in user's current session list.
async function loadSessionsSnapshot() {
  const sessionResult = await listSelfSessionsApi();
  sessions.value = sessionResult.sessions ?? [];
}

// Loads the signed-in user's trusted-device list for the current tenant scope.
async function loadTrustedDeviceSnapshot(options?: { silent?: boolean }) {
  const silent = options?.silent ?? false;
  if (!silent) {
    trustedDevicesLoading.value = true;
  }

  try {
    const trustedDeviceResult = await listTrustedDevicesApi();
    trustedDevices.value = trustedDeviceResult.devices ?? [];
  } finally {
    if (!silent) {
      trustedDevicesLoading.value = false;
    }
  }
}

// Loads the signed-in user's current login-method snapshot.
async function loadLoginMethodSnapshot() {
  const loginMethodResult = await listSelfLoginMethodsApi();
  loginMethods.value = loginMethodResult.loginMethods ?? [];
  passwordSetupRequired.value = Boolean(loginMethodResult.passwordSetupRequired);
  syncCurrentUserDisplayIdentifier();
}

// Loads the signed-in user's MFA bindings without forcing unrelated sections into loading state.
async function loadMfaBindingsSnapshot(options?: { silent?: boolean }) {
  const silent = options?.silent ?? false;
  if (!silent) {
    mfaBindingsLoading.value = true;
  }

  try {
    const mfaResult = await listMfaBindingsApi();
    mfaBindings.value = mfaResult.bindings ?? [];
  } finally {
    if (!silent) {
      mfaBindingsLoading.value = false;
    }
  }
}

// Loads the full self-service security snapshot on first entry.
async function loadSecuritySnapshot() {
  loading.value = true;
  try {
    await Promise.all([
      loadSessionsSnapshot(),
      loadTrustedDeviceSnapshot({ silent: true }),
      loadLoginMethodSnapshot(),
      loadMfaBindingsSnapshot({ silent: true }),
    ]);
  } finally {
    loading.value = false;
  }
}

// Reloads the security read models when the cached page becomes active again.
async function reloadSecuritySnapshotOnResume() {
  await Promise.all([
    loadSessionsSnapshot(),
    loadTrustedDeviceSnapshot({ silent: true }),
    loadLoginMethodSnapshot(),
    loadMfaBindingsSnapshot({ silent: true }),
  ]);
}

// Loads the authenticated user's login-attempt history with cursor-based pagination.
async function loadLoginHistory(options?: { append?: boolean }) {
  const append = options?.append ?? false;

  if (append) {
    if (!loginHistoryNextCursor.value) {
      return;
    }
    loginHistoryLoadingMore.value = true;
  } else {
    loginHistoryLoading.value = true;
  }

  try {
    const result = await listSelfLoginHistoryApi({
      result: loginHistoryFilters.result || undefined,
      occurredAtFrom: loginHistoryFilters.occurredRange?.[0],
      occurredAtTo: loginHistoryFilters.occurredRange?.[1],
      cursor: append ? loginHistoryNextCursor.value ?? undefined : undefined,
      pageSize: loginHistoryFilters.pageSize,
    });

    loginHistoryItems.value = mergeLoginHistoryTableRows(
      loginHistoryItems.value,
      result.items ?? [],
      append,
    );
    loginHistoryNextCursor.value = result.nextCursor ?? null;
  } finally {
    loginHistoryLoading.value = false;
    loginHistoryLoadingMore.value = false;
  }
}

// Formats ISO timestamps for compact tables and side panels.
function formatDateTime(value?: string) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

// Converts a remaining duration into a readable label.
function formatDuration(seconds?: number) {
  if (seconds === undefined || seconds < 0) {
    return '-';
  }
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)} 小时`;
  }
  return `${Math.floor(seconds / 86_400)} 天`;
}

// Displays the most useful browser / device label for a session.
function getSessionDeviceLabel(session: SelfSecurityApi.Session) {
  return (
    session.deviceName ||
    [session.platform, session.browser].filter(Boolean).join(' / ') ||
    session.userAgent ||
    '未知设备'
  );
}

// Displays the most useful device label for one trusted-device card.
function getTrustedDeviceLabel(device: SelfSecurityApi.TrustedDevice) {
  return (
    device.deviceName
    || [device.browser, device.platform].filter(Boolean).join(' / ')
    || device.deviceId
  );
}

// Displays one compact environment summary for a trusted-device card.
function getTrustedDeviceEnvironment(device: SelfSecurityApi.TrustedDevice) {
  return [device.browser, device.platform].filter(Boolean).join(' / ') || '未识别环境';
}

// Maps backend login method codes to stable user-facing labels.
function getSessionLoginMethodLabel(session: SelfSecurityApi.Session) {
  return loginMethodLabel[session.loginMethod] || '账号登录';
}

// Maps login-history method codes to stable user-facing labels.
function getLoginHistoryMethodLabel(item: SelfSecurityApi.LoginHistoryItem) {
  return item.loginMethod ? loginMethodLabel[item.loginMethod] || item.loginMethod : '未知方式';
}

// Maps login method read-model type codes to concise labels.
function getLoginMethodTypeLabel(method: SelfSecurityApi.LoginMethod) {
  return loginMethodLabel[method.type] || method.type || '登录方式';
}

// Keeps the global header user identifier aligned with the latest verified self-service contact binding.
function syncCurrentUserDisplayIdentifier() {
  if (!userStore.userInfo) {
    return;
  }

  const nextIdentifier = resolveCurrentUserDisplayIdentifier(loginMethods.value);
  if (!nextIdentifier || nextIdentifier === userStore.userInfo.username) {
    return;
  }

  userStore.setUserInfo({
    ...userStore.userInfo,
    username: nextIdentifier,
  });
}

// Narrows one table row payload back to the expected session shape for template bindings.
function asSession(record: Record<string, any>) {
  return record as SelfSecurityApi.Session;
}

// Narrows one table row payload back to the expected login-history shape for template bindings.
function asLoginHistoryItem(record: Record<string, any>) {
  return record as SelfSecurityApi.LoginHistoryItem;
}

// Narrows one table row payload back to the expected MFA binding shape for template bindings.
function asMfaBinding(record: Record<string, any>) {
  return record as SelfSecurityApi.MfaBinding;
}

// Returns the product label for one MFA binding.
function getMfaBindingLabel(binding: SelfSecurityApi.MfaBinding) {
  return mfaTypeLabel[binding.type] ?? binding.type;
}

// Normalizes one session read-model into the unified table status.
function getSessionStatus(session: SelfSecurityApi.Session) {
  if (session.isRevoked) {
    return 'REVOKED';
  }

  if (session.isAccessExpired) {
    return 'EXPIRED';
  }

  return 'ACTIVE';
}

// Maps one session status code to the matching compact tag label.
function getSessionStatusLabel(status: string) {
  switch (status) {
    case 'ACTIVE': {
      return '活跃';
    }
    case 'EXPIRED': {
      return '已过期';
    }
    case 'REVOKED': {
      return '已撤销';
    }
    default: {
      return status || '未知';
    }
  }
}

// Maps one session status code to the shared visual tag color.
function getSessionStatusColor(status: string) {
  switch (status) {
    case 'ACTIVE': {
      return 'success';
    }
    case 'EXPIRED': {
      return 'orange';
    }
    case 'REVOKED': {
      return 'error';
    }
    default: {
      return 'default';
    }
  }
}

// Maps one login-history outcome to the shared visual tag color.
function getLoginHistoryOutcomeColor(outcome: SelfSecurityApi.LoginHistoryOutcome) {
  return outcome === 'FAILED' ? 'error' : 'success';
}

// Maps one login-history outcome to the shared compact label.
function getLoginHistoryOutcomeLabel(outcome: SelfSecurityApi.LoginHistoryOutcome) {
  return outcome === 'FAILED' ? '登录失败' : '登录成功';
}

// Maps one MFA binding to the shared visual status tag color.
function getMfaBindingStatusColor(binding: SelfSecurityApi.MfaBinding) {
  if (binding.enabled) {
    return 'success';
  }

  if (!binding.available) {
    return 'orange';
  }

  return 'default';
}

// Revokes one other active session after a user confirms the device-specific logout.
function confirmLogoutSession(session: SelfSecurityApi.Session) {
  Modal.confirm({
    centered: true,
    content: `“${getSessionDeviceLabel(session)}” 的会话将被立即退出，目标设备需要重新登录。`,
    okText: '退出此会话',
    okType: 'danger',
    title: '确认退出此会话？',
    async onOk() {
      sessionMutationLoading.value = true;
      try {
        await logoutSelfSessionApi(session.sessionId);
        message.success('已退出 1 个会话');
        await loadSessionsSnapshot();
      } finally {
        sessionMutationLoading.value = false;
      }
    },
  });
}

// Dispatches one self-session dropdown action.
function handleSessionAction(actionKey: SessionActionKey, session: SelfSecurityApi.Session) {
  if (actionKey === 'logout') {
    confirmLogoutSession(session);
  }
}

// Dispatches one MFA binding dropdown action.
async function handleMfaAction(actionKey: MfaActionKey, binding: SelfSecurityApi.MfaBinding) {
  if (actionKey === 'toggle') {
    await toggleMfaBinding(binding);
  }
}

// Revokes all other sessions and refreshes the session list.
function confirmLogoutOtherDevices() {
  Modal.confirm({
    centered: true,
    content: '当前账号下的其他设备会被立即退出，当前浏览器会保留登录状态。',
    okButtonProps: {
      disabled: !hasOtherSessions.value,
    },
    okText: '退出其他设备',
    title: '确认退出其他设备？',
    async onOk() {
      sessionMutationLoading.value = true;
      try {
        const result = await logoutOtherDevicesApi();
        message.success(`已退出 ${result.sessionCount ?? 0} 个其他会话`);
        await loadSessionsSnapshot();
      } finally {
        sessionMutationLoading.value = false;
      }
    },
  });
}

// Revokes one trusted device after a user confirms the future-login impact.
function confirmRevokeTrustedDevice(device: SelfSecurityApi.TrustedDevice) {
  Modal.confirm({
    centered: true,
    content: `撤销 “${getTrustedDeviceLabel(device)}” 后，该设备下次登录当前租户时需要重新完成新设备验证。`,
    okText: '撤销信任',
    okType: 'danger',
    title: '确认撤销此受信设备？',
    async onOk() {
      trustedDeviceMutationLoading.value = true;
      try {
        await revokeTrustedDeviceApi(device.id);
        message.success('已撤销 1 台受信设备');
        await loadTrustedDeviceSnapshot();
      } finally {
        trustedDeviceMutationLoading.value = false;
      }
    },
  });
}

// Revokes every other trusted device and keeps the current browser trust unchanged.
function confirmRevokeOtherTrustedDevices() {
  Modal.confirm({
    centered: true,
    content: '其他受信设备会被撤销信任，这些设备下次登录当前租户时需要重新完成新设备验证。',
    okButtonProps: {
      disabled: !hasOtherTrustedDevices.value,
    },
    okText: '撤销其他设备',
    okType: 'danger',
    title: '确认撤销其他受信设备？',
    async onOk() {
      trustedDeviceMutationLoading.value = true;
      try {
        const result = await revokeOtherTrustedDevicesApi();
        message.success(`已撤销 ${result.deviceCount ?? 0} 台其他受信设备`);
        await loadTrustedDeviceSnapshot();
      } finally {
        trustedDeviceMutationLoading.value = false;
      }
    },
  });
}

// Revokes all sessions and returns the user to the login page.
function confirmLogoutAllDevices() {
  Modal.confirm({
    centered: true,
    content: '当前账号下的所有设备都会被退出，包括当前浏览器。你需要重新登录才能继续使用。',
    okText: '全部退出',
    okType: 'danger',
    title: '确认退出全部设备？',
    async onOk() {
      sessionMutationLoading.value = true;
      try {
        await logoutAllDevicesApi();
        message.success('已退出全部设备');
        await authStore.logout(false);
      } finally {
        sessionMutationLoading.value = false;
      }
    },
  });
}

// Enables or disables one self-service MFA binding, opening setup modals when a factor requires configuration.
async function toggleMfaBinding(binding: SelfSecurityApi.MfaBinding) {
  if (!binding.enabled) {
    const enableFlow = resolveMfaEnableFlow(binding, totpBinding.value);

    if (enableFlow === 'OPEN_TOTP_SETUP') {
      await openTotpSetupModal();
      return;
    }

    if (enableFlow === 'REQUIRE_TOTP_FIRST') {
      message.warning('请先绑定并启用认证器 App 后再生成恢复码');
      return;
    }

    if (enableFlow === 'OPEN_RECOVERY_CODE_SETUP') {
      await openRecoveryCodeSetupModal();
      return;
    }
  }

  mfaMutationLoading.value = true;
  try {
    if (binding.enabled) {
      await disableMfaBindingApi(binding.type);
      message.success(`${mfaTypeLabel[binding.type]} 已停用`);
    } else {
      await enableMfaBindingApi(binding.type);
      message.success(`${mfaTypeLabel[binding.type]} 已启用`);
    }
    await loadMfaBindingsSnapshot({ silent: true });
  } finally {
    mfaMutationLoading.value = false;
  }
}

// Enables or disables one owned login method.
async function toggleLoginMethod(method: SelfSecurityApi.LoginMethod) {
  loginMethodMutationLoading.value = true;
  try {
    if (method.type === 'TERMINAL_PIN') {
      await setOwnTerminalPinEnabledApi({ enabled: !method.enabled });
      message.success(method.enabled ? '终端 PIN 已停用' : '终端 PIN 已启用');
    } else if (method.enabled) {
      await disableSelfLoginMethodApi(method.methodId);
      message.success(`${getLoginMethodTypeLabel(method)} 已停用`);
    } else {
      await enableSelfLoginMethodApi(method.methodId);
      message.success(`${getLoginMethodTypeLabel(method)} 已启用`);
    }
    await loadLoginMethodSnapshot();
  } finally {
    loginMethodMutationLoading.value = false;
  }
}

// Submits a self-service password change and clears password fields after success.
async function changeOwnPassword() {
  if (!validatePasswordForm()) {
    message.warning('请先修正密码表单中的校验问题');
    return;
  }

  passwordMutationLoading.value = true;
  try {
    const mfaGrantToken = await stepUpMfaDialogRef.value?.beginChallenge(
      'CHANGE_PASSWORD',
    );
    if (mfaGrantToken === null) {
      return;
    }

    const result = await changeOwnPasswordApi({
      currentPassword: passwordForm.currentPassword,
      mfaGrantToken: mfaGrantToken || undefined,
      newPassword: passwordForm.newPassword,
    });
    passwordSetupRequired.value = Boolean(result.passwordSetupRequired);
    passwordForm.confirmPassword = '';
    passwordForm.currentPassword = '';
    passwordForm.newPassword = '';
    resetPasswordFormErrors();
    message.success('密码已更新');
    await loadLoginMethodSnapshot();
  } finally {
    passwordMutationLoading.value = false;
  }
}

function validatePasswordForm() {
  resetPasswordFormErrors();

  if (!passwordForm.currentPassword) {
    passwordFormErrors.currentPassword = '请输入当前密码';
  }

  if (!passwordForm.newPassword) {
    passwordFormErrors.newPassword = '请输入新密码';
  } else if (passwordForm.newPassword.length < 8) {
    passwordFormErrors.newPassword = '新密码至少需要 8 位';
  } else if (!/[A-Za-z]/.test(passwordForm.newPassword) || !/\d/.test(passwordForm.newPassword)) {
    passwordFormErrors.newPassword = '新密码需同时包含字母和数字';
  } else if (passwordForm.newPassword === passwordForm.currentPassword) {
    passwordFormErrors.newPassword = '新密码不能与当前密码相同';
  }

  if (!passwordForm.confirmPassword) {
    passwordFormErrors.confirmPassword = '请再次输入新密码';
  } else if (passwordForm.confirmPassword !== passwordForm.newPassword) {
    passwordFormErrors.confirmPassword = '两次输入的新密码不一致';
  }

  return !Object.values(passwordFormErrors).some(Boolean);
}

function resetPasswordFormErrors() {
  passwordFormErrors.confirmPassword = '';
  passwordFormErrors.currentPassword = '';
  passwordFormErrors.newPassword = '';
}

async function saveOwnTerminalPin(action: 'reset' | 'set') {
  if (!validateTerminalPinForm()) {
    message.warning('请先修正终端 PIN 表单中的校验问题');
    return;
  }

  terminalPinMutationLoading.value = true;
  try {
    const mfaGrantToken = await stepUpMfaDialogRef.value?.beginChallenge(
      'CHANGE_PASSWORD',
    );
    if (mfaGrantToken === null) {
      return;
    }

    const payload = {
      currentPassword: terminalPinForm.currentPassword,
      mfaGrantToken: mfaGrantToken || undefined,
      newPin: terminalPinForm.newPin,
    };
    if (action === 'reset') {
      await resetOwnTerminalPinApi(payload);
    } else {
      await setOwnTerminalPinApi(payload);
    }

    terminalPinForm.confirmPin = '';
    terminalPinForm.currentPassword = '';
    terminalPinForm.newPin = '';
    resetTerminalPinFormErrors();
    message.success(action === 'reset' ? '终端 PIN 已重设' : '终端 PIN 已设置');
    await loadLoginMethodSnapshot();
  } finally {
    terminalPinMutationLoading.value = false;
  }
}

async function toggleOwnTerminalPinEnabled() {
  terminalPinMutationLoading.value = true;
  try {
    await setOwnTerminalPinEnabledApi({
      enabled: !terminalPinLoginMethod.value?.enabled,
    });
    message.success(terminalPinLoginMethod.value?.enabled ? '终端 PIN 已停用' : '终端 PIN 已启用');
    await loadLoginMethodSnapshot();
  } finally {
    terminalPinMutationLoading.value = false;
  }
}

function validateTerminalPinForm() {
  resetTerminalPinFormErrors();

  if (!terminalPinForm.currentPassword) {
    terminalPinFormErrors.currentPassword = '请输入当前密码';
  }
  if (!/^\d{6}$/.test(terminalPinForm.newPin)) {
    terminalPinFormErrors.newPin = '终端 PIN 必须是 6 位数字';
  } else if (['000000', '111111', '123456', '654321'].includes(terminalPinForm.newPin)) {
    terminalPinFormErrors.newPin = '请避免使用过于简单的 PIN';
  }
  if (terminalPinForm.confirmPin !== terminalPinForm.newPin) {
    terminalPinFormErrors.confirmPin = '两次输入的 PIN 不一致';
  }

  return !Object.values(terminalPinFormErrors).some(Boolean);
}

function resetTerminalPinFormErrors() {
  terminalPinFormErrors.confirmPin = '';
  terminalPinFormErrors.currentPassword = '';
  terminalPinFormErrors.newPin = '';
}

// Opens the TOTP setup modal and initializes a fresh enrollment secret when needed.
async function openTotpSetupModal() {
  totpSetupModalOpen.value = true;
  if (!totpSetup.value) {
    await initializeTotp({ showSuccessMessage: false });
  }
}

// Closes the TOTP setup modal and clears pending local input from the screen.
function closeTotpSetupModal() {
  totpSetupModalOpen.value = false;
  totpSetup.value = null;
  totpCode.value = '';
}

// Opens the recovery-code modal, enforcing the TOTP prerequisite before generation.
async function openRecoveryCodeSetupModal() {
  if (!totpBinding.value?.enabled) {
    message.warning('请先绑定并启用认证器 App 后再生成恢复码');
    return;
  }

  recoveryCodes.value = [];
  recoveryCodeModalOpen.value = true;
  await generateRecoveryCodesFromModal();
}

// Closes the recovery-code modal and clears one-time code display from local state.
function closeRecoveryCodeModal() {
  recoveryCodeModalOpen.value = false;
  recoveryCodes.value = [];
}

// Generates the first recovery-code set or rotates an existing set from inside the modal.
async function generateRecoveryCodesFromModal() {
  await refreshRecoveryCodes(!recoveryCodeBinding.value?.enabled);
}

// Starts the TOTP enrollment flow and keeps the secret visible until activation.
async function initializeTotp(options?: { showSuccessMessage?: boolean }) {
  totpMutationLoading.value = true;
  try {
    totpSetup.value = await initializeTotpBindingApi();
    totpCode.value = '';
    if (options?.showSuccessMessage ?? true) {
      message.success('认证器初始化成功，请扫码并输入验证码完成绑定');
    }
  } finally {
    totpMutationLoading.value = false;
  }
}

// Activates a pending TOTP binding.
async function activateTotp() {
  if (!totpSetup.value?.binding.bindingId || !totpCode.value.trim()) {
    message.warning('请输入认证器 App 中的验证码');
    return;
  }

  totpMutationLoading.value = true;
  try {
    await activateTotpBindingApi({
      bindingId: totpSetup.value.binding.bindingId,
      code: totpCode.value.trim(),
    });
    totpSetup.value = null;
    totpCode.value = '';
    totpSetupModalOpen.value = false;
    message.success('认证器 App 已绑定');
    await loadMfaBindingsSnapshot({ silent: true });
  } finally {
    totpMutationLoading.value = false;
  }
}

// Generates or rotates recovery codes and keeps them visible for the current page session.
async function refreshRecoveryCodes(initial: boolean) {
  recoveryCodeLoading.value = true;
  try {
    const result = initial
      ? await initializeRecoveryCodesApi()
      : await regenerateRecoveryCodesApi();
    recoveryCodes.value = result.recoveryCodes ?? [];
    message.success(initial ? '恢复码已生成' : '恢复码已重新生成');
    await loadMfaBindingsSnapshot({ silent: true });
  } finally {
    recoveryCodeLoading.value = false;
  }
}

// Stores the selected login-history time range as a stable ISO tuple.
function handleLoginHistoryRangeChange(
  values: [Dayjs, Dayjs] | [string, string] | null,
) {
  if (!values || values.length !== 2) {
    loginHistoryRangeValue.value = undefined;
    loginHistoryFilters.occurredRange = undefined;
    return;
  }

  loginHistoryRangeValue.value = [String(values[0]), String(values[1])];
  loginHistoryFilters.occurredRange = [String(values[0]), String(values[1])];
}

// Restores the login-history filters to the first-page defaults.
function resetLoginHistoryFilters() {
  loginHistoryFilters.result = '';
  loginHistoryFilters.occurredRange = undefined;
  loginHistoryFilters.pageSize = 10;
  loginHistoryRangeValue.value = undefined;
}

onMounted(() => {
  void Promise.all([loadSecuritySnapshot(), loadLoginHistory()]).catch(() => {
    sessions.value = [];
    trustedDevices.value = [];
    loginHistoryItems.value = [];
    loginHistoryNextCursor.value = null;
    loginMethods.value = [];
    passwordSetupRequired.value = false;
    mfaBindings.value = [];
  });
});

onActivated(() => {
  void reloadSecuritySnapshotOnResume().catch(() => {
    message.error('刷新账户安全信息失败');
  });
});

onBeforeUnmount(() => {
  stopSecurityColumnResize();
});

watch(activeTab, (tab) => {
  if (tab !== 'trusted-devices') {
    return;
  }

  void loadTrustedDeviceSnapshot({ silent: true }).catch(() => {
    message.error('刷新受信设备失败');
  });
});
</script>

<template>
  <div class="security-center-page space-y-5 p-5">
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card :bordered="false" class="summary-card">
        <Statistic title="当前安全范围" :value="authContextStore.scopeLabel" />
        <p class="summary-card__meta">
          {{ authContextStore.accountName || authContextStore.operatorName || '当前账号' }}
        </p>
      </Card>
      <Card :bordered="false" class="summary-card">
        <Statistic title="当前账号会话" :value="activeSessions.length" />
        <p class="summary-card__meta">
          当前会话：{{ currentSession?.sessionId || '-' }}
        </p>
      </Card>
      <Card :bordered="false" class="summary-card">
        <Statistic title="已启用登录方式" :value="enabledLoginMethodCount" />
        <p class="summary-card__meta">
          密码设置：{{ passwordSetupRequired ? '需要设置' : '正常' }}
        </p>
      </Card>
      <Card :bordered="false" class="summary-card">
        <Statistic title="失败登录记录" :value="failedLoginHistoryCount" />
        <p class="summary-card__meta">
          最近加载登录历史 {{ loginHistoryItems.length }} 条
        </p>
      </Card>
    </div>

    <Card :bordered="false" class="content-surface">
      <Tabs v-model:active-key="activeTab">
        <TabPane key="login-methods" tab="登录方式">
          <div class="tab-grid">
            <div class="side-card-stack">
              <div class="binding-card-grid">
                <SecurityContactBindingCard
                  kind="email"
                  :login-methods="loginMethods"
                  @refreshed="loadSecuritySnapshot"
                />

                <SecurityContactBindingCard
                  kind="phone"
                  :login-methods="loginMethods"
                  @refreshed="loadSecuritySnapshot"
                />
              </div>

              <Card :bordered="false" class="section-card">
                <div class="panel-caption">
                  <span class="panel-caption__title">登录方式管理</span>
                  <span class="panel-caption__meta">
                    登录能力已按邮箱/手机/终端 PIN 分组展示；密码、验证码与 PIN 现在可分别启用或停用。
                  </span>
                </div>

                <Empty
                  v-if="!loading && groupedLoginMethods.length === 0"
                  description="暂无可管理的登录方式"
                />

                <div v-else class="login-method-group-grid">
                  <div
                    v-for="group in groupedLoginMethods"
                    :key="group.kind"
                    class="login-method-group-card"
                  >
                    <div class="login-method-group-card__header">
                      <div>
                        <div class="login-method-group-card__title">
                          {{ group.title }}
                        </div>
                        <div class="login-method-group-card__meta">
                          {{ group.boundValue || group.emptyLabel }}
                        </div>
                      </div>
                      <Tag :color="group.statusColor">
                        {{ group.statusText }}
                      </Tag>
                    </div>

                    <div class="login-method-capability-list">
                      <div
                        v-for="capability in group.capabilities"
                        :key="capability.methodId || capability.type"
                        class="login-method-capability-item"
                      >
                        <div class="login-method-capability-item__body">
                          <div class="login-method-capability-item__title-row">
                            <span class="login-method-capability-item__title">
                              {{ capability.label }}
                            </span>
                            <Tag :color="capability.enabled ? 'green' : 'default'">
                              {{ capability.enabled ? '已启用' : '已停用' }}
                            </Tag>
                          </div>
                          <div v-if="capability.hint" class="table-cell-meta">
                            {{ capability.hint }}
                          </div>
                        </div>

                        <div class="login-method-capability-item__action-cell">
                          <Button
                            v-if="capability.actionDisabled"
                            class="login-method-capability-item__action"
                            disabled
                            size="small"
                          >
                            {{ capability.disabledLabel }}
                          </Button>
                          <Button
                            v-else
                            class="login-method-capability-item__action"
                            :disabled="capability.enabled && enabledLoginMethodCount <= 1"
                            :loading="loginMethodMutationLoading"
                            size="small"
                            @click="
                              toggleLoginMethod({
                                enabled: capability.enabled,
                                hasPassword: capability.hasPassword,
                                methodId: capability.methodId,
                                type: capability.type,
                                userId: '',
                                verified: capability.verified,
                              })
                            "
                          >
                            {{ capability.enabled ? '停用' : '启用' }}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>

            <div class="side-card-stack">
              <Card :bordered="false" class="section-card side-card">
                <div class="panel-caption">
                  <span class="panel-caption__title">修改密码</span>
                  <span class="panel-caption__meta">
                    {{ passwordSetupRequired ? '当前需要设置密码' : '密码状态正常' }}
                  </span>
                </div>
                <Form layout="vertical" class="form-stack">
                  <Form.Item
                    label="当前密码"
                    :help="passwordFormErrors.currentPassword || undefined"
                    :validate-status="passwordFormErrors.currentPassword ? 'error' : undefined"
                  >
                    <Input.Password
                      v-model:value="passwordForm.currentPassword"
                      autocomplete="current-password"
                      placeholder="请输入当前密码"
                    />
                  </Form.Item>
                  <Form.Item
                    label="新密码"
                    :help="passwordFormErrors.newPassword || undefined"
                    :validate-status="passwordFormErrors.newPassword ? 'error' : undefined"
                  >
                    <Input.Password
                      v-model:value="passwordForm.newPassword"
                      autocomplete="new-password"
                      placeholder="请输入新密码"
                    />
                  </Form.Item>
                  <Form.Item
                    label="确认新密码"
                    :help="passwordFormErrors.confirmPassword || undefined"
                    :validate-status="passwordFormErrors.confirmPassword ? 'error' : undefined"
                  >
                    <Input.Password
                      v-model:value="passwordForm.confirmPassword"
                      autocomplete="new-password"
                      placeholder="请再次输入新密码"
                    />
                  </Form.Item>
                  <div class="security-form-actions">
                    <Button
                      class="security-form-action-button"
                      type="primary"
                      :loading="passwordMutationLoading"
                      @click="changeOwnPassword"
                    >
                      更新密码
                    </Button>
                  </div>
                </Form>
              </Card>

              <Card :bordered="false" class="section-card side-card">
                <div class="panel-caption">
                  <span class="panel-caption__title">现场终端 PIN</span>
                  <span class="panel-caption__meta">
                    {{ terminalPinLoginMethod?.enabled ? '已启用' : terminalPinLoginMethod ? '已停用' : '未设置' }}
                  </span>
                </div>
                <Form layout="vertical" class="form-stack">
                  <Form.Item
                    label="当前密码"
                    :help="terminalPinFormErrors.currentPassword || undefined"
                    :validate-status="terminalPinFormErrors.currentPassword ? 'error' : undefined"
                  >
                    <Input.Password
                      v-model:value="terminalPinForm.currentPassword"
                      autocomplete="current-password"
                      placeholder="用于确认本人操作"
                    />
                  </Form.Item>
                  <Form.Item
                    label="新终端 PIN"
                    :help="terminalPinFormErrors.newPin || undefined"
                    :validate-status="terminalPinFormErrors.newPin ? 'error' : undefined"
                  >
                    <Input.Password
                      v-model:value="terminalPinForm.newPin"
                      autocomplete="new-password"
                      :maxlength="6"
                      placeholder="6 位数字"
                    />
                  </Form.Item>
                  <Form.Item
                    label="确认终端 PIN"
                    :help="terminalPinFormErrors.confirmPin || undefined"
                    :validate-status="terminalPinFormErrors.confirmPin ? 'error' : undefined"
                  >
                    <Input.Password
                      v-model:value="terminalPinForm.confirmPin"
                      autocomplete="new-password"
                      :maxlength="6"
                      placeholder="再次输入 6 位数字"
                    />
                  </Form.Item>
                  <div class="security-form-actions">
                    <Button
                      class="security-form-action-button"
                      type="primary"
                      :loading="terminalPinMutationLoading"
                      @click="saveOwnTerminalPin(terminalPinLoginMethod ? 'reset' : 'set')"
                    >
                      {{ terminalPinLoginMethod ? '重设终端 PIN' : '设置终端 PIN' }}
                    </Button>
                    <Button
                      v-if="terminalPinLoginMethod"
                      class="security-form-action-button"
                      :loading="terminalPinMutationLoading"
                      @click="toggleOwnTerminalPinEnabled"
                    >
                      {{ terminalPinLoginMethod.enabled ? '停用终端 PIN 登录' : '启用终端 PIN 登录' }}
                    </Button>
                  </div>
                </Form>
              </Card>
            </div>
          </div>
        </TabPane>

        <TabPane key="sessions" tab="会话管理">
          <Card :bordered="false" class="section-card">
            <div class="security-toolbar">
              <div class="security-toolbar__filters">
                <Select
                  v-model:value="sessionFilters.status"
                  allow-clear
                  class="toolbar-control toolbar-control--compact"
                  placeholder="状态"
                >
                  <Select.Option value="ACTIVE">活跃</Select.Option>
                  <Select.Option value="EXPIRED">已过期</Select.Option>
                  <Select.Option value="REVOKED">已撤销</Select.Option>
                </Select>
                <Input
                  v-model:value="sessionFilters.deviceQuery"
                  class="toolbar-control toolbar-control--wide"
                  placeholder="按设备、终端、浏览器、平台、IP 或会话 ID 过滤"
                />
                <Button
                  @click="
                    sessionFilters.status = '';
                    sessionFilters.deviceQuery = '';
                  "
                >
                  清空筛选
                </Button>
              </div>
              <div class="security-toolbar__actions">
                <Button :loading="loading" @click="loadSecuritySnapshot">
                  刷新
                </Button>
                <Button
                  :disabled="!hasOtherSessions"
                  :loading="sessionMutationLoading"
                  @click="confirmLogoutOtherDevices"
                >
                  退出其他设备
                </Button>
                <Button
                  danger
                  :loading="sessionMutationLoading"
                  @click="confirmLogoutAllDevices"
                >
                  全部退出
                </Button>
              </div>
            </div>

            <Table
              :columns="sessionColumns"
              :data-source="filteredSessions"
              :loading="loading"
              :pagination="false"
              :scroll="{ x: sessionTableScrollX }"
              class="security-table"
              row-key="sessionId"
              size="middle"
            >
              <template #emptyText>
                <Empty description="暂无会话数据" />
              </template>
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'device'">
                  <div class="table-cell-title">
                    {{ getSessionDeviceLabel(asSession(record)) }}
                  </div>
                  <div class="table-cell-meta">
                    {{ record.ipAddress || '未知 IP' }} · {{ record.sessionId }}
                  </div>
                </template>
                <template v-else-if="column.key === 'loginMethod'">
                  <div class="table-cell-title">
                    {{ getSessionLoginMethodLabel(asSession(record)) }}
                  </div>
                  <div class="table-cell-meta">
                    {{ [record.platform, record.browser].filter(Boolean).join(' / ') || '未识别环境' }}
                  </div>
                </template>
                <template v-else-if="column.key === 'terminal'">
                  <div class="table-cell-title">
                    <Tag :color="getSessionTerminalColor(record.terminal)">
                      {{ getSessionTerminalLabel(record.terminal) }}
                    </Tag>
                  </div>
                  <div class="table-cell-meta">
                    {{ record.terminalDeviceId ? `设备 ${record.terminalDeviceId}` : '未关联受管终端设备' }}
                  </div>
                </template>
                <template v-else-if="column.key === 'status'">
                  <div class="tag-stack">
                    <Tag :color="getSessionStatusColor(getSessionStatus(asSession(record)))">
                      {{ getSessionStatusLabel(getSessionStatus(asSession(record))) }}
                    </Tag>
                    <Tag v-if="record.isCurrent" color="blue">当前设备</Tag>
                  </div>
                </template>
                <template v-else-if="column.key === 'lastActiveAt'">
                  <div class="table-cell-title">
                    {{ formatDateTime(record.lastActiveAt) }}
                  </div>
                  <div class="table-cell-meta">
                    创建于 {{ formatDateTime(record.createdAt) }}
                  </div>
                </template>
                <template v-else-if="column.key === 'remaining'">
                  <div class="table-cell-title">
                    Access {{ formatDuration(record.accessRemainingSeconds) }}
                  </div>
                  <div class="table-cell-meta">
                    Refresh {{ formatDuration(record.refreshRemainingSeconds) }}
                  </div>
                </template>
                <template v-else-if="column.key === 'action'">
                  <Dropdown
                    v-if="getVisibleTableActionItems(getSessionActionItems(asSession(record))).length > 0"
                    :trigger="['click']"
                  >
                    <Button aria-label="会话操作" shape="circle" size="small" type="text">
                      <IconifyIcon icon="ant-design:more-outlined" />
                    </Button>
                    <template #overlay>
                      <Menu @click="(info) => handleSessionAction(String(info.key) as SessionActionKey, asSession(record))">
                        <Menu.Item
                          v-for="item in getVisibleTableActionItems(getSessionActionItems(asSession(record)))"
                          :key="item.key"
                          :danger="item.danger"
                          :data-testid="item.testId"
                          :disabled="item.disabled"
                        >
                          {{ item.label }}
                        </Menu.Item>
                      </Menu>
                    </template>
                  </Dropdown>
                  <span v-else class="tenant-table-action-empty">-</span>
                </template>
              </template>
            </Table>
          </Card>
        </TabPane>

        <TabPane key="trusted-devices" tab="受信设备">
          <Card :bordered="false" class="section-card">
            <div class="security-toolbar">
              <div class="panel-caption">
                <span class="panel-caption__title">受信设备</span>
                <span class="panel-caption__meta">
                  这里管理的是长期信任设备，不等同于当前在线会话；撤销后只影响下次登录时的新设备验证。
                </span>
              </div>
              <div class="security-toolbar__actions">
                <Button :loading="trustedDevicesLoading" @click="loadTrustedDeviceSnapshot()">
                  刷新
                </Button>
                <Button
                  danger
                  :disabled="!hasOtherTrustedDevices"
                  :loading="trustedDeviceMutationLoading"
                  @click="confirmRevokeOtherTrustedDevices"
                >
                  撤销其他设备
                </Button>
              </div>
            </div>

            <Empty
              v-if="!trustedDevicesLoading && normalizedTrustedDevices.length === 0"
              description="暂无受信设备"
            />

            <div v-else class="trusted-device-grid">
              <div
                v-for="device in normalizedTrustedDevices"
                :key="device.id"
                class="trusted-device-card"
              >
                <div class="trusted-device-card__header">
                  <div>
                    <div class="table-cell-title">
                      {{ getTrustedDeviceLabel(device) }}
                    </div>
                    <div class="table-cell-meta">
                      {{ getTrustedDeviceEnvironment(device) }}
                    </div>
                  </div>
                  <div class="tag-stack">
                    <Tag v-if="device.isCurrentDevice" color="blue">当前设备</Tag>
                    <Tag color="green">受信中</Tag>
                  </div>
                </div>

                <div class="trusted-device-card__meta-list">
                  <div class="trusted-device-card__meta-item">
                    <span class="trusted-device-card__meta-label">首次信任</span>
                    <span class="trusted-device-card__meta-value">
                      {{ formatDateTime(device.trustedAt) }}
                    </span>
                  </div>
                  <div class="trusted-device-card__meta-item">
                    <span class="trusted-device-card__meta-label">最近活跃</span>
                    <span class="trusted-device-card__meta-value">
                      {{ formatDateTime(device.lastActiveAt) }}
                    </span>
                  </div>
                  <div class="trusted-device-card__meta-item">
                    <span class="trusted-device-card__meta-label">到期时间</span>
                    <span class="trusted-device-card__meta-value">
                      {{ formatDateTime(device.expiresAt) }}
                    </span>
                  </div>
                </div>

                <div class="trusted-device-card__footer">
                  <span class="table-cell-meta">
                    设备 ID：{{ device.deviceId }}
                  </span>
                  <Button
                    danger
                    size="small"
                    :loading="trustedDeviceMutationLoading"
                    @click="confirmRevokeTrustedDevice(device)"
                  >
                    撤销信任
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </TabPane>

        <TabPane key="login-history" tab="登录历史">
          <Card :bordered="false" class="section-card">
            <div class="security-toolbar">
              <div class="security-toolbar__filters">
                <Select
                  v-model:value="loginHistoryFilters.result"
                  allow-clear
                  class="toolbar-control toolbar-control--compact"
                  placeholder="结果"
                >
                  <Select.Option value="SUCCESS">登录成功</Select.Option>
                  <Select.Option value="FAILED">登录失败</Select.Option>
                </Select>
                <RangePicker
                  v-model:value="loginHistoryRangeValue"
                  class="toolbar-control toolbar-control--range"
                  show-time
                  value-format="YYYY-MM-DDTHH:mm:ss[Z]"
                  @change="handleLoginHistoryRangeChange"
                />
                <div class="security-toolbar__filter-actions">
                  <Button type="primary" :loading="loginHistoryLoading" @click="loadLoginHistory()">
                    查询
                  </Button>
                  <Button
                    @click="
                      resetLoginHistoryFilters();
                      loadLoginHistory();
                    "
                  >
                    重置
                  </Button>
                </div>
              </div>
            </div>

            <Table
              :columns="loginHistoryColumns"
              :data-source="loginHistoryItems"
              :loading="loginHistoryLoading"
              :pagination="false"
              :scroll="{ x: loginHistoryTableScrollX }"
              class="security-table"
              row-key="rowKey"
              size="middle"
            >
              <template #emptyText>
                <Empty description="暂无登录历史" />
              </template>
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'occurredAt'">
                  {{ formatDateTime(record.occurredAt) }}
                </template>
                <template v-else-if="column.key === 'outcome'">
                  <Tag :color="getLoginHistoryOutcomeColor(record.outcome)">
                    {{ getLoginHistoryOutcomeLabel(record.outcome) }}
                  </Tag>
                </template>
                <template v-else-if="column.key === 'loginMethod'">
                  {{ getLoginHistoryMethodLabel(asLoginHistoryItem(record)) }}
                </template>
                <template v-else-if="column.key === 'terminal'">
                  <Tag :color="getSessionTerminalColor(record.terminal)">
                    {{ getSessionTerminalLabel(record.terminal) }}
                  </Tag>
                </template>
                <template v-else-if="column.key === 'device'">
                  <div class="table-cell-title">
                    {{ record.deviceName || [record.platform, record.browser].filter(Boolean).join(' / ') || '未知设备' }}
                  </div>
                </template>
                <template v-else-if="column.key === 'ipAddress'">
                  {{ record.ipAddress || '-' }}
                </template>
                <template v-else-if="column.key === 'failureReason'">
                  <span :class="record.failureReason ? 'failure-text' : 'table-cell-meta'">
                    {{ getLoginHistoryFailureExplanation(record.failureReason) }}
                  </span>
                </template>
              </template>
            </Table>

            <div class="table-footer">
              <Button
                v-if="loginHistoryNextCursor"
                :loading="loginHistoryLoadingMore"
                @click="loadLoginHistory({ append: true })"
              >
                加载更多
              </Button>
            </div>
          </Card>
        </TabPane>

        <TabPane key="mfa" tab="MFA 与恢复码">
          <div class="mfa-layout">
            <Card :bordered="false" class="section-card">
              <div class="panel-caption">
                <div class="panel-caption__title-row">
                  <span class="panel-caption__title">MFA 绑定</span>
                  <Tooltip title="这里展示当前用户自己的 MFA 绑定状态。启用或停用只影响当前账号，不涉及管理员策略配置。">
                    <span class="section-help-dot">?</span>
                  </Tooltip>
                </div>
                <span class="panel-caption__meta">
                  先查看绑定状态，再执行启用、停用或初始化动作。
                </span>
              </div>

              <Table
                :columns="mfaColumns"
                :data-source="mfaBindings"
                :loading="mfaBindingsLoading || loading"
                :pagination="false"
                :scroll="{ x: mfaTableScrollX }"
                class="security-table"
                row-key="bindingId"
                size="middle"
              >
                <template #emptyText>
                  <Empty description="暂无 MFA 绑定数据" />
                </template>
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'type'">
                    <div class="table-cell-title">
                      {{ getMfaBindingLabel(asMfaBinding(record)) }}
                    </div>
                    <div class="table-cell-meta">
                      类型编码：{{ record.type }}
                    </div>
                  </template>
                  <template v-else-if="column.key === 'destination'">
                    <div class="table-cell-title">
                      {{ getMfaDisplayDestination(asMfaBinding(record)) }}
                    </div>
                    <div class="table-cell-meta">
                      {{ getMfaAvailabilityHint(asMfaBinding(record)) }}
                    </div>
                  </template>
                  <template v-else-if="column.key === 'status'">
                    <div class="tag-stack">
                      <Tag :color="getMfaBindingStatusColor(asMfaBinding(record))">
                        {{ record.enabled ? '已启用' : '未启用' }}
                      </Tag>
                      <Tag v-if="!record.available" color="orange">暂不可用</Tag>
                    </div>
                  </template>
                  <template v-else-if="column.key === 'updatedAt'">
                    {{ formatDateTime(record.updatedAt) }}
                  </template>
                  <template v-else-if="column.key === 'action'">
                    <Dropdown
                      v-if="getVisibleTableActionItems(getMfaActionItems(asMfaBinding(record))).length > 0"
                      :trigger="['click']"
                    >
                      <Button aria-label="MFA 操作" shape="circle" size="small" type="text">
                        <IconifyIcon icon="ant-design:more-outlined" />
                      </Button>
                      <template #overlay>
                        <Menu @click="(info) => handleMfaAction(String(info.key) as MfaActionKey, asMfaBinding(record))">
                          <Menu.Item
                            v-for="item in getVisibleTableActionItems(getMfaActionItems(asMfaBinding(record)))"
                            :key="item.key"
                            :danger="item.danger"
                            :data-testid="item.testId"
                            :disabled="item.disabled"
                          >
                            {{ item.label }}
                          </Menu.Item>
                        </Menu>
                      </template>
                    </Dropdown>
                    <span v-else class="tenant-table-action-empty">无可用操作</span>
                  </template>
                </template>
              </Table>
            </Card>
</div>
        </TabPane>
      </Tabs>
    </Card>

    <Modal
      v-model:open="totpSetupModalOpen"
      :footer="null"
      centered
      destroy-on-close
      width="520px"
      @cancel="closeTotpSetupModal"
    >
      <template #title>
        <div class="modal-title-row">
          <span>绑定认证器 App</span>
          <Tooltip title="使用 Google Authenticator 等认证器扫码后，输入一次验证码完成绑定。">
            <span class="section-help-dot">?</span>
          </Tooltip>
        </div>
      </template>

      <Space direction="vertical" class="tool-panel" size="middle">
        <div v-if="totpSetup" class="totp-panel">
          <QRCode :value="totpSetup.qrCodeUrl" />
          <div class="totp-secret">
            Secret：{{ totpSetup.secret }}
          </div>
          <Input
            v-model:value="totpCode"
            :maxlength="64"
            placeholder="请输入认证器验证码"
          />
          <Button
            block
            :loading="totpMutationLoading"
            type="primary"
            @click="activateTotp"
          >
            完成绑定
          </Button>
        </div>
        <Button
          v-else
          block
          :loading="totpMutationLoading"
          type="primary"
          @click="initializeTotp()"
        >
          初始化认证器
        </Button>
      </Space>
    </Modal>

    <Modal
      v-model:open="recoveryCodeModalOpen"
      :footer="null"
      centered
      destroy-on-close
      width="560px"
      @cancel="closeRecoveryCodeModal"
    >
      <template #title>
        <div class="modal-title-row">
          <span>生成恢复码</span>
          <Tooltip title="恢复码用于无法使用常规 MFA 方式时的应急验证；重新生成后旧恢复码会失效。">
            <span class="section-help-dot">?</span>
          </Tooltip>
        </div>
      </template>

      <Space direction="vertical" class="tool-panel" size="middle">
        <Alert
          v-if="recoveryCodes.length > 0"
          message="恢复码只在本次生成后展示，请妥善保存。"
          show-icon
          type="warning"
        />
        <div
          v-if="recoveryCodes.length > 0"
          class="recovery-code-grid"
        >
          <code
            v-for="code in recoveryCodes"
            :key="code"
            class="recovery-code-item"
          >
            {{ code }}
          </code>
        </div>
        <Button
          block
          danger
          :disabled="!totpBinding?.enabled"
          :loading="recoveryCodeLoading"
          @click="generateRecoveryCodesFromModal"
        >
          {{ recoveryCodeBinding?.enabled ? '重新生成恢复码' : '生成恢复码' }}
        </Button>
      </Space>
    </Modal>

    <SecurityStepUpMfaDialog ref="stepUpMfaDialogRef" />
  </div>
</template>

<style scoped>
.security-center-page {
  max-width: 1320px;
  margin: 0 auto;
  --security-border: hsl(var(--border));
  --security-card-bg: hsl(var(--card));
  --security-card-bg-soft: hsl(var(--muted) / 0.55);
  --security-card-bg-strong: hsl(var(--muted) / 0.82);
  --security-card-bg-accent:
    radial-gradient(circle at top right, hsl(var(--primary) / 0.14), transparent 32%),
    linear-gradient(180deg, hsl(var(--card)), hsl(var(--muted) / 0.72));
  --security-title: hsl(var(--foreground));
  --security-text: hsl(var(--foreground) / 0.92);
  --security-muted: hsl(var(--muted-foreground));
  --security-warning: hsl(var(--warning));
}

.summary-card,
.section-card,
.content-surface {
  border: 1px solid var(--security-border);
  background: var(--security-card-bg);
  box-shadow: none;
}

.summary-card__meta {
  margin-top: 12px;
  font-size: 14px;
  color: var(--security-muted);
}

.tab-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: minmax(0, 1fr) 360px;
}

.side-card-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.binding-card-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.login-method-group-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.login-method-group-card {
  padding: 18px;
  border: 1px solid var(--security-border);
  border-radius: 18px;
  background: var(--security-card-bg-accent);
}

.login-method-group-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.login-method-group-card__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--security-title);
}

.login-method-group-card__meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--security-muted);
  line-height: 1.6;
}

.login-method-capability-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-method-capability-item {
  display: grid;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  padding: 14px;
  border-radius: 14px;
  background: var(--security-card-bg-soft);
  border: 1px solid var(--security-border);
}

.login-method-capability-item__body {
  flex: 1 1 auto;
  min-width: 0;
}

.login-method-capability-item__title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.login-method-capability-item__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--security-text);
}

.login-method-capability-item__action {
  align-self: center;
  flex: 0 0 auto;
  inline-size: max-content;
  max-inline-size: max-content;
  min-width: 72px;
  white-space: nowrap;
  width: max-content;
}

.login-method-capability-item__action-cell {
  display: flex;
  justify-content: flex-end;
  justify-self: end;
  min-width: max-content;
}

:deep(.login-method-capability-item__action-cell .ant-btn) {
  flex: 0 0 auto;
  width: max-content !important;
}

.mfa-layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.trusted-device-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.trusted-device-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--security-border);
  border-radius: 18px;
  background: var(--security-card-bg-accent);
}

.trusted-device-card__header,
.trusted-device-card__footer,
.trusted-device-card__meta-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.trusted-device-card__header {
  align-items: flex-start;
}

.trusted-device-card__meta-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.trusted-device-card__meta-item {
  padding: 12px 14px;
  border: 1px solid var(--security-border);
  border-radius: 14px;
  background: var(--security-card-bg-soft);
}

.trusted-device-card__meta-label {
  font-size: 12px;
  color: var(--security-muted);
}

.trusted-device-card__meta-value {
  font-size: 13px;
  font-weight: 500;
  color: var(--security-text);
  text-align: right;
}

.trusted-device-card__footer {
  padding-top: 4px;
}

.section-alert {
  margin-bottom: 12px;
  border-radius: 12px;
}

.panel-caption {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 16px;
}

.panel-caption__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-caption__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--security-title);
}

.panel-caption__meta {
  font-size: 12px;
  color: var(--security-muted);
}

.modal-title-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.security-toolbar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.security-toolbar__filters,
.security-toolbar__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.security-toolbar__filter-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-left: auto;
}

.security-toolbar__filter-actions :deep(.ant-btn) {
  min-width: 76px;
}

.toolbar-control {
  width: 100%;
}

.toolbar-control--compact {
  max-width: 180px;
}

.toolbar-control--wide {
  max-width: 360px;
}

.toolbar-control--range {
  min-width: 300px;
}

.security-table :deep(.ant-table-thead > tr > th) {
  position: relative;
  font-weight: 600;
  color: var(--security-text);
  background: var(--security-card-bg-strong);
  user-select: none;
}

.security-table :deep(.ant-table-tbody > tr > td) {
  vertical-align: top;
}

.security-table :deep(.ant-table),
.security-table :deep(.ant-table-container) {
  background: transparent;
}

.security-center__resizable-title {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 24px;
  padding-right: 12px;
}

.security-center__resizable-title-text {
  min-width: 0;
}

.security-center__column-resizer {
  position: absolute;
  top: -12px;
  right: -10px;
  bottom: -12px;
  z-index: 2;
  width: 14px;
  cursor: col-resize;
}

.security-center__column-resizer::after {
  position: absolute;
  top: 12px;
  bottom: 12px;
  left: 6px;
  width: 1px;
  content: '';
  background: rgb(15 23 42 / 14%);
  transition: background 0.16s ease;
}

.security-center__column-resizer:hover::after {
  background: hsl(var(--primary));
}

:global(body.security-center--resizing-column) {
  cursor: col-resize;
  user-select: none;
}

.table-cell-title {
  font-weight: 500;
  color: var(--security-title);
}

.table-cell-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--security-muted);
  line-height: 1.6;
}

.tag-stack {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.form-stack {
  margin-top: 8px;
}

.security-form-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.security-form-action-button {
  min-width: 128px;
}

.full-width {
  width: 100%;
}

.tool-panel {
  width: 100%;
}

.totp-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.totp-secret {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--security-card-bg-strong);
  color: var(--security-muted);
  font-size: 12px;
  line-height: 1.7;
  word-break: break-all;
}

.recovery-code-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.recovery-code-item {
  display: block;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--security-card-bg-strong);
  font-size: 13px;
  text-align: center;
  color: var(--security-text);
}

.failure-text {
  color: var(--security-warning);
}

.trace-code {
  display: inline-block;
  max-width: 100%;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--security-card-bg-strong);
  font-size: 12px;
  color: var(--security-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.table-footer {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}

.section-help-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--security-border);
  border-radius: 9999px;
  background: var(--security-card-bg-strong);
  color: var(--security-muted);
  font-size: 11px;
  line-height: 1;
  cursor: help;
}

:deep(.summary-card .ant-statistic-title) {
  color: var(--security-muted);
}

:deep(.summary-card .ant-statistic-content),
:deep(.summary-card .ant-statistic-content-value) {
  color: var(--security-title);
}

:deep(.section-card .ant-card-body),
:deep(.content-surface .ant-card-body) {
  background: transparent;
}

:deep(.ant-tabs-nav) {
  margin-bottom: 20px;
}

@media (max-width: 1200px) {
  .tab-grid {
    grid-template-columns: 1fr;
  }

  .binding-card-grid,
  .login-method-group-grid,
  .trusted-device-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .login-method-group-card__header,
  .trusted-device-card__header,
  .trusted-device-card__footer,
  .trusted-device-card__meta-item {
    flex-direction: column;
    align-items: stretch;
  }

  .login-method-capability-item {
    gap: 8px;
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 12px;
  }

  .login-method-capability-item__action {
    min-width: 64px;
    padding-inline: 14px;
  }

  .security-toolbar__actions :deep(.ant-btn) {
    flex: 1 1 auto;
  }

  .security-toolbar__filter-actions {
    margin-left: auto;
    width: max-content;
  }

  .toolbar-control--compact,
  .toolbar-control--wide,
  .toolbar-control--range {
    max-width: none;
    min-width: 0;
  }

  .recovery-code-grid {
    grid-template-columns: 1fr;
  }
}
</style>
