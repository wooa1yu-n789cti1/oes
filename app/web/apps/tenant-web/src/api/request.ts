/**
 * 该文件可自行根据业务逻辑进行调整
 */
import type { RequestClientOptions } from '@vben/request';

import { useAppConfig } from '@vben/hooks';
import { preferences } from '@vben/preferences';
import {
  authenticateResponseInterceptor,
  defaultResponseInterceptor,
  errorMessageResponseInterceptor,
  RequestClient,
} from '@vben/request';
import { useAccessStore } from '@vben/stores';

import { message } from 'ant-design-vue';

import {
  resolveLegacyUndefinedNamespace,
  resolveTenantWebNamespace,
} from '#/app-namespace';
import { useAuthStore } from '#/store';

import { recordHttpRequestError } from '../diagnostics/browser-diagnostics';
import { refreshTokenApi } from './core';

const { apiURL } = useAppConfig(import.meta.env, import.meta.env.PROD);

type RefreshTokenStore = {
  refreshToken: null | string;
  setRefreshToken: (token: null | string) => void;
};

type RefreshSessionPayload = {
  accessToken?: string;
  expiresIn?: number;
  refreshToken?: string;
  sessionId?: string;
};

// Converts backend and transitional gateway error payloads into user-facing messages.
export function resolveUserFacingErrorMessage(responseData: any, fallbackMessage: string) {
  const code = `${responseData?.code ?? ''}`;
  const messageText = `${responseData?.message ?? ''}`;
  const messageKey = `${responseData?.messageKey ?? ''}`;
  const originalMessage = `${responseData?.details?.originalMessage ?? ''}`;
  const originalDetails = `${responseData?.details?.originalDetails ?? ''}`;
  const reason = `${responseData?.details?.reason ?? ''}`.trim();
  const combined = `${code} ${messageText} ${messageKey} ${originalMessage} ${originalDetails}`;

  if (/AUTH_INVALID_CREDENTIALS|Invalid credentials|auth\.invalid_credentials/i.test(combined)) {
    return '账号或密码错误，请检查后重试。';
  }

  if (
    /APP_VALIDATION_001|Request validation failed|app\.validation\.failed/i.test(combined) &&
    (/^slug\s+.+\s+is already used by\s+.+$/i.test(reason) ||
      /^slug is already reserved for this site, namespace, and locale$/i.test(reason))
  ) {
    return '该 Slug 已被当前站点、当前 URL 类型和语言版本中的其他内容或历史地址占用，请更换 Slug 后重试。';
  }

  if (/APP_VALIDATION_001|Request validation failed|app\.validation\.failed/i.test(combined)) {
    return '请求数据校验失败，请检查输入后重试。';
  }

  if (/AUTH_LOGIN_TEMPORARILY_LOCKED|auth\.login_temporarily_locked/i.test(combined)) {
    return '登录失败次数过多，请稍后再试。';
  }

  if (/AUTH_MFA_FACTOR_UNAVAILABLE|auth\.mfa_factor_unavailable/i.test(combined)) {
    return '当前账号没有可用于本次登录验证的独立 MFA 因子，请改用密码登录后完成二次验证，或先配置其他 MFA 因子。';
  }

  return responseData?.error ?? responseData?.message ?? fallbackMessage;
}

// Identifies expected auth-expiry recovery failures that should stay silent while the client refreshes or logs out.
export function shouldSuppressAuthRecoveryError(error: any) {
  const responseData = error?.response?.data ?? error ?? {};
  const code = `${responseData?.code ?? ''}`.trim();
  const messageKey = `${responseData?.messageKey ?? ''}`.trim();

  return (
    code === 'APP_AUTH_001' ||
    code === 'APP_AUTH_003' ||
    code === 'APP_AUTH_004' ||
    code === 'AUTH_MFA_FACTOR_UNAVAILABLE' ||
    code === 'AUTH_REFRESH_TOKEN_INVALID' ||
    code === 'AUTH_REFRESH_TOKEN_REPLAY_DETECTED' ||
    messageKey === 'app.auth.unauthenticated' ||
    messageKey === 'app.auth.jwt_missing' ||
    messageKey === 'app.auth.jwt_invalid' ||
    messageKey === 'auth.mfa_factor_unavailable' ||
    messageKey === 'auth.refresh_token_invalid' ||
    messageKey === 'auth.refresh_token_replay_detected'
  );
}

// Identifies calls that intentionally handle failures locally and should not show a global toast.
export function shouldSuppressRequestErrorMessage(error: any) {
  return Boolean(error?.config?.suppressErrorMessage);
}

