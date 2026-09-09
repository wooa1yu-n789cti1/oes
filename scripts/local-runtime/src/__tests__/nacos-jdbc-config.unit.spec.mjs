import assert from 'node:assert/strict'
import test from 'node:test'
import { NACOS_MYSQL_JDBC_PARAMETERS, nacosContainerEnvironment } from '../docker-driver.mjs'

const EXPECTED_JDBC_PARAMETERS = 'characterEncoding=utf8&connectTimeout=1000&socketTimeout=3000&autoReconnect=true&useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=UTC'

test('Nacos MySQL environment supports caching_sha2_password for shared and run providers', () => {
  assert.equal(NACOS_MYSQL_JDBC_PARAMETERS, EXPECTED_JDBC_PARAMETERS)
  const expectedCommon = {
    MODE: 'standalone',
    PREFER_HOST_MODE: 'ip',
    SPRING_DATASOURCE_PLATFORM: 'mysql',
    MYSQL_SERVICE_PORT: '3306',
    MYSQL_SERVICE_DB_NAME: 'nacos',
    MYSQL_SERVICE_USER: 'nacos',
    MYSQL_SERVICE_DB_PARAM: EXPECTED_JDBC_PARAMETERS,
    NACOS_AUTH_ENABLE: 'true',
    NACOS_AUTH_IDENTITY_KEY: 'serverIdentity',
    JVM_XMS: '256m',
    JVM_XMX: '256m',
    JVM_XMN: '128m'
  }
  assert.deepEqual(nacosContainerEnvironment('shared-mysql', 'shared-password', 'shared-token', 'shared-identity'), {
    ...expectedCommon,
    MYSQL_SERVICE_HOST: 'shared-mysql',
    MYSQL_SERVICE_PASSWORD: 'shared-password',
    NACOS_AUTH_TOKEN: 'shared-token',
    NACOS_AUTH_IDENTITY_VALUE: 'shared-identity'
  })
  assert.deepEqual(nacosContainerEnvironment('run-mysql', 'run-password', 'run-token', 'run-identity'), {
    ...expectedCommon,
    MYSQL_SERVICE_HOST: 'run-mysql',
    MYSQL_SERVICE_PASSWORD: 'run-password',
    NACOS_AUTH_TOKEN: 'run-token',
    NACOS_AUTH_IDENTITY_VALUE: 'run-identity'
  })
})
