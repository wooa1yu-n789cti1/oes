# auth-service

`auth-service` 的稳定设计真相源已经迁移到：

- [docs/architecture/services/auth-service.md](../../../../docs/architecture/services/auth-service.md)

黑盒接口契约入口：

- [docs/contracts/auth-service/README.md](../../../../docs/contracts/auth-service/README.md)

相关 BFF contract：

- [docs/contracts/api-gateway/auth-bff-login.md](../../../../docs/contracts/api-gateway/auth-bff-login.md)
- [docs/contracts/api-gateway/auth-bff-self-service.md](../../../../docs/contracts/api-gateway/auth-bff-self-service.md)
- [docs/contracts/api-gateway/auth-bff-admin-security.md](../../../../docs/contracts/api-gateway/auth-bff-admin-security.md)

本服务目录不再承载 `auth-service` 的长期设计、任务状态或历史开发流水。后续涉及认证、会话、token、MFA、OTP、登录方式、context switch、self-service / admin-management 或认证域审计边界时，以根目录 architecture 与 contracts 为准。