function createRequestClient(baseURL: string, options?: RequestClientOptions) {
  const client = new RequestClient({
    ...options,
    baseURL,
  });

  client.addResponseInterceptor({
    rejected: (error) => {
      recordHttpRequestError(error);
      return Promise.reject(error);
    },
  });

  /**
   * 重新认证逻辑
   */
  async function doReAuthenticate() {
    const accessStore = useAccessStore();
    const authStore = useAuthStore();
    accessStore.setAccessToken(null);
    if (
      preferences.app.loginExpiredMode === 'modal' &&
      accessStore.isAccessChecked
    ) {
      accessStore.setLoginExpired(true);
    } else {
      await authStore.logout();
    }
  }

  /**
   * 刷新token逻辑
   */
  async function doRefreshToken() {
    const accessStore = useAccessStore();
    const refreshToken = resolveRefreshTokenForRequest(accessStore);
    if (!refreshToken) {
      throw new Error('Missing refresh token');
    }
    const session = await refreshTokenApi(refreshToken);
    const tokenPayload = extractRefreshSessionPayload(session);
    const newToken = tokenPayload?.accessToken;
    if (!newToken) {
      throw new Error('Refresh session response is missing access token');
    }
    accessStore.setAccessToken(newToken);
    accessStore.setRefreshToken(tokenPayload.refreshToken ?? null);
    return newToken;
  }

  function formatToken(token: null | string) {
    return token ? `Bearer ${token}` : null;
  }

  // 请求头处理
  client.addRequestInterceptor({
    fulfilled: async (config) => {
      const accessStore = useAccessStore();

      config.headers.Authorization = formatToken(accessStore.accessToken);
      config.headers['Accept-Language'] = preferences.app.locale;
      return config;
    },
  });

  // 处理返回的响应数据格式
  client.addResponseInterceptor(
    defaultResponseInterceptor({
      codeField: 'code',
      dataField: 'data',
      successCode: (code) => code === 0 || code === 'SYS_000000',
    }),
  );

  // token过期的处理
  client.addResponseInterceptor(
    authenticateResponseInterceptor({
      client,
      doReAuthenticate,
      doRefreshToken,
      enableRefreshToken: preferences.app.enableRefreshToken,
      formatToken,
    }),
  );

  // 通用的错误处理,如果没有进入上面的错误处理逻辑，就会进入这里
  client.addResponseInterceptor(
    errorMessageResponseInterceptor((msg: string, error) => {
      if (shouldSuppressRequestErrorMessage(error)) {
        return;
      }

      if (shouldSuppressAuthRecoveryError(error)) {
        return;
      }

      // 这里可以根据业务进行定制,你可以拿到 error 内的信息进行定制化处理，根据不同的 code 做不同的提示，而不是直接使用 message.error 提示 msg
      // 当前mock接口返回的错误字段是 error 或者 message
      const responseData = error?.response?.data ?? {};
      const errorMessage = resolveUserFacingErrorMessage(responseData, msg);
      // 如果没有错误信息，则会根据状态码进行提示
      message.error(errorMessage || msg);
    }),
  );

  return client;
}

// Extracts the refresh session token pair from either the raw gateway envelope or an already-unwrapped payload.
export function extractRefreshSessionPayload(session: any): RefreshSessionPayload {
  const responseData = session?.data;

  if (responseData?.data?.accessToken) {
    return responseData.data as RefreshSessionPayload;
  }

  return responseData as RefreshSessionPayload;
}

// Resolves the freshest refresh token truth so stale in-memory tabs can reuse the latest persisted session token.
export function resolveRefreshTokenForRequest(accessStore: RefreshTokenStore) {
  const memoryToken = `${accessStore.refreshToken ?? ''}`.trim();
  const persistedToken = readPersistedRefreshToken();

  if (persistedToken && persistedToken !== memoryToken) {
    accessStore.setRefreshToken(persistedToken);
    return persistedToken;
  }

  return memoryToken || null;
}

export function resolveRefreshTokenForRequestWithKey(
  accessStore: RefreshTokenStore,
  storageKeyOverrides: {
    appVersion?: string;
    namespace?: string;
    prod?: boolean;
  }
) {
  const memoryToken = `${accessStore.refreshToken ?? ''}`.trim();
  const persistedToken = readPersistedRefreshToken(storageKeyOverrides);

  if (persistedToken && persistedToken !== memoryToken) {
    accessStore.setRefreshToken(persistedToken);
    return persistedToken;
  }

  return memoryToken || null;
}

// Reads the persisted access store snapshot so refresh can tolerate stale tab memory after token rotation.
function readPersistedRefreshToken(storageKeyOverrides?: {
  appVersion?: string;
  namespace?: string;
  prod?: boolean;
}) {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  for (const storageKey of resolveAccessStoreStorageKeys(storageKeyOverrides)) {
    try {
      const rawState = localStorage.getItem(storageKey);
      if (!rawState) {
        continue;
      }

      const parsedState = JSON.parse(rawState) as { refreshToken?: string };
      const refreshToken = `${parsedState?.refreshToken ?? ''}`.trim();
      if (refreshToken) {
        return refreshToken;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// Resolves the exact persisted access-store key for the current tenant-web runtime instead of scanning unrelated app snapshots.
export function resolveAccessStoreStorageKey(overrides?: {
  appVersion?: string;
  namespace?: string;
  prod?: boolean;
}) {
  const namespace = resolveTenantWebNamespace(overrides);
  if (!namespace) {
    return null;
  }

  return `${namespace}-core-access`;
}

// Returns current and legacy access-store keys in priority order so old sessions can recover after namespace fixes.
export function resolveAccessStoreStorageKeys(overrides?: {
  appVersion?: string;
  namespace?: string;
  prod?: boolean;
}) {
  const currentKey = resolveAccessStoreStorageKey(overrides);
  const legacyNamespace = resolveLegacyUndefinedNamespace(overrides);
  const keys = [
    currentKey,
    legacyNamespace ? `${legacyNamespace}-core-access` : null,
  ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

  return keys;
}

export const requestClient = createRequestClient(apiURL, {
  responseReturn: 'data',
});

export const baseRequestClient = new RequestClient({ baseURL: apiURL });
baseRequestClient.addResponseInterceptor({
  rejected: (error) => {
    recordHttpRequestError(error);
    return Promise.reject(error);
  },
});
