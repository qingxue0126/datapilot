/** Public domain API; do not import domain internals from other modules. */
export { AccountStore } from "./account-store.js";
export { createApiKeyGuard } from "./api-key-guard.js";
export { installAuthRoutes } from "./auth-routes.js";
export { EnvironmentIdentityProvider } from "./identity-provider.js";
export { PermissionService } from "./permission-service.js";
export { ResourcePermissionStore } from "./resource-permission-store.js";
export type { ResourceAccess } from "./resource-permission-store.js";
export { authFailure, sessionToken } from "./session-cookie.js";
