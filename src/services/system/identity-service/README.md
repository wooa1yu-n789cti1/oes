# identity-service

`identity-service` 的稳定设计真相源已经迁移到：

- [docs/architecture/services/identity-service.md](../../../../docs/architecture/services/identity-service.md)

黑盒接口契约入口：

- [docs/contracts/identity-service/README.md](../../../../docs/contracts/identity-service/README.md)

相关协同蓝图：

- [tenant-org-and-identity.md](../../../../docs/architecture/collaborations/tenant-org-and-identity.md)
- [party-identity-and-tenant-org.md](../../../../docs/architecture/collaborations/party-identity-and-tenant-org.md)
- [employee-onboarding.md](../../../../docs/architecture/collaborations/employee-onboarding.md)

本服务目录不再承载 `identity-service` 的长期设计、任务状态或历史开发流水。后续涉及 `User`、`UserAccount`、account context、contact asset、machine principal、employee binding、tenant / org 边界或 self-service / admin-management 时，以根目录 architecture、collaborations 与 contracts 为准。
